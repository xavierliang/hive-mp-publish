import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import {
    ClientPublishOptions,
    credentialStore,
    prepareRenderContext,
    StyledContent,
} from "@wenyan-md/core/wrapper";
import { getInputContent } from "./utils.js";

export interface GatewayPublishOptions extends ClientPublishOptions {
    appSecret?: string;
    allowInsecureHttp?: boolean;
}

interface WechatCredential {
    appId: string;
    appSecret: string;
}

export async function renderAndPublishToGateway(
    inputContent: string | undefined,
    options: GatewayPublishOptions,
): Promise<string> {
    const serverUrl = getGatewayUrl(options);
    const headers = getGatewayHeaders(options);
    const credential = await resolveWechatCredential(options);

    await healthCheck(serverUrl);
    await verifyAuth(serverUrl, headers);

    const { gzhContent, absoluteDirPath } = await prepareRenderContext(inputContent, options, getInputContent);
    if (!gzhContent.title) throw new Error("未能找到文章标题");

    if (gzhContent.image_list && gzhContent.image_list.length > 0) {
        gzhContent.image_list = await uploadImageList(serverUrl, headers, gzhContent.image_list, absoluteDirPath);
    } else {
        gzhContent.content = await uploadLocalImages(gzhContent.content, serverUrl, headers, absoluteDirPath);
    }
    gzhContent.cover = await uploadCover(serverUrl, headers, gzhContent.cover, absoluteDirPath);

    const fileId = await uploadStyledContent(gzhContent, serverUrl, headers);
    return requestGatewayPublish(fileId, serverUrl, headers, options, credential);
}

export async function resolveWechatCredential(options: GatewayPublishOptions): Promise<WechatCredential> {
    if (options.appId && options.appSecret) {
        return { appId: options.appId, appSecret: options.appSecret };
    }

    const envAppId = process.env.WECHAT_APP_ID;
    const envAppSecret = process.env.WECHAT_APP_SECRET;
    if (envAppId && envAppSecret && (!options.appId || options.appId === envAppId)) {
        return { appId: envAppId, appSecret: envAppSecret };
    }

    if (!options.appId) {
        throw new Error("Server mode requires --app-id, or WECHAT_APP_ID plus WECHAT_APP_SECRET.");
    }

    const credential = await credentialStore.getWechatCredential(options.appId);
    if (credential?.appId && credential?.appSecret) {
        return { appId: credential.appId, appSecret: credential.appSecret };
    }

    throw new Error(`未能找到 AppID 或别名 "${options.appId}" 的本地公众号凭据。`);
}

export function getGatewayUrl(options: GatewayPublishOptions): string {
    if (!options.server) throw new Error("Server mode requires --server.");

    const url = new URL(options.server);
    const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !isLocal && !options.allowInsecureHttp) {
        throw new Error("Remote Gateway URL must use HTTPS. Use --allow-insecure-http only for controlled testing.");
    }

    return url.toString().replace(/\/$/, "");
}

function getGatewayHeaders(options: GatewayPublishOptions): Record<string, string> {
    if (!options.apiKey) throw new Error("Server mode requires --api-key.");
    const headers: Record<string, string> = {
        "x-api-key": options.apiKey,
    };
    if (options.clientVersion) {
        headers["x-client-version"] = options.clientVersion;
    }
    return headers;
}

async function healthCheck(serverUrl: string): Promise<void> {
    const healthRes = await fetch(`${serverUrl}/health`);
    if (!healthRes.ok) {
        throw new Error(`Gateway health check failed: ${healthRes.status} ${healthRes.statusText}`);
    }

    const healthData = (await healthRes.json()) as { status?: string; service?: string };
    if (healthData.status !== "ok") {
        throw new Error("Invalid Gateway health response.");
    }
}

async function verifyAuth(serverUrl: string, headers: Record<string, string>): Promise<void> {
    const verifyRes = await fetch(`${serverUrl}/verify`, { headers });
    if (verifyRes.status === 401) {
        throw new Error("鉴权失败 (401)：Gateway 拒绝访问，请检查 --api-key。");
    }
    if (verifyRes.status === 429) {
        throw new Error("鉴权失败 (429)：API key 已触发限流或月度额度。");
    }
    if (!verifyRes.ok) {
        throw new Error(`Gateway verify failed: ${verifyRes.status} ${verifyRes.statusText}`);
    }
}

async function uploadStyledContent(
    gzhContent: StyledContent,
    serverUrl: string,
    headers: Record<string, string>,
): Promise<string> {
    const uploadData = await uploadBuffer(
        serverUrl,
        headers,
        Buffer.from(JSON.stringify(gzhContent), "utf-8"),
        "publish_target.json",
        "application/json",
    );
    return uploadData.data.fileId;
}

async function requestGatewayPublish(
    fileId: string,
    serverUrl: string,
    headers: Record<string, string>,
    options: GatewayPublishOptions,
    credential: WechatCredential,
): Promise<string> {
    const { theme, customTheme, highlight, macStyle, footnote } = options;
    const publishRes = await fetch(`${serverUrl}/publish`, {
        method: "POST",
        headers: {
            ...headers,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            fileId,
            theme,
            highlight,
            customTheme,
            macStyle,
            footnote,
            appId: credential.appId,
            appSecret: credential.appSecret,
        }),
    });

    const publishData = (await publishRes.json()) as { code?: number; desc?: string; media_id?: string };
    if (!publishRes.ok || publishData.code === -1 || !publishData.media_id) {
        throw new Error(`Remote Publish Failed: ${publishData.desc || publishRes.statusText}`);
    }
    return publishData.media_id;
}

async function uploadLocalImages(
    content: string,
    serverUrl: string,
    headers: Record<string, string>,
    relativePath?: string,
): Promise<string> {
    if (!content.includes("<img")) return content;

    const dom = new JSDOM(content);
    const document = dom.window.document;
    const images = Array.from(document.querySelectorAll("img")) as HTMLImageElement[];
    await Promise.all(
        images.map(async (element) => {
            const src = element.getAttribute("src");
            if (!src || !needUpload(src)) return;
            const uploaded = await uploadLocalAsset(src, serverUrl, headers, relativePath);
            if (uploaded) element.setAttribute("src", uploaded);
        }),
    );

    return document.body.innerHTML;
}

async function uploadImageList(
    serverUrl: string,
    headers: Record<string, string>,
    imageList: string[],
    relativePath?: string,
): Promise<string[]> {
    return Promise.all(
        imageList.map(async (imageUrl) => {
            if (!needUpload(imageUrl)) return imageUrl;
            return (await uploadLocalAsset(imageUrl, serverUrl, headers, relativePath)) || imageUrl;
        }),
    );
}

async function uploadCover(
    serverUrl: string,
    headers: Record<string, string>,
    cover?: string,
    relativePath?: string,
): Promise<string | undefined> {
    if (!cover || !needUpload(cover)) return cover;
    return (await uploadLocalAsset(cover, serverUrl, headers, relativePath)) || cover;
}

async function uploadLocalAsset(
    assetUrl: string,
    serverUrl: string,
    headers: Record<string, string>,
    relativePath?: string,
): Promise<string | null> {
    const assetPath = resolveLocalAssetPath(assetUrl, relativePath);
    const buffer = await fs.readFile(assetPath);
    const filename = path.basename(assetPath);
    const uploadData = await uploadBuffer(serverUrl, headers, buffer, filename, getMimeType(filename));
    return `asset://${uploadData.data.fileId}`;
}

async function uploadBuffer(
    serverUrl: string,
    headers: Record<string, string>,
    buffer: Buffer,
    filename: string,
    mimeType: string,
): Promise<{ success: true; data: { fileId: string } }> {
    const formData = new FormData();
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    formData.set("file", new Blob([arrayBuffer], { type: mimeType }), filename);

    const uploadRes = await fetch(`${serverUrl}/upload`, {
        method: "POST",
        headers,
        body: formData,
    });

    const uploadData = (await uploadRes.json()) as {
        success?: boolean;
        data?: { fileId?: string };
        desc?: string;
        error?: string;
    };

    if (!uploadRes.ok || !uploadData.success || !uploadData.data?.fileId) {
        throw new Error(`Upload failed: ${uploadData.desc || uploadData.error || uploadRes.statusText}`);
    }

    return uploadData as { success: true; data: { fileId: string } };
}

function needUpload(url: string): boolean {
    return !/^(https?:\/\/|data:|asset:\/\/)/i.test(url);
}

function resolveLocalAssetPath(assetUrl: string, relativePath?: string): string {
    if (path.isAbsolute(assetUrl)) return assetUrl;
    return path.resolve(relativePath || process.cwd(), assetUrl);
}

function getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".md": "text/markdown",
        ".css": "text/css",
        ".json": "application/json",
    };
    return mimeTypes[ext] || "application/octet-stream";
}
