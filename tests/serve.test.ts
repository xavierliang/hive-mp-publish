import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { serveCommand, UPLOAD_DIR } from "../src/commands/serve.js";
import { ApiKeyStore } from "../src/apiKeyStore.js";

describe("serve.ts", () => {
    const testPort = 3999;
    let serverProcess: Promise<void> | undefined;
    const baseUrl = `http://localhost:${testPort}`;
    let tempDir: string | undefined;
    let dbPath: string | undefined;

    afterEach(async () => {
        if (serverProcess) {
            process.emit("SIGTERM" as any);
            try {
                await Promise.race([
                    serverProcess,
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Server close timeout")), 2000)),
                ]);
            } catch (_error: any) {
                // Tests assert request behavior; shutdown timeout should not mask that.
            }
        }

        serverProcess = undefined;
        mock.restoreAll();
        process.removeAllListeners("SIGTERM");
        process.removeAllListeners("SIGINT");
        await fs.rm(tempDir || "", { recursive: true, force: true }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 100));
    });

    async function createDbAndKey(options: { monthlyLimit?: number; rateLimitPerMinute?: number } = {}) {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mp-publish-test-"));
        dbPath = path.join(tempDir, "gateway.sqlite");
        const store = new ApiKeyStore(dbPath);
        try {
            return store.issueKey({
                name: "test-tenant",
                monthlyLimit: options.monthlyLimit ?? null,
                rateLimitPerMinute: options.rateLimitPerMinute ?? 60,
            });
        } finally {
            store.close();
        }
    }

    async function startServer(options: { monthlyLimit?: number; rateLimitPerMinute?: number } = {}) {
        const issued = await createDbAndKey(options);
        mock.method(console, "log", mock.fn());
        serverProcess = serveCommand({ port: testPort, version: "1.0.0", dbPath });
        await new Promise((resolve) => setTimeout(resolve, 200));
        return issued;
    }

    async function makeRequest(
        method: string,
        endpoint: string,
        options: { headers?: Record<string, string>; body?: any } = {},
    ): Promise<{ statusCode: number; body: any }> {
        const url = new URL(endpoint, baseUrl).toString();
        const fetchOptions: RequestInit = {
            method,
            headers: {
                "Content-Type": "application/json",
                ...options.headers,
            },
        };

        if (options.body !== undefined) {
            fetchOptions.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
        }

        const res = await fetch(url, fetchOptions);
        const statusCode = res.status;
        try {
            return { statusCode, body: await res.json() };
        } catch {
            return { statusCode, body: await res.text() };
        }
    }

    describe("Health Check", () => {
        it("should return health status without auth", async () => {
            await startServer();

            const { statusCode, body } = await makeRequest("GET", "/health");

            assert.equal(statusCode, 200);
            assert.equal(body.status, "ok");
            assert.equal(body.service, "hive-mp-publish-gateway");
            assert.equal(body.version, "1.0.0");
        });
    });

    describe("Authentication", () => {
        it("should reject access without API key", async () => {
            await startServer();

            const { statusCode, body } = await makeRequest("GET", "/verify");

            assert.equal(statusCode, 401);
            assert.equal(body.code, -1);
            assert.ok(body.desc.includes("Missing API key"));
        });

        it("should reject access with invalid API key", async () => {
            await startServer();

            const { statusCode, body } = await makeRequest("GET", "/verify", {
                headers: { "x-api-key": "invalid" },
            });

            assert.equal(statusCode, 401);
            assert.ok(body.desc.includes("Invalid API key"));
        });

        it("should allow access with valid API key", async () => {
            const issued = await startServer();

            const { statusCode, body } = await makeRequest("GET", "/verify", {
                headers: { "x-api-key": issued.key },
            });

            assert.equal(statusCode, 200);
            assert.equal(body.success, true);
            assert.equal(body.key.id, issued.id);
        });

        it("should enforce per-minute rate limit", async () => {
            const issued = await startServer({ rateLimitPerMinute: 1 });

            const first = await makeRequest("GET", "/verify", {
                headers: { "x-api-key": issued.key },
            });
            const second = await makeRequest("GET", "/verify", {
                headers: { "x-api-key": issued.key },
            });

            assert.equal(first.statusCode, 200);
            assert.equal(second.statusCode, 429);
        });

        it("should reject revoked API key immediately", async () => {
            const issued = await startServer();
            const store = new ApiKeyStore(dbPath as string);
            store.revokeKey(issued.key);
            store.close();

            const { statusCode, body } = await makeRequest("GET", "/verify", {
                headers: { "x-api-key": issued.key },
            });

            assert.equal(statusCode, 401);
            assert.ok(body.desc.includes("Revoked API key"));
        });
    });

    describe("Upload Endpoint", () => {
        it("should reject upload without API key", async () => {
            await startServer();

            const { statusCode } = await makeRequest("POST", "/upload");

            assert.equal(statusCode, 401);
        });

        it("should upload a valid markdown file and verify it exists on disk", async () => {
            const issued = await startServer();
            const boundary = "----testboundary";
            const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.md"\r\nContent-Type: text/markdown\r\n\r\n# hello\r\n\r\n--${boundary}--\r\n`;

            const { statusCode, body: resBody } = await makeRequest("POST", "/upload", {
                headers: {
                    "Content-Type": `multipart/form-data; boundary=${boundary}`,
                    "x-api-key": issued.key,
                },
                body,
            });

            assert.equal(statusCode, 200);
            assert.ok(resBody.success);
            assert.ok(resBody.data.fileId);

            const uploadedFile = path.join(UPLOAD_DIR, resBody.data.fileId);
            const exists = await fs
                .access(uploadedFile)
                .then(() => true)
                .catch(() => false);
            assert.ok(exists, "上传的文件应该真实存在于磁盘上");
            await fs.unlink(uploadedFile).catch(() => {});
        });

        it("should reject unsupported file type", async () => {
            const issued = await startServer();
            const boundary = "----testboundary";
            const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.exe"\r\nContent-Type: application/octet-stream\r\n\r\nxxx\r\n--${boundary}--\r\n`;

            const { statusCode, body: resBody } = await makeRequest("POST", "/upload", {
                headers: {
                    "Content-Type": `multipart/form-data; boundary=${boundary}`,
                    "x-api-key": issued.key,
                },
                body,
            });

            assert.equal(statusCode, 400);
            assert.ok(resBody.desc.includes("不支持的文件类型"));
        });
    });

    describe("Publish Endpoint", () => {
        it("should pass request AppID/AppSecret to WeChat publisher without server env credentials", async () => {
            const issued = await startServer();
            const previousAppId = process.env.WECHAT_APP_ID;
            const previousAppSecret = process.env.WECHAT_APP_SECRET;
            delete process.env.WECHAT_APP_ID;
            delete process.env.WECHAT_APP_SECRET;

            try {
                const wrapper = await import("@wenyan-md/core/wrapper");
                const getAccessTokenMock = mock.method(
                    wrapper.wechatPublisher as any,
                    "getAccessTokenWithCache",
                    async () => "mock-access-token",
                );
                mock.method(wrapper.wechatPublisher as any, "uploadImage", async () => ({
                    media_id: "mock-upload-media-id",
                    url: "https://mmbiz.qpic.cn/mock-uploaded-image",
                }));
                const publishDraftMock = mock.method(wrapper.wechatPublisher as any, "publishToDraft", async () => ({
                    media_id: "mock-media-id-123",
                }));

                const imageBoundary = "----testimageupload";
                const imageBody = [
                    `--${imageBoundary}`,
                    `Content-Disposition: form-data; name="file"; filename="cover.png"`,
                    `Content-Type: image/png`,
                    "",
                    "fake-image-content",
                    `--${imageBoundary}--`,
                ].join("\r\n");

                const imageUploadRes = await makeRequest("POST", "/upload", {
                    headers: {
                        "Content-Type": `multipart/form-data; boundary=${imageBoundary}`,
                        "x-api-key": issued.key,
                    },
                    body: imageBody,
                });

                assert.equal(imageUploadRes.statusCode, 200);
                const imageFileId = imageUploadRes.body.data.fileId;

                const articleJson = JSON.stringify({
                    title: "测试文章",
                    content: `<p>测试内容</p><img src="asset://${imageFileId}" />`,
                    author: "测试作者",
                    source_url: "https://example.com",
                    need_open_comment: 1,
                    only_fans_can_comment: 1,
                });

                const articleBoundary = "----testarticleupload";
                const articleBody = [
                    `--${articleBoundary}`,
                    `Content-Disposition: form-data; name="file"; filename="article.json"`,
                    `Content-Type: application/json`,
                    "",
                    articleJson,
                    `--${articleBoundary}--`,
                ].join("\r\n");

                const uploadRes = await makeRequest("POST", "/upload", {
                    headers: {
                        "Content-Type": `multipart/form-data; boundary=${articleBoundary}`,
                        "x-api-key": issued.key,
                    },
                    body: articleBody,
                });

                assert.equal(uploadRes.statusCode, 200);
                const fileId = uploadRes.body.data.fileId;

                const publishRes = await makeRequest("POST", "/publish", {
                    headers: { "x-api-key": issued.key },
                    body: { fileId, appId: "test-app-id", appSecret: "test-app-secret" },
                });

                assert.equal(publishRes.statusCode, 200);
                assert.equal(publishRes.body.media_id, "mock-media-id-123");
                assert.equal(getAccessTokenMock.mock.callCount(), 1);
                assert.deepEqual(getAccessTokenMock.mock.calls[0].arguments, ["test-app-id", "test-app-secret"]);
                assert.equal(publishDraftMock.mock.callCount(), 1);

                const publishOptions = publishDraftMock.mock.calls[0].arguments[1];
                assert.equal(publishOptions.need_open_comment, 1);
                assert.equal(publishOptions.only_fans_can_comment, 1);
            } finally {
                if (previousAppId === undefined) {
                    delete process.env.WECHAT_APP_ID;
                } else {
                    process.env.WECHAT_APP_ID = previousAppId;
                }

                if (previousAppSecret === undefined) {
                    delete process.env.WECHAT_APP_SECRET;
                } else {
                    process.env.WECHAT_APP_SECRET = previousAppSecret;
                }
            }
        });

        it("should reject publish without appSecret", async () => {
            const issued = await startServer();

            const { statusCode, body } = await makeRequest("POST", "/publish", {
                headers: { "x-api-key": issued.key },
                body: { fileId: "x", appId: "test-app-id" },
            });

            assert.equal(statusCode, 400);
            assert.ok(body.desc.includes("appSecret"));
        });

        it("should reject publish with non-existent fileId", async () => {
            const issued = await startServer();

            const { statusCode, body } = await makeRequest("POST", "/publish", {
                headers: { "x-api-key": issued.key },
                body: { fileId: "non-existent-id", appId: "test-app-id", appSecret: "test-app-secret" },
            });

            assert.equal(statusCode, 400);
            assert.ok(body.desc.includes("文件不存在") || body.desc.includes("non-existent-id"));
            assert.ok(!JSON.stringify(body).includes("test-app-secret"));
        });
    });

    describe("Server Startup", () => {
        it("should start server on specified port", async () => {
            const consoleLogMock = mock.fn();
            mock.method(console, "log", consoleLogMock);
            await createDbAndKey();

            serverProcess = serveCommand({ port: testPort, version: "1.0.0", dbPath });
            await new Promise((resolve) => setTimeout(resolve, 200));

            assert.ok(
                consoleLogMock.mock.calls.some((call) => {
                    const args = call.arguments;
                    return args.some((arg: any) => typeof arg === "string" && arg.includes("Gateway started"));
                }),
            );
        });

        it("should reject when port is in use", async () => {
            mock.method(console, "log", mock.fn());
            mock.method(console, "error", mock.fn());
            await createDbAndKey();

            const firstServer = serveCommand({ port: testPort, dbPath });
            serverProcess = firstServer;
            await new Promise((resolve) => setTimeout(resolve, 200));

            const secondDbPath = path.join(tempDir as string, "second.sqlite");
            const secondServer = serveCommand({ port: testPort, dbPath: secondDbPath });

            await assert.rejects(secondServer, /已被占用|EADDRINUSE/);
        });
    });
});
