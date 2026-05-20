import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    clearGatewayCredential,
    loadGatewayCredential,
    saveGatewayCredential,
} from "../src/gatewayConfig.js";

describe("gatewayConfig", () => {
    let tempDir: string;
    let previousCredentialPath: string | undefined;

    beforeEach(async () => {
        previousCredentialPath = process.env.HIVE_MP_CREDENTIAL_PATH;
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mp-gateway-config-"));
        process.env.HIVE_MP_CREDENTIAL_PATH = path.join(tempDir, "credential.json");
    });

    afterEach(async () => {
        if (previousCredentialPath === undefined) {
            delete process.env.HIVE_MP_CREDENTIAL_PATH;
        } else {
            process.env.HIVE_MP_CREDENTIAL_PATH = previousCredentialPath;
        }
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("stores Gateway credentials alongside WeChat credentials", async () => {
        await fs.writeFile(
            process.env.HIVE_MP_CREDENTIAL_PATH as string,
            JSON.stringify({ wechat: { wx123: { appSecret: "secret", alias: "prod" } } }),
        );

        await saveGatewayCredential({
            server: "https://mp.resopod.cn",
            apiKey: "hmp_live_test",
        });

        const raw = JSON.parse(await fs.readFile(process.env.HIVE_MP_CREDENTIAL_PATH as string, "utf-8"));
        assert.equal(raw.wechat.wx123.appSecret, "secret");
        assert.deepEqual(await loadGatewayCredential(), {
            server: "https://mp.resopod.cn",
            apiKey: "hmp_live_test",
        });
    });

    it("clears only the Gateway credential", async () => {
        await saveGatewayCredential({
            server: "https://mp.resopod.cn",
            apiKey: "hmp_live_test",
        });

        assert.equal(await clearGatewayCredential(), true);
        assert.equal(await loadGatewayCredential(), null);
        assert.equal(await clearGatewayCredential(), false);
    });
});
