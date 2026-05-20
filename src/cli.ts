#!/usr/bin/env node
// Derived from https://github.com/caol64/wenyan-cli (Apache-2.0); modified by hive-mp-publish contributors.
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import {
    addTheme,
    ClientPublishOptions,
    listThemes,
    prepareRenderContext,
    removeTheme,
    renderAndPublish,
    RenderOptions,
    ThemeOptions,
    configDir,
    credentialStore,
    wechatPublisher,
} from "@wenyan-md/core/wrapper";
import { getInputContent } from "./utils.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import input from "@inquirer/input";
import password from "@inquirer/password";
import { loadEnvFile } from "node:process";
import { renderAndPublishToGateway } from "./gatewayClient.js";
import { redactSensitive } from "./security.js";
import {
    clearGatewayCredential,
    DEFAULT_GATEWAY_SERVER,
    getCredentialPath,
    loadGatewayCredential,
    redactApiKey,
    saveGatewayCredential,
} from "./gatewayConfig.js";

interface CLIPublishOptions extends ClientPublishOptions {
    appSecret?: string;
    allowInsecureHttp?: boolean;
    proxy?: string;
    envFile?: string;
    local?: boolean;
}

export function createProgram(version: string = pkg.version): Command {
    const program = new Command();

    program
        .name("hive-mp-publish")
        .description("CLI and Gateway for publishing Markdown to WeChat MP drafts.")
        .version(version, "-v, --version", "output the current version")
        .action(() => {
            program.outputHelp();
        });

    const addCommonOptions = (cmd: Command) => {
        return cmd
            .argument("[input-content]", "markdown content (string input)")
            .option("-f, --file <path>", "read markdown content from local file or web URL")
            .option("-t, --theme <theme-id>", "ID of the theme to use", "default")
            .option("-h, --highlight <highlight-theme-id>", "ID of the code highlight theme to use", "solarized-light")
            .option("-c, --custom-theme <path>", "path to custom theme CSS file")
            .option("--mac-style", "display codeblock with mac style", true)
            .option("--no-mac-style", "disable mac style")
            .option("--footnote", "convert link to footnote", true)
            .option("--no-footnote", "disable footnote");
    };

    const pubCmd = program
        .command("publish")
        .description("Render a markdown file to styled HTML and publish to WeChat MP drafts");

    addCommonOptions(pubCmd)
        .option("--app-id <appId>", "AppID or local credential alias for the WeChat MP platform")
        .option("--app-secret <appSecret>", "AppSecret for server mode; prefer local credential/env for routine use")
        .option("--server <url>", "Gateway URL to publish through (must be HTTPS except localhost)")
        .option("--api-key <apiKey>", "API key for the remote Gateway")
        .option("--local", "Bypass configured Gateway and publish directly from this machine")
        .option("--allow-insecure-http", "Allow non-HTTPS Gateway URL for controlled testing")
        .option("--env-file <file>", "Path to a .env file to load environment variables from")
        .option("--proxy <url>", "Proxy URL to use for requests, ex: http://127.0.0.1:1080")
        .action(async (inputContent: string | undefined, options: CLIPublishOptions) => {
            await runCommandWrapper(async () => {
                if (options.envFile) {
                    loadEnvFile(options.envFile);
                }

                await setupProxy(options.proxy);

                if (await shouldPublishThroughGateway(options)) {
                    options.clientVersion = version;
                    const mediaId = await renderAndPublishToGateway(inputContent, options);
                    console.log(`发布成功，Media ID: ${mediaId}`);
                } else {
                    const mediaId = await renderAndPublish(inputContent, options, getInputContent);
                    console.log(`发布成功，Media ID: ${mediaId}`);
                }
            });
        });

    const renderCmd = program.command("render").description("Render a markdown file to styled HTML");

    addCommonOptions(renderCmd).action(async (inputContent: string | undefined, options: RenderOptions) => {
        await runCommandWrapper(async () => {
            const { gzhContent } = await prepareRenderContext(inputContent, options, getInputContent);
            console.log(gzhContent.content);
        });
    });

    program
        .command("theme")
        .description("Manage themes")
        .option("-l, --list", "List all available themes")
        .option("--add", "Add a new custom theme")
        .option("--name <name>", "Name of the new custom theme")
        .option("--path <path>", "Path to the new custom theme CSS file")
        .option("--rm <name>", "Name of the custom theme to remove")
        .action(async (options: ThemeOptions) => {
            if (Object.keys(options).length === 0) {
                program.commands.find((c) => c.name() === "theme")?.outputHelp();
                return;
            }
            await runCommandWrapper(async () => {
                const { list, add, name, path, rm } = options;
                if (list) {
                    const themes = await listThemes();
                    console.log("内置主题：");
                    themes
                        .filter((theme) => theme.isBuiltin)
                        .forEach((theme) => {
                            console.log(`- ${theme.id}: ${theme.description ?? ""}`);
                        });
                    const customThemes = themes.filter((theme) => !theme.isBuiltin);
                    if (customThemes.length > 0) {
                        console.log("\n自定义主题：");
                        customThemes.forEach((theme) => {
                            console.log(`- ${theme.id}: ${theme.description ?? ""}`);
                        });
                    }
                    return;
                }
                if (add) {
                    await addTheme(name, path);
                    console.log(`主题 "${name}" 已添加`);
                    return;
                }
                if (rm) {
                    await removeTheme(rm);
                    console.log(`主题 "${rm}" 已删除`);
                }
            });
        });

    program
        .command("serve")
        .description("Start the fixed-IP Gateway server")
        .option("-p, --port <port>", "Port to listen on (default: 3000)", "3000")
        .option("--db <path>", "SQLite database path for API keys and usage")
        .option("--env-file <file>", "Path to a .env file to load environment variables from")
        .action(async (options: { port?: string; db?: string; envFile?: string }) => {
            try {
                if (options.envFile) {
                    loadEnvFile(options.envFile);
                }
                const { serveCommand } = await import("./commands/serve.js");
                const port = options.port ? parsePositiveInt(options.port, "port") : 3000;
                await serveCommand({ port, version, dbPath: options.db });
            } catch (error: any) {
                console.error(redactSensitive(error.message || error));
                process.exit(1);
            }
        });

    program
        .command("doctor")
        .description("Check local runtime and hive-mp-publish installation")
        .action(async () => {
            await runCommandWrapper(async () => {
                await runDoctor(version);
            });
        });

    addKeyCommands(program);

    program
        .command("credential")
        .description("Manage local WeChat credentials used by the client")
        .option("-l, --location", "Get the storage location of configuration credentials")
        .option("-s, --set", "Interactively set the WeChat credentials (AppID & AppSecret)")
        .option("--set-gateway", "Set the default Gateway URL and API key")
        .option("--show-gateway", "Show the saved Gateway configuration")
        .option("--clear-gateway", "Remove the saved Gateway configuration")
        .option("--server <url>", "Gateway URL to save")
        .option("--api-key <apiKey>", "Gateway API key to save")
        .action(async (options: {
            location?: boolean;
            set?: boolean;
            setGateway?: boolean;
            showGateway?: boolean;
            clearGateway?: boolean;
            server?: string;
            apiKey?: string;
        }) => {
            if (Object.keys(options).length === 0) {
                program.commands.find((c) => c.name() === "credential")?.outputHelp();
                return;
            }
            await runCommandWrapper(async () => {
                if (options.location) {
                    console.log(getCredentialPath());
                    return;
                }
                if (options.showGateway) {
                    await showGatewayCredential();
                    return;
                }
                if (options.clearGateway) {
                    const cleared = await clearGatewayCredential();
                    console.log(cleared ? "Gateway 配置已删除。" : "没有已保存的 Gateway 配置。");
                    return;
                }
                if (options.setGateway || options.server || options.apiKey) {
                    await setGatewayCredential(options);
                    return;
                }
                if (options.set) {
                    console.log("请输入微信公众号的开发者凭据：");
                    const appId = await input({
                        message: "AppID:",
                        validate: (value) => value.trim().length > 0 || "AppID 不能为空",
                    });

                    const appSecret = await password({
                        message: "AppSecret:",
                        mask: true,
                        validate: (value) => value.trim().length > 0 || "AppSecret 不能为空",
                    });

                    const alias = await input({
                        message: "别名 (用于简化 AppID ，按回车跳过):",
                        validate: () => true,
                    });

                    await credentialStore.saveWechatCredential(appId.trim(), appSecret.trim(), alias.trim() || null);
                    console.log("微信凭据已保存到本机配置目录。");
                    await maybeSetGatewayCredential();
                }
            });
        });

    program
        .command("token")
        .description("Manage local WeChat accessToken")
        .option("-l, --location", "Get the storage location of access token")
        .option("-i, --import", "Import an external access token (disables auto-refresh)")
        .option("--app-id <appId>", "WeChat AppID")
        .option("--token <token>", "External Access Token")
        .action(async (options: { location?: boolean; import?: boolean; appId?: string; token?: string }) => {
            if (Object.keys(options).length === 0) {
                program.commands.find((c) => c.name() === "token")?.outputHelp();
                return;
            }
            await runCommandWrapper(async () => {
                if (options.location) {
                    console.log(path.join(configDir, "token.json"));
                    return;
                }
                if (options.import) {
                    const { appId, token } = options;
                    if (!appId || !token) {
                        throw new Error("导入 Token 时必须同时提供 --app-id 和 --token 参数。");
                    }

                    await wechatPublisher.setExternalToken(appId, token);

                    console.log(`成功导入 AppID [${appId}] 的外部 Token。`);
                    console.log("提示: 该 Token 的 expireAt 已设为 -1，本地模式将不再管理其生命周期。");
                }
            });
        });

    return program;
}

async function shouldPublishThroughGateway(options: CLIPublishOptions): Promise<boolean> {
    if (options.local) return false;
    if (options.server || options.apiKey || process.env.HIVE_MP_GATEWAY_URL || process.env.HIVE_MP_API_KEY) {
        return true;
    }

    const storedGateway = await loadGatewayCredential();
    return Boolean(storedGateway?.apiKey);
}

async function maybeSetGatewayCredential(): Promise<void> {
    const existingGateway = await loadGatewayCredential();
    if (existingGateway?.apiKey) {
        console.log(`Gateway 已配置：${existingGateway.server || DEFAULT_GATEWAY_SERVER}`);
        return;
    }

    console.log(`默认 Gateway: ${DEFAULT_GATEWAY_SERVER}`);
    const apiKey = await password({
        message: "Gateway API Key (可选，按回车跳过):",
        mask: true,
        validate: () => true,
    });

    if (!apiKey.trim()) {
        console.log("已跳过 Gateway 配置。");
        return;
    }

    await saveGatewayCredential({
        server: DEFAULT_GATEWAY_SERVER,
        apiKey: apiKey.trim(),
    });
    console.log("Gateway 配置已保存到本机配置目录。");
}

async function setGatewayCredential(options: { server?: string; apiKey?: string }): Promise<void> {
    const existingGateway = await loadGatewayCredential();
    const server = normalizeGatewayServer(options.server || existingGateway?.server || DEFAULT_GATEWAY_SERVER);
    let apiKey = options.apiKey?.trim();

    if (!apiKey) {
        const currentHint = existingGateway?.apiKey ? "按回车保留当前 API key" : "必填";
        const entered = await password({
            message: `Gateway API Key (${currentHint}):`,
            mask: true,
            validate: (value) =>
                existingGateway?.apiKey ? true : value.trim().length > 0 || "Gateway API Key 不能为空",
        });
        apiKey = entered.trim() || existingGateway?.apiKey;
    }

    if (!apiKey) {
        throw new Error("Gateway API Key 不能为空。");
    }

    await saveGatewayCredential({ server, apiKey });
    console.log(`Gateway URL: ${server}`);
    console.log(`Gateway API Key: ${redactApiKey(apiKey)}`);
    console.log("Gateway 配置已保存到本机配置目录。");
}

async function showGatewayCredential(): Promise<void> {
    const gateway = await loadGatewayCredential();
    console.log(`Gateway URL: ${gateway?.server || DEFAULT_GATEWAY_SERVER}${gateway?.server ? "" : " (default)"}`);
    console.log(`Gateway API Key: ${redactApiKey(gateway?.apiKey)}`);
}

function normalizeGatewayServer(rawServer: string): string {
    const server = rawServer.trim();
    if (!server) throw new Error("Gateway URL 不能为空。");

    const url = new URL(server);
    const isLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !isLocal) {
        throw new Error("Remote Gateway URL must use HTTPS.");
    }
    return url.toString().replace(/\/$/, "");
}

function addKeyCommands(program: Command): void {
    const keyCmd = program.command("key").description("Manage Gateway API keys");

    keyCmd
        .command("issue")
        .description("Issue a new Gateway API key")
        .requiredOption("--name <name>", "Customer or tenant name")
        .option("--monthly-limit <count>", "Maximum authorized Gateway requests per month")
        .option("--rate-limit-per-minute <count>", "Maximum authorized Gateway requests per minute", "60")
        .option("--db <path>", "SQLite database path", getDefaultGatewayDbPath())
        .option("--json", "Print JSON output")
        .action(async (options: { name: string; monthlyLimit?: string; rateLimitPerMinute: string; db: string; json?: boolean }) => {
            await runCommandWrapper(async () => {
                const { ApiKeyStore } = await import("./apiKeyStore.js");
                const store = new ApiKeyStore(options.db);
                try {
                    const issued = store.issueKey({
                        name: options.name,
                        monthlyLimit: options.monthlyLimit
                            ? parsePositiveInt(options.monthlyLimit, "monthly-limit")
                            : null,
                        rateLimitPerMinute: parsePositiveInt(options.rateLimitPerMinute, "rate-limit-per-minute"),
                    });
                    if (options.json) {
                        console.log(JSON.stringify(issued, null, 2));
                        return;
                    }
                    console.log(`ID: ${issued.id}`);
                    console.log(`Name: ${issued.name}`);
                    console.log(`Prefix: ${issued.prefix}`);
                    console.log(`API Key: ${issued.key}`);
                    console.log("Store this key once; only its hash is saved in SQLite.");
                } finally {
                    store.close();
                }
            });
        });

    keyCmd
        .command("revoke")
        .description("Revoke a Gateway API key")
        .option("--key <apiKey>", "Full API key to revoke")
        .option("--id <id>", "API key row id to revoke")
        .option("--db <path>", "SQLite database path", getDefaultGatewayDbPath())
        .option("--json", "Print JSON output")
        .action(async (options: { key?: string; id?: string; db: string; json?: boolean }) => {
            await runCommandWrapper(async () => {
                if (!options.key && !options.id) {
                    throw new Error("Provide either --key or --id.");
                }
                const { ApiKeyStore } = await import("./apiKeyStore.js");
                const store = new ApiKeyStore(options.db);
                try {
                    const revoked = options.id
                        ? store.revokeKeyById(parsePositiveInt(options.id, "id"))
                        : store.revokeKey(options.key as string);
                    if (options.json) {
                        console.log(JSON.stringify({ revoked }, null, 2));
                        return;
                    }
                    console.log(revoked ? "API key revoked." : "No active API key matched.");
                } finally {
                    store.close();
                }
            });
        });

    keyCmd
        .command("list")
        .description("List Gateway API keys and current-month usage")
        .option("--db <path>", "SQLite database path", getDefaultGatewayDbPath())
        .option("--json", "Print JSON output")
        .action(async (options: { db: string; json?: boolean }) => {
            await runCommandWrapper(async () => {
                const { ApiKeyStore } = await import("./apiKeyStore.js");
                const store = new ApiKeyStore(options.db);
                try {
                    const rows = store.listKeys();
                    if (options.json) {
                        console.log(JSON.stringify(rows, null, 2));
                        return;
                    }
                    if (rows.length === 0) {
                        console.log("No API keys.");
                        return;
                    }
                    for (const row of rows) {
                        console.log(
                            [
                                `#${row.id}`,
                                row.name,
                                row.status,
                                `prefix=${row.prefix}`,
                                `requests=${row.currentMonthRequests}`,
                                `publishes=${row.currentMonthPublishes}`,
                                `rpm=${row.rateLimitPerMinute}`,
                                `monthly=${row.monthlyLimit ?? "none"}`,
                            ].join("  "),
                        );
                    }
                } finally {
                    store.close();
                }
            });
        });
}

async function runDoctor(version: string): Promise<void> {
    const checks: Array<{ label: string; status: "ok" | "warn" | "fail"; detail: string }> = [];
    const minimumNode = "22.19.0";
    const nodeVersion = process.versions.node;

    checks.push({
        label: "Node.js",
        status: isAtLeastVersion(nodeVersion, minimumNode) ? "ok" : "warn",
        detail: `${process.version} (requires >=${minimumNode}; Node 24 is recommended for Gateway/server mode)`,
    });

    checks.push({
        label: "CLI version",
        status: "ok",
        detail: version,
    });

    checks.push({
        label: "Config directory",
        status: "ok",
        detail: configDir,
    });

    const credentialPath = getCredentialPath();
    checks.push({
        label: "WeChat credential",
        status: existsSync(credentialPath) ? "ok" : "warn",
        detail: existsSync(credentialPath)
            ? `configured at ${credentialPath}`
            : `not configured yet (${credentialPath}); run hive-mp-publish credential --set before publishing`,
    });

    const themes = await listThemes();
    checks.push({
        label: "Themes",
        status: themes.length > 0 ? "ok" : "fail",
        detail: `${themes.length} available`,
    });

    console.log("hive-mp-publish doctor");
    for (const check of checks) {
        console.log(`${check.status}  ${check.label}: ${check.detail}`);
    }

    const failed = checks.filter((check) => check.status === "fail");
    if (failed.length > 0) {
        throw new Error(`doctor failed: ${failed.map((check) => check.label).join(", ")}`);
    }

    console.log("doctor ok");
}

function getDefaultGatewayDbPath(): string {
    return process.env.HIVE_MP_GATEWAY_DB || path.join(configDir, "gateway.sqlite");
}

async function runCommandWrapper(action: () => Promise<void>) {
    try {
        await action();
    } catch (error) {
        console.error(redactSensitive(error));
        process.exit(1);
    }
}

function parsePositiveInt(raw: string, name: string): number {
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
    return value;
}

function isAtLeastVersion(actual: string, minimum: string): boolean {
    const actualParts = actual.split(".").map((part) => Number(part));
    const minimumParts = minimum.split(".").map((part) => Number(part));

    for (let i = 0; i < Math.max(actualParts.length, minimumParts.length); i += 1) {
        const actualPart = actualParts[i] ?? 0;
        const minimumPart = minimumParts[i] ?? 0;
        if (actualPart > minimumPart) return true;
        if (actualPart < minimumPart) return false;
    }

    return true;
}

async function setupProxy(proxyUrl?: string) {
    const url =
        proxyUrl ||
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy ||
        process.env.ALL_PROXY;
    if (!url) return;
    const { ProxyAgent, setGlobalDispatcher, install } = await import("undici");
    const cleanUrl = url.trim();
    const agent = new ProxyAgent(cleanUrl);
    setGlobalDispatcher(agent);
    install();
    console.error(`[Proxy] Global fetch proxy enabled: ${redactSensitive(cleanUrl)}`);
}

export const program = createProgram();

function isMainModule(): boolean {
    if (import.meta.main !== undefined) return import.meta.main;
    if (!process.argv[1]) return false;
    try {
        return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
    } catch {
        return false;
    }
}

if (isMainModule()) {
    program.parse(process.argv);
}
