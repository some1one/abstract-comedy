import _ from "lodash";
import { ILoggerConfigDict } from "../../types/logger/ILoggerConfigDict";
import { AbstractEventEmitter, ILogger, IDirectoryOperations, deepExtend, LogLevel } from "@some1one/js-utils-extended";
import { Constructor, PropertyNames, GetterNames, RecordProperties, GetterFunctions } from "typescript-util-types";

export type LoggerConfigurationEvent = typeof LoggerConfiguration.Events[keyof typeof LoggerConfiguration.Events];

/**
 * Configuration object wrapped into event emitter.
 * Extend this class to have use a concrete event emitter implementation. (may require a mixin)
 *
 * @class LoggerConfiguration
 */
export abstract class LoggerConfiguration extends AbstractEventEmitter {
    public static readonly Events = Object.freeze({
        CONFIG_CHANGE: 'configChange',
    });

    private _current: ILoggerConfigDict;
    /**
     * Get or update current configuration object. Setting will emit a 'configChange' event.
     * @type {ILoggerConfigDict}
     *
     */
    public get current(): ILoggerConfigDict {
        return this._current;
    }
    public set current(value: ILoggerConfigDict) {
        this._current = value;

        // Set default configuration if data is invalid.
        if (!this._current || typeof this._current.categories !== 'object') {
            this._current = _.extend(this._current, { categories: { Default: LogLevel.Info } });
        }
        
        this.emit(LoggerConfiguration.Events.CONFIG_CHANGE, this);
    }

    /**
     * @param {ILoggerConfigDict} configuration Configuration object.
     */
    constructor(configuration: ILoggerConfigDict) {
        super(200);
        this.current = configuration;
    }

    /**
     * Gets log level for the specified logger category.
     *
     * @param {String} category Logger category name.
     * @returns {String} Log level name.
     */
    public getCategoryLevel(category: string): LogLevel {
        return this.current.categories[category] || this.current.categories.Default;
    }

    public toString(): string {
        return this.current && JSON.stringify(this.current, null, 2) || '';
    }
}

/**
 * Creates LoggerConfiguration instance with configuration specified by a given
 * data object. Recommended to create a wrapper as a static function of the concrete class.
 * @param {Constructor<T> & LoggerConfiguration} LoggerConfigImplementation Concrete LoggerConfiguration implementation.
 * @param {ConstructorParameters<T> | undefined} constructorArgs Constructor arguments for implementation class.
 * @param {Object} configuration Data object with logger configuration.
 * @param {ILogger} [log] Logger.
 * @returns {LoggerConfiguration} Logger configuration instance.
 */
export function createConfig<T extends Constructor<T> & LoggerConfiguration>(
    LoggerConfigImplementation: T,
    constructorArgs: ConstructorParameters<T> | undefined,
    configuration: ILoggerConfigDict,
    log?: ILogger
): LoggerConfiguration {
    const loggerConfiguration = new LoggerConfigImplementation(...(constructorArgs ? constructorArgs : [] as any));
    loggerConfiguration.current = configuration;
    log && log.info('Logger configuration:' + loggerConfiguration.toString());

    return loggerConfiguration;
}

/**
 * Creates LoggerConfiguration instance with configuration taken from given files.
 * Recommended to create a wrapper as a static function of the concrete class.
 * @param {Constructor<T> & LoggerConfiguration} LoggerConfigImplementation Concrete LoggerConfiguration implementation.
 * @param {ConstructorParameters<T>} constructorArgs Constructor arguments for implementation class.
 * @param {String[]} paths Paths to logger configuration files.
 * @param {ILogger} log Temporary logger to output errors.
 * @returns {Promise<LoggerConfiguration>} Logger configuration instance.
 */
export async function createConfigFromFiles<T extends Constructor<T> & LoggerConfiguration>(
    LoggerConfigImplementation: T,
    constructorArgs: ConstructorParameters<T> | undefined,
    paths: string[],
    fileLoader: IDirectoryOperations,
    log: ILogger,
): Promise<LoggerConfiguration> {
    log.info('Reading logger configuration from file(s):' + paths);
    
    let data = {} as Record<PropertyNames<T> | GetterNames<T>, RecordProperties<T> | GetterFunctions<T>>;
    for (const path of paths) {
        try {
            const loggerConf = await fileLoader.readFile(path);
            if(!_.isString(loggerConf)) throw new Error('Invalid logger configuration, is file reader returning a string?');
            data = deepExtend(JSON.parse(loggerConf), data);
        } catch (err: any) {
            log.warn('Unable to read logger configuration, path=' + path + ', error=' + err.message);
        }
    }

    const configuration = new LoggerConfigImplementation(...(constructorArgs ? constructorArgs : [] as any));
    configuration.current = data as ILoggerConfigDict;

    paths.forEach((path) => {
        const cancel = fileLoader.watch(path, async () => {
            log.info('Logger configuration file changed, re-reading configuration...');

            const configs = await Promise.all(paths.map(async (path0) => {
                try {
                    const loggerConf = await fileLoader.readFile(path0);
                    if(!_.isString(loggerConf)) throw new Error('Invalid logger configuration, is file reader returning a string?');
                    return JSON.parse(loggerConf);
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } catch (err: any) {
                    log.warn(
                        `Failed to parse configuration from file (will ignore), path=${path0}, error=${err.message}`,
                    );
                    cancel();
                }
            }));

            const data = _.compact(configs).reduce((memo, cur) => deepExtend(cur, memo), {});

            configuration.current = data;

            log.info('Updated logger configuration:' + configuration.toString());
        });
    });

    log.info('Resulting logger configuration:' + configuration.toString());

    return configuration;
}