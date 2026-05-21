import fs from "node:fs";
import path from "node:path";
import { configDir } from "@wenyan-md/core/wrapper";
import { constantTimeEqualHex, generateApiKey, publicKeyPrefix, sha256Hex } from "./security.js";
import { openDatabase as openSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

export interface IssueApiKeyOptions {
    name: string;
    monthlyLimit?: number | null;
    rateLimitPerMinute?: number | null;
}

export interface IssuedApiKey {
    id: number;
    key: string;
    name: string;
    prefix: string;
    monthlyLimit: number | null;
    rateLimitPerMinute: number;
    createdAt: string;
}

export interface ApiKeyRecord {
    id: number;
    name: string;
    keyHash: string;
    prefix: string;
    status: "active" | "revoked";
    monthlyLimit: number | null;
    rateLimitPerMinute: number;
    createdAt: string;
    revokedAt: string | null;
    lastUsedAt: string | null;
}

export interface ApiKeyListItem extends Omit<ApiKeyRecord, "keyHash"> {
    currentMonthRequests: number;
    currentMonthPublishes: number;
}

export type ApiKeyVerification =
    | { ok: true; record: ApiKeyRecord; currentMonthRequests: number; currentMonthPublishes: number }
    | { ok: false; statusCode: 401 | 429; reason: string };

interface ApiKeyRow {
    id: number;
    name: string;
    key_hash: string;
    prefix: string;
    status: "active" | "revoked";
    monthly_limit: number | null;
    rate_limit_per_minute: number;
    created_at: string;
    revoked_at: string | null;
    last_used_at: string | null;
}

interface UsageRow {
    request_count: number;
    publish_count: number;
}

export function getDefaultGatewayDbPath(): string {
    return process.env.HIVE_MP_GATEWAY_DB || path.join(configDir, "gateway.sqlite");
}

export function currentUsageMonth(date = new Date()): string {
    return date.toISOString().slice(0, 7);
}

export class ApiKeyStore {
    private readonly db: SqliteDatabase;
    private closed = false;

    constructor(readonly dbPath: string = getDefaultGatewayDbPath()) {
        if (dbPath !== ":memory:") {
            fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        }
        this.db = openSqliteDatabase(dbPath);
        this.migrate();
    }

    issueKey(options: IssueApiKeyOptions): IssuedApiKey {
        const name = options.name.trim();
        if (!name) throw new Error("API key name is required");

        const apiKey = generateApiKey();
        const now = new Date().toISOString();
        const monthlyLimit = normalizeNullableLimit(options.monthlyLimit);
        const rateLimitPerMinute = normalizePositiveLimit(
            options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
            "rateLimitPerMinute",
        );

        const result = this.db
            .prepare(
                `INSERT INTO api_keys
                    (name, key_hash, prefix, status, monthly_limit, rate_limit_per_minute, created_at)
                 VALUES (?, ?, ?, 'active', ?, ?, ?)`,
            )
            .run(name, sha256Hex(apiKey), publicKeyPrefix(apiKey), monthlyLimit, rateLimitPerMinute, now);

        return {
            id: Number(result.lastInsertRowid),
            key: apiKey,
            name,
            prefix: publicKeyPrefix(apiKey),
            monthlyLimit,
            rateLimitPerMinute,
            createdAt: now,
        };
    }

    verifyKey(apiKey: string | undefined, month = currentUsageMonth()): ApiKeyVerification {
        if (!apiKey) {
            return { ok: false, statusCode: 401, reason: "Missing API key" };
        }

        const keyHash = sha256Hex(apiKey);
        const row = this.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(keyHash) as ApiKeyRow | undefined;
        if (!row || !constantTimeEqualHex(row.key_hash, keyHash)) {
            return { ok: false, statusCode: 401, reason: "Invalid API key" };
        }

        const record = mapApiKeyRow(row);
        if (record.status !== "active") {
            return { ok: false, statusCode: 401, reason: "Revoked API key" };
        }

        const usage = this.getUsage(record.id, month);
        if (record.monthlyLimit !== null && usage.request_count >= record.monthlyLimit) {
            return { ok: false, statusCode: 429, reason: "Monthly API key limit exceeded" };
        }

        return {
            ok: true,
            record,
            currentMonthRequests: usage.request_count,
            currentMonthPublishes: usage.publish_count,
        };
    }

    recordUsage(apiKeyId: number, isPublish: boolean, month = currentUsageMonth()): void {
        this.db
            .prepare(
                `INSERT INTO api_key_usage (api_key_id, month, request_count, publish_count)
                 VALUES (?, ?, 1, ?)
                 ON CONFLICT(api_key_id, month) DO UPDATE SET
                    request_count = request_count + 1,
                    publish_count = publish_count + excluded.publish_count`,
            )
            .run(apiKeyId, month, isPublish ? 1 : 0);

        this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), apiKeyId);
    }

    revokeKey(apiKey: string): boolean {
        return this.revokeByHash(sha256Hex(apiKey));
    }

    revokeKeyById(id: number): boolean {
        const result = this.db
            .prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'")
            .run(new Date().toISOString(), id);
        return result.changes > 0;
    }

    listKeys(month = currentUsageMonth()): ApiKeyListItem[] {
        const rows = this.db.prepare("SELECT * FROM api_keys ORDER BY id ASC").all() as unknown as ApiKeyRow[];
        return rows.map((row) => {
            const usage = this.getUsage(row.id, month);
            const record = mapApiKeyRow(row);
            return {
                id: record.id,
                name: record.name,
                prefix: record.prefix,
                status: record.status,
                monthlyLimit: record.monthlyLimit,
                rateLimitPerMinute: record.rateLimitPerMinute,
                createdAt: record.createdAt,
                revokedAt: record.revokedAt,
                lastUsedAt: record.lastUsedAt,
                currentMonthRequests: usage.request_count,
                currentMonthPublishes: usage.publish_count,
            };
        });
    }

    close(): void {
        if (this.closed) return;
        this.db.close();
        this.closed = true;
    }

    private revokeByHash(keyHash: string): boolean {
        const result = this.db
            .prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE key_hash = ? AND status = 'active'")
            .run(new Date().toISOString(), keyHash);
        return result.changes > 0;
    }

    private getUsage(apiKeyId: number, month: string): UsageRow {
        const row = this.db
            .prepare("SELECT request_count, publish_count FROM api_key_usage WHERE api_key_id = ? AND month = ?")
            .get(apiKeyId, month) as UsageRow | undefined;
        return row || { request_count: 0, publish_count: 0 };
    }

    private migrate(): void {
        this.db.exec(`
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS api_keys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                key_hash TEXT NOT NULL UNIQUE,
                prefix TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
                monthly_limit INTEGER,
                rate_limit_per_minute INTEGER NOT NULL DEFAULT ${DEFAULT_RATE_LIMIT_PER_MINUTE},
                created_at TEXT NOT NULL,
                revoked_at TEXT,
                last_used_at TEXT
            );

            CREATE TABLE IF NOT EXISTS api_key_usage (
                api_key_id INTEGER NOT NULL,
                month TEXT NOT NULL,
                request_count INTEGER NOT NULL DEFAULT 0,
                publish_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (api_key_id, month),
                FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
            );
        `);
    }
}

function mapApiKeyRow(row: ApiKeyRow): ApiKeyRecord {
    return {
        id: row.id,
        name: row.name,
        keyHash: row.key_hash,
        prefix: row.prefix,
        status: row.status,
        monthlyLimit: row.monthly_limit,
        rateLimitPerMinute: row.rate_limit_per_minute,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
        lastUsedAt: row.last_used_at,
    };
}

function normalizeNullableLimit(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    return normalizePositiveLimit(value, "monthlyLimit");
}

function normalizePositiveLimit(value: number, name: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}
