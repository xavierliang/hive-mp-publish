import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { installInMemoryAccessTokenCache } from "../src/tokenCache.js";

describe("installInMemoryAccessTokenCache", () => {
    it("caches access tokens in memory by appId", async () => {
        let tokenNumber = 0;
        const publisher = {
            tokenStore: { persisted: true },
            fetchAccessToken: mock.fn(async () => {
                tokenNumber += 1;
                return { access_token: `token-${tokenNumber}`, expires_in: 7200 };
            }),
        };

        const cache = installInMemoryAccessTokenCache(publisher, 7000);
        const first = await publisher.getAccessTokenWithCache("appid-1", "secret-a");
        const second = await publisher.getAccessTokenWithCache("appid-1", "secret-a");
        const third = await publisher.getAccessTokenWithCache("appid-2", "secret-b");

        assert.equal(first, "token-1");
        assert.equal(second, "token-1");
        assert.equal(third, "token-2");
        assert.equal(publisher.fetchAccessToken.mock.callCount(), 2);
        assert.equal(publisher.tokenStore, undefined);
        assert.equal(cache.size(), 2);
    });
});
