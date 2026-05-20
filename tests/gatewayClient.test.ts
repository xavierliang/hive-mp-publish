import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getGatewayUrl, resolveGatewayConnection } from "../src/gatewayClient.js";
import { DEFAULT_GATEWAY_SERVER, saveGatewayCredential } from "../src/gatewayConfig.js";

describe("gatewayClient", () => {
    let tempDir: string;
    let previousCredentialPath: string | undefined;
    let previousGatewayUrl: string | undefined;
    let previousApiKey: string | undefined;

    beforeEach(async () => {
        previousCredentialPath = process.env.HIVE_MP_CREDENTIAL_PATH;
        previousGatewayUrl = process.env.HIVE_MP_GATEWAY_URL;
        previousApiKey = process.env.HIVE_MP_API_KEY;
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mp-gateway-client-"));
        process.env.HIVE_MP_CREDENTIAL_PATH = path.join(tempDir, "credential.json");
        delete process.env.HIVE_MP_GATEWAY_URL;
        delete process.env.HIVE_MP_API_KEY;
    });

    afterEach(async () => {
        restoreEnv("HIVE_MP_CREDENTIAL_PATH", previousCredentialPath);
        restoreEnv("HIVE_MP_GATEWAY_URL", previousGatewayUrl);
        restoreEnv("HIVE_MP_API_KEY", previousApiKey);
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("requires HTTPS for non-local Gateway URLs", () => {
        assert.equal(getGatewayUrl({ server: "https://gateway.example.com", apiKey: "key" } as any), "https://gateway.example.com");
        assert.equal(getGatewayUrl({ server: "http://localhost:3000", apiKey: "key" } as any), "http://localhost:3000");
        assert.throws(
            () => getGatewayUrl({ server: "http://gateway.example.com", apiKey: "key" } as any),
            /must use HTTPS/,
        );
    });

    it("uses saved Gateway config when publish options omit server and API key", async () => {
        await saveGatewayCredential({
            server: "https://saved.example.com",
            apiKey: "saved-key",
        });

        assert.deepEqual(await resolveGatewayConnection({} as any), {
            server: "https://saved.example.com",
            apiKey: "saved-key",
        });
    });

    it("uses default Gateway server with an environment API key", async () => {
        process.env.HIVE_MP_API_KEY = "env-key";

        assert.deepEqual(await resolveGatewayConnection({} as any), {
            server: DEFAULT_GATEWAY_SERVER,
            apiKey: "env-key",
        });
    });
});

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}
