import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getGatewayUrl } from "../src/gatewayClient.js";

describe("gatewayClient", () => {
    it("requires HTTPS for non-local Gateway URLs", () => {
        assert.equal(getGatewayUrl({ server: "https://gateway.example.com", apiKey: "key" } as any), "https://gateway.example.com");
        assert.equal(getGatewayUrl({ server: "http://localhost:3000", apiKey: "key" } as any), "http://localhost:3000");
        assert.throws(
            () => getGatewayUrl({ server: "http://gateway.example.com", apiKey: "key" } as any),
            /must use HTTPS/,
        );
    });
});
