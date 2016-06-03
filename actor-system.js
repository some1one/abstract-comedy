'use strict';

var common = require('../saymon-common.js');
var Logger = require('../utils/logger.js');
var InMemoryActor = require('./in-memory-actor.js');
var ForkedActor = require('./forked-actor.js');
var ForkedActorParent = require('./forked-actor-parent.js');
var ForkedActorChild = require('./forked-actor-child.js');
var RootActor = require('./root-actor.js');
var ActorStub = require('./actor-stub.js');
var RoundRobinBalancerActor = require('./standard/round-robin-balancer-actor.js');
var childProcess = require('child_process');
var appRootPath = require('app-root-path');
var requireDir = require('require-dir');
var toSource = require('tosource');
var mongodb = require('mongodb');
var P = require('bluebird');
var _ = require('underscore');
var s = require('underscore.string');
var globalRequire = require;
var fs = require('fs');

P.promisifyAll(fs);

/**
 * An actor system.
 */
class ActorSystem {
  constructor(options) {
    options = options || {};

    this.contextBehaviour = options.context || {};

    if (_.isFunction(this.contextBehaviour)) {
      this.context = new this.contextBehaviour();
    }
    else {
      this.context = this.contextBehaviour;
    }

    this.debugPortCounter = 1;
    this.log = options.log || new Logger();
    this.options = _.clone(options);
    
    if (options.test) this.log.setLevel(this.log.levels().Error); // Only output errors in tests.
    
    if (options.debug) this.log.setLevel(this.log.levels().Debug); // Overrides test option.

    var initRet = _.isFunction(this.context.initialize) && this.context.initialize(this._selfProxy());
    var contextPromise = P.resolve().then(() => initRet);

    if (options.root) {
      // Create root with custom behaviour.
      this.rootActorPromise = contextPromise.then(() => this.createActor(options.root, null, { mode: 'in-memory' }));

      if (options.forked) {
        // Create forked root with proper parent.
        this.rootActorPromise = this.rootActorPromise.then(rootActor => {
          return new ForkedActorChild(
            this,
            new ForkedActor(this, null, process, new ActorStub(this, options.forked.id)),
            process,
            rootActor);
        });
      }
    }
    else {
      // Create default root.
      this.rootActorPromise = contextPromise.return(new RootActor(this, { forked: !!options.forked }));
    }
    
    this.rootActorPromise = this.rootActorPromise
      .tap(() => this._loadConfiguration(options.config))
      .tap(actor => actor.initialize());
  }

  /**
   * @returns {*} Context of this system.
   */
  getContext() {
    return this.context;
  }

  /**
   * @returns {*} Logger for this system.
   */
  getLog() {
    return this.log;
  }

  /**
   * @returns {P} Promise which yields root actor for this system.
   */
  rootActor() {
    return this.rootActorPromise;
  }

  /**
   * Creates an actor.
   *
   * @param {Object} Behaviour Actor behaviour.
   * @param {Actor} parent Actor parent.
   * @param {Object} [options] Actor creation options.
   * @returns {*} Promise that yields a created actor.
   */
  createActor(Behaviour, parent, options) {
    options = options || {};

    var actorName = this._actorName(Behaviour);

    // Determine actor configuration.
    if (this.config && actorName) {
      var actorConfig = this.config[s.decapitalize(actorName)];

      options = _.extend({ mode: 'in-memory' }, actorConfig, options);
    }

    // Perform clusterization, if needed.
    if (options.clusterSize > 1) {
      return P.resolve()
        .then(() => {
          var balancerActor = new RoundRobinBalancerActor(this, parent);

          var childPromises = _.times(options.clusterSize, () =>
            balancerActor.createChild(Behaviour, _.extend({}, options, { clusterSize: 1 })));

          return P.all(childPromises).return(balancerActor);
        });
    }

    // Actor creation.
    switch (options.mode || 'in-memory') {
      case 'in-memory':
        return this.createInMemoryActor(Behaviour, parent, actorName);

      case 'forked':
        return this.createForkedActor(Behaviour, parent, actorName);

      default:
        return P.resolve().throw(new Error('Unknown actor mode: ' + options.mode));
    }
  }

  /**
   * Creates a process-local (in-memory) actor.
   * 
   * @param {Object|Function} Behaviour Actor behaviour definition.
   * @param {Actor} parent Actor parent.
   * @param {String} [actorName] Actor name.
   * @returns {*} Promise that yields a newly-created actor.
   */
  createInMemoryActor(Behaviour, parent, actorName) {
    return P.resolve()
      .then(() => {
        var behaviour0 = Behaviour;

        if (_.isFunction(Behaviour)) {
          behaviour0 = new Behaviour();
        }

        return new InMemoryActor(this, parent, behaviour0, actorName);
      });
  }

  /**
   * Creates a forked actor.
   *
   * @param {Object} behaviour Actor behaviour definition.
   * @param {Actor} parent Actor parent.
   * @param {String} [actorName] Actor name.
   * @returns {P} Promise that yields a newly-created actor.
   */
  createForkedActor(behaviour, parent, actorName) {
    return P.resolve()
      .then(() => {
        var psArgs = [];

        if (_.isFunction(behaviour) && behaviour.name) {
          psArgs.push(behaviour.name);
        }

        // Handle debugging: increment debugger port for child process.
        var execArgv = _.map(process.execArgv, arg => {
          var match = arg.match(/^--debug-brk=(\d+)/);

          if (match) {
            var debugPort = parseInt(match[1]);

            return '--debug-brk=' + (debugPort + this.debugPortCounter++);
          }

          return arg;
        });

        var workerProcess = childProcess.fork(__dirname + '/forked-actor-worker.js', psArgs, { execArgv: execArgv });

        return new P((resolve, reject) => {
          var createMsg = {
            type: 'create-actor',
            body: {
              behaviour: this._serializeBehaviour(behaviour),
              context: this._serializeBehaviour(this.contextBehaviour),
              config: this.config,
              test: this.options.test,
              debug: this.options.debug,
              parent: {
                id: parent.getId()
              }
            }
          };
          var actor;

          // Send a message to forked process and await response.
          workerProcess.send(createMsg, (err) => {
            if (err) return reject(err);

            // Wait for response from forked process.
            workerProcess.once('message', (msg) => {
              if (msg.error)
                return reject(new Error(msg.error));

              if (msg.type != 'actor-created' || !msg.body || !msg.body.id)
                return reject(new Error('Unexpected response for "create-actor" message.'));

              actor = new ForkedActorParent(
                this,
                parent,
                workerProcess,
                msg.body.id,
                actorName);
              
              resolve(actor);
            });
          });

          // Handle forked process startup failure.
          workerProcess.once('error', err => {
            if (!actor) reject(new Error('Failed to fork: ' + err));
          });

          // Kill child process if self process is killed.
          process.once('SIGINT', () => {
            this.log.info('Received SIGINT, exiting');

            process.exit(0);
          });
          process.once('SIGTERM', () => {
            this.log.info('Received SIGTERM, exiting');

            process.exit(0);
          });
          process.once('exit', () => {
            if (actor) {
              this.log.debug('Process exiting, killing forked actor ' + actor);

              workerProcess.kill();
            }
          });
        });
      });
  }

  /**
   * Generates a new ID for an actor.
   *
   * @returns {String} New actor ID.
   */
  generateActorId() {
    return new mongodb.ObjectID().toString();
  }

  /**
   * Helper function to correctly import modules in different processes with
   * different directory layout. If a module path ends with /, imports the whole
   * directory.
   *
   * @param {String} modulePath Path of the module to import. If starts with /, a module
   * is searched relative to project directory.
   * @returns {*} Module import result.
   */
  require(modulePath) {
    if (modulePath[0] != '/' && modulePath[0] != '.') {
      return globalRequire(modulePath);
    }
    else if (_.last(modulePath) == '/') {
      return requireDir(appRootPath + modulePath);
    }
    else {
      return globalRequire(appRootPath + modulePath);
    }
  }

  /**
   * Determines actor name based on actor behaviour.
   *
   * @param Behaviour Actor behaviour definition.
   * @returns {String} Actor name or empty string, if actor name is not defined.
   * @private
   */
  _actorName(Behaviour) {
    var behaviour0 = Behaviour;

    if (_.isFunction(Behaviour)) {
      behaviour0 = new Behaviour();
    }

    // Take 'name' field, if present.
    if (behaviour0.name) return _.result(behaviour0, 'name');

    // Use 'getName' getter, if present.
    if (_.isFunction(behaviour0.getName)) return behaviour0.getName();
    
    // Use class name, if present.
    if (behaviour0.constructor && behaviour0.constructor.name) return behaviour0.constructor.name;

    return '';
  }

  /**
   * Serializes a given actor behaviour definition for transferring to other process.
   *
   * @param {Object|Function} behaviour Actor behaviour definition.
   * @returns {String} Serialized actor behaviour.
   * @private
   */
  _serializeBehaviour(behaviour) {
    if (!common.isPlainObject(behaviour)) {
      // Assume from this point that behaviour is a class.
      // Get a base class for behaviour class.
      var base = Object.getPrototypeOf(behaviour);

      if (base && base.name) {
        // Have a user-defined super class. Serialize it as well.
        return this._serializeBehaviour(base) + toSource(behaviour);
      }
    }

    return toSource(behaviour);
  }

  /**
   * Generates a lightweight proxy object for this system to expose only
   * specific methods to a client.
   *
   * @returns {Object} Proxy object.
   * @private
   */
  _selfProxy() {
    return {
      require: this.require.bind(this)
    };
  }

  /**
   * Loads actor configuration.
   *
   * @param {Object|String} config Actor configuration object or file path.
   * @returns {P} Operation promise.
   * @private
   */
  _loadConfiguration(config) {
    if (_.isObject(config)) {
      this.config = config;

      this.options.forked || this.log.info('Using programmatic actor configuration.');

      return P.resolve();
    }

    var defaultPath = appRootPath + '/actors.json';

    if (_.isString(config)) {
      // Config path specified => read from FS.
      return fs.readFileAsync(config)
        .then(data => {
          this.config = JSON.parse(data);

          this.log.info('Using actor configuration file: ' + config);
        })
        .catch(() => {
          this.log.info(
            'Failed to load actor configuration file ' + config + ', will try default path: ' + defaultPath);

          return this._loadConfiguration();
        });
    }

    return fs.readFileAsync(defaultPath)
      .then(data => {
        this.config = JSON.parse(data);

        this.log.info('Using actor configuration file: ' + defaultPath);
      })
      .catch(() => {
        this.log.info(
          'Failed to load actor configuration file ' + defaultPath + ', no actor configuration will be used.');
      });
  }

  /**
   * @returns {ActorSystem} Default actor system.
   */
  static default() {
    if (defaultSystem) {
      defaultSystem = new ActorSystem();
    }
    
    return defaultSystem;
  }
}

// Default actor system instance reference.
var defaultSystem;

module.exports = ActorSystem;