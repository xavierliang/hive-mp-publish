import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/sqlite.js";

describe("sqlite adapter", () => {
    it("opens an in-memory database and normalizes statement results", () => {
        const db = openDatabase(":memory:");
        try {
            db.exec(`
                PRAGMA foreign_keys = ON;
                CREATE TABLE records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    snake_case_value TEXT NOT NULL UNIQUE,
                    count INTEGER NOT NULL DEFAULT 0
                );
            `);

            const insert = db
                .prepare("INSERT INTO records (snake_case_value, count) VALUES (?, ?)")
                .run("alpha", 1);

            assert.equal(insert.changes, 1);
            assert.equal(["number", "bigint"].includes(typeof insert.lastInsertRowid), true);
            assert.equal(Number(insert.lastInsertRowid) > 0, true);

            const updated = db
                .prepare(
                    `INSERT INTO records (snake_case_value, count)
                     VALUES (?, ?)
                     ON CONFLICT(snake_case_value) DO UPDATE SET count = records.count + excluded.count`,
                )
                .run("alpha", 2);
            assert.equal(updated.changes, 1);

            const row = db.prepare("SELECT id, snake_case_value, count FROM records WHERE snake_case_value = ?").get(
                "alpha",
            );
            assert.deepEqual(row, {
                id: 1,
                snake_case_value: "alpha",
                count: 3,
            });

            const rows = db.prepare("SELECT snake_case_value FROM records ORDER BY id ASC").all();
            assert.deepEqual(rows, [{ snake_case_value: "alpha" }]);
        } finally {
            db.close();
        }
    });
});
