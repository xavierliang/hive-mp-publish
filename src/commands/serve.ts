import express, { Request, Response, NextFunction } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { configDir, publishToWechatDraft, publishImageTextToWechatDraft } from "@wenyan-md/core/wrapper";
import multer from "multer";
import { WechatPublishResponse } from "@wenyan-md/core/wechat";
import { ApiKeyRecord, ApiKeyStore, getDefaultGatewayDbPath } from "../apiKeyStore.js";
import { redactSensitive } from "../security.js";
import { installInMemoryAccessTokenCache } from "../tokenCache.js";

export interface ServeOptions {
    port?: number;
    version?: string;
    dbPath?: string;
}

interface RenderRequest {
    fileId: string;
    theme?: string;
    highlight?: string;
    customTheme?: string;
    macStyle?: boolean;
    footnote?: boolean;
    appId?: string;
    appSecret?: string;
}

interface AuthedRequest extends Request {
    apiKeyRecord?: ApiKeyRecord;
    sensitiveValues?: string[];
}

class AppError extends Error {
    constructor(public message: string) {
        super(message);
        this.name = "AppError";
    }
}

const UPLOAD_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const UPLOAD_DIR = path.join(configDir, "uploads");

export async function serveCommand(options: ServeOptions) {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    cleanupOldUploads();
    setInterval(cleanupOldUploads, UPLOAD_TTL_MS).unref();
    installInMemoryAccessTokenCache();

    const app = express();
    const port = options.port || 3000;
    const apiKeyStore = new ApiKeyStore(options.dbPath || getDefaultGatewayDbPath());
    const auth = createAuthHandler(apiKeyStore);

    app.use(express.json({ limit: "10mb" }));

    const storage = multer.diskStorage({
        destination: (_req, _file, cb) => {
            cb(null, UPLOAD_DIR);
        },
        filename: (_req, file, cb) => {
            const fileId = crypto.randomUUID();
            const ext = file.originalname.split(".").pop() || "";
            cb(null, ext ? `${fileId}.${ext}` : fileId);
        },
    });

    const upload = multer({
        storage,
        limits: {
            fileSize: 10 * 1024 * 1024, // 10MB
        },
        fileFilter: (_req, file, cb) => {
            const ext = file.originalname.split(".").pop()?.toLowerCase();
            const allowedImageTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
            const allowedImageExts = ["jpg", "jpeg", "png", "gif", "webp", "svg"];

            const isImage = allowedImageTypes.includes(file.mimetype) || (ext && allowedImageExts.includes(ext));
            const isMarkdown = ext === "md" || file.mimetype === "text/markdown" || file.mimetype === "text/plain";
            const isCss = ext === "css" || file.mimetype === "text/css";
            const isJson = ext === "json" || file.mimetype === "application/json";

            if (isImage || isMarkdown || isCss || isJson) {
                cb(null, true);
            } else {
                cb(new AppError("不支持的文件类型，仅支持图片、Markdown、CSS 和 JSON 文件"));
            }
        },
    });

    app.get("/health", (_req: Request, res: Response) => {
        res.json({
            status: "ok",
            service: "hive-mp-publish-gateway",
            version: options.version || "unknown",
        });
    });

    app.get("/verify", auth, (req: AuthedRequest, res: Response) => {
        res.json({
            success: true,
            message: "Authorized",
            key: {
                id: req.apiKeyRecord?.id,
                name: req.apiKeyRecord?.name,
                prefix: req.apiKeyRecord?.prefix,
            },
        });
    });

    app.post("/publish", auth, async (req: AuthedRequest, res: Response) => {
        const body: RenderRequest = req.body;
        req.sensitiveValues = [...(req.sensitiveValues || []), body.appSecret].filter(Boolean) as string[];
        validateRequest(body);

        const files = await fs.readdir(UPLOAD_DIR);
        const matchedFile = files.find((f) => f === body.fileId);

        if (!matchedFile) {
            throw new AppError(`文件不存在或已过期，请重新上传 (ID: ${body.fileId})`);
        }

        const ext = path.extname(matchedFile).toLowerCase();
        if (ext !== ".json") {
            throw new AppError("请提供 JSON 文件的 fileId，不能直接发布图片文件");
        }

        const filePath = path.join(UPLOAD_DIR, matchedFile);
        const fileContent = await fs.readFile(filePath, "utf-8");
        const gzhContent = JSON.parse(fileContent);

        if (!gzhContent.title) throw new AppError("未能找到文章标题");

        const resolveAssetPath = (assetUrl: string) => {
            const assetFileId = assetUrl.replace("asset://", "");
            const matchedAsset = files.find((f) => f === assetFileId || path.parse(f).name === assetFileId);
            return matchedAsset ? path.join(UPLOAD_DIR, matchedAsset) : assetUrl;
        };

        gzhContent.content = gzhContent.content.replace(
            /(<img\b[^>]*?\bsrc\s*=\s*["'])(asset:\/\/[^"']+)(["'])/gi,
            (_match: any, prefix: string, assetUrl: string, suffix: string) =>
                prefix + resolveAssetPath(assetUrl) + suffix,
        );

        if (gzhContent.cover && gzhContent.cover.startsWith("asset://")) {
            gzhContent.cover = resolveAssetPath(gzhContent.cover);
        }

        if (gzhContent.image_list && Array.isArray(gzhContent.image_list)) {
            gzhContent.image_list = gzhContent.image_list.map((img: string) => {
                if (img.startsWith("asset://")) return resolveAssetPath(img);
                return img;
            });
        }

        let data: WechatPublishResponse;
        try {
            if (gzhContent.image_list && gzhContent.image_list.length > 0) {
                data = await publishImageTextToWechatDraft(
                    {
                        title: gzhContent.title,
                        content: gzhContent.content,
                        images: gzhContent.image_list,
                        cover: gzhContent.cover,
                        author: gzhContent.author,
                        need_open_comment: gzhContent.need_open_comment,
                        only_fans_can_comment: gzhContent.only_fans_can_comment,
                    },
                    {
                        appId: body.appId,
                        appSecret: body.appSecret,
                    },
                );
            } else {
                data = await publishToWechatDraft(
                    {
                        title: gzhContent.title,
                        content: gzhContent.content,
                        cover: gzhContent.cover,
                        author: gzhContent.author,
                        source_url: gzhContent.source_url,
                        need_open_comment: gzhContent.need_open_comment,
                        only_fans_can_comment: gzhContent.only_fans_can_comment,
                    },
                    {
                        appId: body.appId,
                        appSecret: body.appSecret,
                    },
                );
            }
        } catch (err) {
            throw wrapPublishError(err);
        }

        if (data.media_id) {
            res.json({
                media_id: data.media_id,
            });
        } else {
            throw new AppError(`发布到微信公众号失败，\n${JSON.stringify(data)}`);
        }
    });

    app.post("/upload", auth, upload.single("file"), async (req: Request, res: Response) => {
        if (!req.file) {
            throw new AppError("未找到上传的文件");
        }

        res.json({
            success: true,
            data: {
                fileId: req.file.filename,
                originalFilename: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size,
            },
        });
    });

    app.use(errorHandler);

    return new Promise<void>((resolve, reject) => {
        const server = app.listen(port, () => {
            console.log(`Hive MP Publish Gateway started on port ${port}`);
            console.log(`API key database: ${apiKeyStore.dbPath}`);
            console.log(`Health: http://localhost:${port}/health`);
            console.log(`Verify: http://localhost:${port}/verify`);
            console.log(`Publish: POST http://localhost:${port}/publish`);
            console.log(`Upload: POST http://localhost:${port}/upload`);
        });

        server.on("error", (err: any) => {
            if (err.code === "EADDRINUSE") {
                console.error(`端口 ${port} 已被占用`);
                apiKeyStore.close();
                reject(new Error(`端口 ${port} 已被占用`));
            } else {
                apiKeyStore.close();
                reject(err);
            }
        });

        const shutdown = () => {
            server.close(() => {
                apiKeyStore.close();
                resolve();
            });
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    });
}

function wrapPublishError(err: unknown): AppError {
    if (err instanceof AppError) return err;

    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("InputPath must be an absolute path")) {
        const pathMatch = msg.match(/'([^']+)'/);
        const badPath = pathMatch ? pathMatch[1] : "";
        return new AppError(
            `无法解析图片路径 '${badPath}'。请确保图片已通过 /upload 接口上传（使用 asset:// 链接），或使用 http/https 网络图片。`,
        );
    }

    return new AppError(msg);
}

function errorHandler(error: any, req: AuthedRequest, res: Response, next: NextFunction): void {
    if (res.headersSent) {
        return next(error);
    }

    const sensitiveValues = req.sensitiveValues || [];
    const message = redactSensitive(error instanceof Error ? error.message : String(error), sensitiveValues);
    const isAppError = error instanceof AppError;
    const isMulterError = error.name === "MulterError";
    const statusCode = isAppError || isMulterError ? 400 : 500;

    if (statusCode === 500) {
        console.error("[Gateway Error]:", message);
    }

    res.status(statusCode).json({
        code: -1,
        desc: message,
    });
}

function createAuthHandler(apiKeyStore: ApiKeyStore) {
    const buckets = new Map<number, { windowStart: number; count: number }>();

    return (req: AuthedRequest, res: Response, next: NextFunction): void => {
        const apiKeyHeader = req.headers["x-api-key"];
        const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
        req.sensitiveValues = apiKey ? [apiKey] : [];

        const verification = apiKeyStore.verifyKey(apiKey);
        if (!verification.ok) {
            res.status(verification.statusCode).json({
                code: -1,
                desc: `Unauthorized: ${verification.reason}`,
            });
            return;
        }

        if (!consumeRateLimit(buckets, verification.record)) {
            res.status(429).json({
                code: -1,
                desc: "Rate limit exceeded",
            });
            return;
        }

        apiKeyStore.recordUsage(verification.record.id, req.path === "/publish");
        req.apiKeyRecord = verification.record;
        next();
    };
}

function consumeRateLimit(
    buckets: Map<number, { windowStart: number; count: number }>,
    record: ApiKeyRecord,
): boolean {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const current = buckets.get(record.id);

    if (!current || now - current.windowStart >= windowMs) {
        buckets.set(record.id, { windowStart: now, count: 1 });
        return true;
    }

    if (current.count >= record.rateLimitPerMinute) {
        return false;
    }

    current.count += 1;
    return true;
}

function validateRequest(req: RenderRequest): void {
    if (!req.fileId) {
        throw new AppError("缺少必要参数：fileId");
    }
    if (!req.appId) {
        throw new AppError("缺少必要参数：appId");
    }
    if (!req.appSecret) {
        throw new AppError("缺少必要参数：appSecret");
    }
}

async function cleanupOldUploads() {
    try {
        const files = await fs.readdir(UPLOAD_DIR);
        const now = Date.now();
        for (const file of files) {
            const filePath = path.join(UPLOAD_DIR, file);
            try {
                const stats = await fs.stat(filePath);
                if (now - stats.mtimeMs > UPLOAD_TTL_MS) {
                    await fs.unlink(filePath);
                }
            } catch {
                // Ignore one failed cleanup item and continue the sweep.
            }
        }
    } catch (e) {
        console.error("Cleanup task error:", redactSensitive(e));
    }
}
