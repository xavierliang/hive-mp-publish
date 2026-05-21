import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { renderAndPublishToGateway } from "../src/gatewayClient.js";

const apiKey = "hmp_live_TESTKEY_TESTKEY_TESTKEY";
const appSecret = "smoke_app_secret";
const leakedMessage = `rejected ${apiKey} and ${appSecret}`;

const markdown = `---
title: Gateway Redaction Probe
---

Body`;

describe("gatewayClient Gateway error redaction", () => {
    for (const field of ["desc", "message"] as const) {
        it(`redacts ${field} from publish errors`, async () => {
            const error = await captureGatewayError({
                uploadStatus: 200,
                uploadBody: { success: true, data: { fileId: "publish-target" } },
                publishStatus: 500,
                publishBody: { code: -1, [field]: leakedMessage },
            });

            assertRedacted(error.message);
            assert.match(error.message, /Remote Publish Failed/);
        });
    }

    it("redacts error from upload errors", async () => {
        const error = await captureGatewayError({
            uploadStatus: 400,
            uploadBody: { error: leakedMessage },
            publishStatus: 200,
            publishBody: { media_id: "unused" },
        });

        assertRedacted(error.message);
        assert.match(error.message, /Upload failed/);
    });
});

async function captureGatewayError(config: GatewayConfig): Promise<Error> {
    const previousCredentialPath = process.env.HIVE_MP_CREDENTIAL_PATH;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mp-gateway-redaction-"));
    process.env.HIVE_MP_CREDENTIAL_PATH = path.join(tempDir, "credential.json");

    try {
        return await withGateway(config, async (serverUrl) => {
            try {
                await renderAndPublishToGateway(markdown, {
                    server: serverUrl,
                    apiKey,
                    appId: "smoke_app_id",
                    appSecret,
                    theme: "default",
                    highlight: "solarized-light",
                    macStyle: true,
                    footnote: true,
                    allowInsecureHttp: true,
                });
            } catch (error) {
                assert.ok(error instanceof Error);
                return error;
            }

            throw new Error("Expected Gateway publish to fail");
        });
    } finally {
        if (previousCredentialPath === undefined) {
            delete process.env.HIVE_MP_CREDENTIAL_PATH;
        } else {
            process.env.HIVE_MP_CREDENTIAL_PATH = previousCredentialPath;
        }
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

function assertRedacted(message: string): void {
    assert.doesNotMatch(message, new RegExp(escapeRegExp(apiKey)));
    assert.doesNotMatch(message, new RegExp(escapeRegExp(appSecret)));
    assert.match(message, /\[REDACTED_API_KEY\]/);
    assert.match(message, /\[REDACTED\]/);
}

type GatewayConfig = {
    uploadStatus: number;
    uploadBody: Record<string, unknown>;
    publishStatus: number;
    publishBody: Record<string, unknown>;
};

async function withGateway<T>(config: GatewayConfig, run: (serverUrl: string) => Promise<T>): Promise<T> {
    const server = createServer((req, res) => handleRequest(req, res, config));
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
        return await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await close(server);
    }
}

function handleRequest(req: IncomingMessage, res: ServerResponse, config: GatewayConfig): void {
    req.resume();

    if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
    }

    if (req.method === "GET" && req.url === "/verify") {
        sendJson(res, 200, { success: true, key: { id: 1, name: "smoke" } });
        return;
    }

    if (req.method === "POST" && req.url === "/upload") {
        sendJson(res, config.uploadStatus, config.uploadBody);
        return;
    }

    if (req.method === "POST" && req.url === "/publish") {
        sendJson(res, config.publishStatus, config.publishBody);
        return;
    }

    sendJson(res, 404, { desc: "not found" });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
