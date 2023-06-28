import type { AsRecord } from "typescript-util-types";
import type { LogLevel, DataProvider } from "@some1one/js-utils-extended"

interface a extends Record<string, unknown> {
    categories: Record<string, LogLevel>;
    fileLoader: DataProvider;
}

export type ILoggerConfigDict = AsRecord<a>;