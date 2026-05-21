import { createRequire } from "node:module";
import { isBun } from "./runtime.js";

export type SqliteRow = Record<string, unknown>;

export type SqliteRunResult = {
    changes: number;
    lastInsertRowid: number | bigint;
};

export type SqliteStatement = {
    run(...params: unknown[]): SqliteRunResult;
    get(...params: unknown[]): SqliteRow | undefined;
    all(...params: unknown[]): SqliteRow[];
};

export type SqliteDatabase = {
    prepare(sql: string): SqliteStatement;
    exec(sql: string): void;
    close(): void;
};

type BackendStatement = {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown;
};

type BackendDatabase = {
    prepare(sql: string): BackendStatement;
    exec(sql: string): unknown;
    close(): unknown;
};

type SqliteBackendModule = {
    Database?: new (path: string) => BackendDatabase;
    DatabaseSync?: new (path: string) => BackendDatabase;
};

const runtimeRequire = createRequire(import.meta.url);

export function openDatabase(path: string): SqliteDatabase {
    const sqliteModule = runtimeRequire(isBun ? "bun:sqlite" : "node:sqlite") as SqliteBackendModule;
    const DatabaseCtor = isBun ? sqliteModule.Database : sqliteModule.DatabaseSync;

    if (!DatabaseCtor) {
        throw new Error(`SQLite backend is unavailable for ${isBun ? "Bun" : "Node"}`);
    }

    return wrapDatabase(new DatabaseCtor(path));
}

function wrapDatabase(database: BackendDatabase): SqliteDatabase {
    return {
        prepare(sql: string): SqliteStatement {
            return wrapStatement(database.prepare(sql));
        },
        exec(sql: string): void {
            database.exec(sql);
        },
        close(): void {
            database.close();
        },
    };
}

function wrapStatement(statement: BackendStatement): SqliteStatement {
    return {
        run(...params: unknown[]): SqliteRunResult {
            return normalizeRunResult(statement.run(...params));
        },
        get(...params: unknown[]): SqliteRow | undefined {
            return normalizeRow(statement.get(...params));
        },
        all(...params: unknown[]): SqliteRow[] {
            const rows = statement.all(...params);
            if (!Array.isArray(rows)) {
                return [];
            }
            return rows.map((row) => normalizeRow(row) ?? {});
        },
    };
}

function normalizeRow(row: unknown): SqliteRow | undefined {
    if (row === undefined || row === null) {
        return undefined;
    }
    return Object.fromEntries(Object.entries(row as Record<string, unknown>));
}

function normalizeRunResult(result: unknown): SqliteRunResult {
    const runResult = result as {
        changes?: unknown;
        lastInsertRowid?: unknown;
        lastInsertRowID?: unknown;
    };
    const lastInsertRowid = runResult.lastInsertRowid ?? runResult.lastInsertRowID ?? 0;

    return {
        changes: Number(runResult.changes ?? 0),
        lastInsertRowid: typeof lastInsertRowid === "bigint" ? lastInsertRowid : Number(lastInsertRowid),
    };
}
