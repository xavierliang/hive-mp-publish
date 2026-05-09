import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiKeyStore } from "../src/apiKeyStore.js";
import { sha256Hex } from "../src/security.js";

describe("ApiKeyStore", () => {
    it("issues hashed API keys and verifies active keys", () => {
        const store = new ApiKeyStore(":memory:");
        try {
            const issued = store.issueKey({ name: "tenant-a", rateLimitPerMinute: 10, monthlyLimit: 100 });
            const rows = store.listKeys();

            assert.ok(issued.key.startsWith("hmp_live_"));
            assert.equal(rows.length, 1);
            assert.equal(rows[0].name, "tenant-a");
            assert.equal(JSON.stringify(rows).includes(issued.key), false);

            const verified = store.verifyKey(issued.key);
            assert.equal(verified.ok, true);
            if (verified.ok) {
                assert.equal(verified.record.keyHash, sha256Hex(issued.key));
                assert.equal(verified.record.monthlyLimit, 100);
            }
        } finally {
            store.close();
        }
    });

    it("tracks request and publish usage in SQLite", () => {
        const store = new ApiKeyStore(":memory:");
        try {
            const issued = store.issueKey({ name: "tenant-a" });
            store.recordUsage(issued.id, false, "2026-05");
            store.recordUsage(issued.id, true, "2026-05");

            const rows = store.listKeys("2026-05");
            assert.equal(rows[0].currentMonthRequests, 2);
            assert.equal(rows[0].currentMonthPublishes, 1);
        } finally {
            store.close();
        }
    });

    it("rejects revoked keys and monthly limit overages", () => {
        const store = new ApiKeyStore(":memory:");
        try {
            const revoked = store.issueKey({ name: "revoked" });
            assert.equal(store.revokeKey(revoked.key), true);
            const revokedResult = store.verifyKey(revoked.key);
            assert.equal(revokedResult.ok, false);
            if (!revokedResult.ok) assert.equal(revokedResult.statusCode, 401);

            const limited = store.issueKey({ name: "limited", monthlyLimit: 1 });
            store.recordUsage(limited.id, false);
            const limitedResult = store.verifyKey(limited.key);
            assert.equal(limitedResult.ok, false);
            if (!limitedResult.ok) assert.equal(limitedResult.statusCode, 429);
        } finally {
            store.close();
        }
    });
});
