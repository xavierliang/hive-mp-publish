import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFileCompat, parseEnvContentForCompat } from "../src/env.js";

const fixturePath = fileURLToPath(new URL("./fixtures/env-oracle.env", import.meta.url));

const expectedKeys = [
    "HIVE_MP_SMOKE_WHITESPACE_TRIM",
    "HIVE_MP_SMOKE_EXPORT",
    "HIVE_MP_SMOKE_INLINE_COMMENT_NOSPACE",
    "HIVE_MP_SMOKE_INLINE_COMMENT_WITH_SPACE",
    "HIVE_MP_SMOKE_SQUOTE",
    "HIVE_MP_SMOKE_DQUOTE",
    "HIVE_MP_SMOKE_SQUOTE_MULTILINE",
    "HIVE_MP_SMOKE_DQUOTE_MULTILINE",
    "HIVE_MP_SMOKE_HASH_INSIDE_QUOTES",
    "HIVE_MP_SMOKE_NO_OVERRIDE",
];

const absentKeys = ["HIVE_MP_SMOKE_COMMENTED_OUT", "HIVE_MP_SMOKE_BLANK_LINE_PROBE"];

describe("env compatibility parser", () => {
    it("matches Node process.loadEnvFile on the oracle fixture", () => {
        const raw = readFileSync(fixturePath, "utf-8");
        const parsed = parseEnvContentForCompat(raw);
        const savedEnv = saveEnv([...expectedKeys, ...absentKeys]);

        try {
            clearEnv([...expectedKeys, ...absentKeys]);
            process.loadEnvFile(fixturePath);

            assert.deepEqual(Object.keys(parsed).sort(), [...expectedKeys].sort());
            for (const key of expectedKeys) {
                assert.equal(parsed[key], process.env[key], key);
            }
            for (const key of absentKeys) {
                assert.equal(parsed[key], undefined, key);
                assert.equal(process.env[key], undefined, key);
            }
        } finally {
            restoreEnv(savedEnv);
        }
    });

    it("covers expected parsed values explicitly", () => {
        const parsed = loadEnvFileCompat(fixturePath);

        assert.equal(parsed.HIVE_MP_SMOKE_WHITESPACE_TRIM, "trimmed value");
        assert.equal(parsed.HIVE_MP_SMOKE_EXPORT, "exported value");
        assert.equal(parsed.HIVE_MP_SMOKE_INLINE_COMMENT_NOSPACE, "value");
        assert.equal(parsed.HIVE_MP_SMOKE_INLINE_COMMENT_WITH_SPACE, "value");
        assert.equal(parsed.HIVE_MP_SMOKE_SQUOTE, "single quoted value");
        assert.equal(parsed.HIVE_MP_SMOKE_DQUOTE, "double quoted value");
        assert.equal(parsed.HIVE_MP_SMOKE_SQUOTE_MULTILINE, "single\nquoted\nvalue");
        assert.equal(parsed.HIVE_MP_SMOKE_DQUOTE_MULTILINE, "double\nquoted\nvalue");
        assert.equal(parsed.HIVE_MP_SMOKE_HASH_INSIDE_QUOTES, "quoted # hash");
        assert.equal(parsed.HIVE_MP_SMOKE_COMMENTED_OUT, undefined);
        assert.equal(parsed.HIVE_MP_SMOKE_BLANK_LINE_PROBE, undefined);
    });

    it("matches Node's no-override behavior", () => {
        const savedEnv = saveEnv(expectedKeys);

        try {
            clearEnv(expectedKeys);
            process.env.HIVE_MP_SMOKE_NO_OVERRIDE = "already-set";
            process.loadEnvFile(fixturePath);

            assert.equal(process.env.HIVE_MP_SMOKE_NO_OVERRIDE, "already-set");
        } finally {
            restoreEnv(savedEnv);
        }
    });

    it("keeps loadEnvFileCompat free of process.env side effects", () => {
        const savedEnv = saveEnv(expectedKeys);

        try {
            clearEnv(expectedKeys);
            loadEnvFileCompat(fixturePath);

            for (const key of expectedKeys) {
                assert.equal(process.env[key], undefined, key);
            }
        } finally {
            restoreEnv(savedEnv);
        }
    });

    it("throws an ENOENT-shaped error for a missing file", () => {
        const missingPath = path.join(path.dirname(fixturePath), "missing.env");

        assert.throws(
            () => loadEnvFileCompat(missingPath),
            (error) => {
                const err = error as NodeJS.ErrnoException;
                assert.equal(err.code, "ENOENT");
                assert.match(err.message, /missing\.env/);
                assert.match(err.message, new RegExp(escapeRegExp(missingPath)));
                return true;
            },
        );
    });
});

function saveEnv(keys: string[]): Map<string, string | undefined> {
    return new Map(keys.map((key) => [key, process.env[key]]));
}

function clearEnv(keys: string[]): void {
    for (const key of keys) {
        delete process.env[key];
    }
}

function restoreEnv(savedEnv: Map<string, string | undefined>): void {
    for (const [key, value] of savedEnv) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
