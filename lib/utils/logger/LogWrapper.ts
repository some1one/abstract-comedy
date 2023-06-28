import { IDirectoryOperations, ILogger, LogLevel } from "@some1one/js-utils-extended";
import { ILoggerConfigDict } from "../../types/logger/ILoggerConfigDict";
import { LoggerConfiguration, createConfig, createConfigFromFiles } from "./LoggerConfiguration";
import { Constructor } from "typescript-util-types";
import { DefaultCategory } from "../constants";

/**
 * Base class for a configurable logger.
 */
export class LogWrapper<T extends LoggerConfiguration = LoggerConfiguration> implements ILogger {
    private _configuration?: T;
    public get configuration(): T | undefined {
        return this._configuration;
    }

    private _category: string;
    public get category(): string {
        return this._category;
    }
    public set category(value: string) {
        this._category = value;
    }
    private _level: number;
    public get level(): number {
        return this._level;
    }
    public set level(value: number) {
        this._level = value;
        if (this._configuration) {
            this._configuration.off('configChange', this.updateLogLevel);
        }
    }

    public logger: ILogger = console as ILogger;

    /**
     * @param {LogLevel} [level=LogLevel.Info] Initial logging level.
     * @param {String} [category='Default'] Initial category name.
     * @param {LoggerConfiguration|undefined} [configuration] Logger configuration instance.
     */
    constructor(level: LogLevel = LogLevel.Info, category = 'Default', configuration?: T) {
        this._category = category;
        this._level = level;

        if (configuration) {
            this._configuration = configuration;
            // Try to get log level from configuration provided
            this.level = configuration.getCategoryLevel(this.category) || configuration.getCategoryLevel(DefaultCategory) || this.level;
            this._configuration.on('configChange', this.updateLogLevel.bind(this));
        }
    }

   

    /**
     * Updates log level value with value from config object provided.
     *
     * @param {LoggerConfiguration} configuration Logger configuration instance.
     * @private
     */
    private updateLogLevel(configuration: LoggerConfiguration) {
        this.level = configuration.getCategoryLevel(this.category) || configuration.getCategoryLevel(DefaultCategory) || this.level;
    }

    /**
     * Convenience property for checking if debug log is enabled.
     *
     * @returns {Boolean} True if debug is enabled, false otherwise.
     */
    public get isDebug(): boolean {
        return this.level >= LogLevel.Debug;
    }

    /**
     * Writes debug message to log.
     */
    public debug(message: string): void {
        if (this.level >= LogLevel.Debug) {
            this.logger.debug(message);
        }
    }

    /**
     * Writes info message to log.
     */
    public log(message: string): void {
        if (this.level >= LogLevel.Info) {
            this.logger.info(message);
        }
    }

    /**
     * Writes info message to log.
     */
    public info(message: string): void {
        if (this.level >= LogLevel.Info) {
            this.logger.info(message);
        }
    }

    /**
     * Writes warning message to log.
     */
    public warn(message: string): void {
        if (this.level >= LogLevel.Warn) {
            this.logger.warn(message);
        }
    }

    /**
     * Writes error message to log.
     */
    public error(message: string | Error): void {
        const messageString = 
            (message instanceof Error) 
                ? (message as any).isOperational 
                    ? message.message 
                    : message.stack ?? message.message
                : message;
        this.logger.error(messageString);
    }
}

 /**
  * Creates new logger with configuration from a given data object.
  * Recommended to create a wrapper as a static function of the concrete class.
  * 
  * @param {Constructor<T> & LoggerConfiguration} LoggerConfigImplementation Concrete LoggerConfiguration implementation.
  * @param {ConstructorParameters<T> | undefined} constructorArgs Constructor arguments for implementation class.
  * @param {Object} obj Configuration object.
  * @param {String} [category] Logger category.
  * @param {Boolean} [printConfig] Whether to print logger configuration.
  * @returns {LogWrapper} Logger instance.
  */
export function fromConfigurationObject<T extends Constructor<T> & LoggerConfiguration>(
    LoggerConfigImplementation: T,
    constructorArgs: ConstructorParameters<T> | undefined,
    obj: ILoggerConfigDict = {} as ILoggerConfigDict,
    category = DefaultCategory,
    printConfig = true,
): LogWrapper {
    return new LogWrapper(
        undefined,
        category,
        createConfig(LoggerConfigImplementation, constructorArgs, obj, printConfig ? new LogWrapper() : undefined),
    );
}

/**
 * Creates new logger with configuration from given configuration file (or files). Changes in
 * configuration file(s) are applied immediately on the run.
 * Recommended to create a wrapper as a static function of the concrete class.
 * 
 * @param {Constructor<T> & LoggerConfiguration} LoggerConfigImplementation Concrete LoggerConfiguration implementation.
 * @param {ConstructorParameters<T> | undefined} constructorArgs Constructor arguments for implementation class.
 * @param {String|String[]} paths Path (or paths) to logger configuration file(s).
 * @param {String} [category='Default'] Logger category.
 * @returns {LogWrapper} Logger instance.
 */
export async function fromConfigurationFile<T extends Constructor<T> & LoggerConfiguration>(
    LoggerConfigImplementation: T,
    constructorArgs: ConstructorParameters<T> | undefined,
    fileLoader: IDirectoryOperations,
    paths: string[] = [],
    category = DefaultCategory,
): Promise<LogWrapper> {
    let configuration: LoggerConfiguration | undefined;

    if (!_.isEmpty(paths)) {
        configuration = await createConfigFromFiles(LoggerConfigImplementation, constructorArgs, paths, fileLoader, new LogWrapper());
    }

    return new LogWrapper(undefined, category, configuration);
}

/**
 * Creates and returns a silent logger - a logger that logs nothing.
 *
 * @returns {LogWrapper} Silent logger.
 */
export function silent(): LogWrapper {
    const logger = new LogWrapper();
    logger.level = LogLevel.Silent;
    return logger;
}