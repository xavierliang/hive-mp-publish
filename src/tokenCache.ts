import { wechatPublisher } from "@wenyan-md/core/wrapper";

export const ACCESS_TOKEN_TTL_SECONDS = 7000;

interface TokenCacheEntry {
    token: string;
    expiresAt: number;
}

interface WechatPublisherLike {
    fetchAccessToken: (appId: string, appSecret: string) => Promise<{ access_token: string; expires_in?: number }>;
    getAccessTokenWithCache?: (appId: string, appSecret: string) => Promise<string>;
    tokenStore?: unknown;
}

export interface InstalledTokenCache {
    clear: () => void;
    size: () => number;
}

export function installInMemoryAccessTokenCache(
    publisher: WechatPublisherLike = wechatPublisher as unknown as WechatPublisherLike,
    ttlSeconds = ACCESS_TOKEN_TTL_SECONDS,
): InstalledTokenCache {
    const cache = new Map<string, TokenCacheEntry>();
    const fetchAccessToken = publisher.fetchAccessToken.bind(publisher);

    publisher.tokenStore = undefined;
    publisher.getAccessTokenWithCache = async (appId: string, appSecret: string) => {
        const now = Date.now();
        const cached = cache.get(appId);
        if (cached && cached.expiresAt > now) {
            return cached.token;
        }

        const result = await fetchAccessToken(appId, appSecret);
        const upstreamTtl = Number.isFinite(result.expires_in) ? Number(result.expires_in) : ttlSeconds;
        const ttlMs = Math.max(1, Math.min(upstreamTtl, ttlSeconds)) * 1000;
        cache.set(appId, {
            token: result.access_token,
            expiresAt: now + ttlMs,
        });
        return result.access_token;
    };

    return {
        clear: () => cache.clear(),
        size: () => cache.size,
    };
}
