#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const cliJs = path.join(repoRoot, "dist", "cli.js");
const fixturePublishMd = path.join(repoRoot, "tests", "publish.md");
const fixtureManhuaCss = path.join(repoRoot, "tests", "manhua.css");
const nodeBin = resolveNodeBin();
const bunBin = resolveBunBin();
const DEFAULT_CHILD_TIMEOUT_MS = 30_000;
const SERVE_CHILD_TIMEOUT_MS = 60_000;
const CHILD_KILL_GRACE_MS = 1_000;
async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hive-mp-bun-smoke-"));
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
    const ctx = {
        tmp,
        env: childEnv(tmp),
        version: pkg.version,
        apiKey: "hmp_live_SMOKEKEY_SMOKEKEY_SMOKEKEY",
        appId: "smoke_app_id",
        appSecret: "smoke_app_secret",
    };
    try {
        for (const step of [helpVersion, render, keyLifecycle, serveLifecycle, security, envFile, proxy]) {
            await step(ctx);
        }
        console.log("Bun smoke passed");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}
async function helpVersion(ctx) {
    const help = cli(ctx, ["--help"]);
    exit(help, 0, "help");
    includes(help.stdout, "Usage:", "help output");
    const version = cli(ctx, ["--version"]);
    exit(version, 0, "version");
    ok(version.stdout.trim() === ctx.version, `version mismatch: ${version.stdout.trim()}`);
}
async function render(ctx) {
    const result = cli(ctx, ["render", "-f", fixturePublishMd, "-c", fixtureManhuaCss, "--no-mac-style"]);
    exit(result, 0, "render");
    includes(result.stdout, "<section", "render output");
}
async function keyLifecycle(ctx) {
    const db = path.join(ctx.tmp, "keys.sqlite");
    const issued = json(cli(ctx, ["key", "issue", "--name", "smoke", "--db", db, "--json"]), "key issue");
    ok(fs.existsSync(db), "key DB was not created");
    ok(/^hmp_(live|test)_/.test(issued.key), "issued key prefix mismatch");
    const listed = json(cli(ctx, ["key", "list", "--db", db, "--json"]), "key list");
    ok(listed.some((row) => row.id === issued.id && row.currentMonthRequests === 0), "issued key missing from list");
    const revoked = json(cli(ctx, ["key", "revoke", "--id", String(issued.id), "--db", db, "--json"]), "key revoke");
    ok(revoked.revoked === true, "key was not revoked");
    const nodeListed = json(run(nodeBin, [cliJs, "key", "list", "--db", db, "--json"], ctx), "Node readback");
    ok(nodeListed.some((row) => row.id === issued.id && row.status === "revoked"), "Node did not see revoked key");
}
async function serveLifecycle(ctx) {
    const db = path.join(ctx.tmp, "serve.sqlite");
    const issued = json(cli(ctx, ["key", "issue", "--name", "serve-smoke", "--db", db, "--json"]), "serve key");
    const server = await startServe(ctx, db);
    try {
        const valid = await fetchJson(`http://localhost:${server.port}/verify`, { headers: { "x-api-key": issued.key } });
        ok(valid.status === 200 && valid.data.success === true, `valid verify failed: ${valid.status}`);
        ok(valid.data.key?.prefix === issued.key.slice(0, 14), "valid verify prefix mismatch");
        const invalid = await fetchJson(`http://localhost:${server.port}/verify`, {
            headers: { "x-api-key": "hmp_live_bogus_BOGUSBOGUSBOGUS" },
        });
        ok(invalid.status === 401, `bogus verify status ${invalid.status}`);
    } finally {
        server.child.kill("SIGTERM");
        await waitExit(server.child, 5000, "serve SIGTERM");
    }
}
async function security(ctx) {
    const remoteHttp = cli(ctx, ["publish", "--server", "http://example.com", "-f", fixturePublishMd, ...fakes(ctx)]);
    nonzero(remoteHttp, "remote HTTP rejection");
    includes(remoteHttp.stderr, "HTTPS", "remote HTTP rejection");
    ok(!output(remoteHttp).includes(ctx.appSecret), "remote HTTP rejection leaked appSecret");

    const refusedPort = await freePort();
    const localhost = cli(ctx, ["publish", "--server", `http://localhost:${refusedPort}`, "-f", fixturePublishMd, ...fakes(ctx)]);
    nonzero(localhost, "localhost HTTP network failure");
    ok(!output(localhost).includes("HTTPS"), "localhost exemption failed before network stage");

    const mock = await mockGateway(ctx);
    try {
        const redaction = await cliAsync(ctx, [
            "publish",
            "--server",
            `http://localhost:${mock.port}`,
            "-f",
            fixturePublishMd,
            "--allow-insecure-http",
            ...fakes(ctx),
        ]);
        nonzero(redaction, "mock publish failure");
        const text = output(redaction);
        ok(!text.includes(ctx.apiKey), "mock publish leaked raw API key");
        ok(!text.includes(ctx.appSecret), "mock publish leaked raw appSecret");
        includes(text, "[REDACTED_API_KEY]", "mock publish API key redaction");
        includes(text, "[REDACTED]", "mock publish appSecret redaction");
    } finally {
        await mock.close();
    }
}
async function envFile(ctx) {
    await envRoute(ctx, "smoke-loaded.env", false);
    await envRoute(ctx, "smoke-nooverride.env", true);
    await envEnoent(ctx);
    await parserProbe(ctx);
}
async function envRoute(ctx, name, preset) {
    const pair = await gatewayPair(ctx);
    try {
        const envPath = writeEnv(ctx, name, pair.envFile.port);
        const env = preset ? { ...ctx.env, HIVE_MP_GATEWAY_URL: `http://localhost:${pair.preset.port}` } : ctx.env;
        const result = await cliAsync(ctx, ["publish", "-f", fixturePublishMd, "--env-file", envPath, "--allow-insecure-http"], env);
        assertProcessCompleted(result, `${name} publish`);
        const hit = preset ? pair.preset.requests : pair.envFile.requests;
        const miss = preset ? pair.envFile.requests : pair.preset.requests;
        ok(hit.length > 0, `${name} expected gateway was not contacted`);
        ok(miss.length === 0, `${name} wrong gateway was contacted`);
        ok(!/Server mode requires|missing .*--(api-key|server|app-id)/i.test(output(result)), `${name} did not load`);
    } finally {
        await pair.close();
    }
}
async function envEnoent(ctx) {
    const pair = await gatewayPair(ctx);
    const missing = path.join(ctx.tmp, "nope.env");
    try {
        const result = await cliAsync(ctx, [
            "publish",
            "-f",
            fixturePublishMd,
            "--env-file",
            missing,
            "--server",
            `http://localhost:${pair.envFile.port}`,
            "--allow-insecure-http",
            ...fakes(ctx),
        ]);
        nonzero(result, "missing env file");
        includes(result.stderr, "ENOENT", "missing env ENOENT");
        includes(result.stderr, missing, "missing env path");
        ok(pair.envFile.requests.length === 0 && pair.preset.requests.length === 0, "ENOENT contacted a gateway");
    } finally {
        await pair.close();
    }
}
async function parserProbe(ctx) {
    const fixture = path.join(repoRoot, "tests", "fixtures", "env-oracle.env");
    const probe = path.join(ctx.tmp, "parser-probe.mjs");
    fs.writeFileSync(
        probe,
        [
            `import { parseEnvContentForCompat } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "dist", "env.js")).href)};`,
            'import { readFileSync } from "node:fs";',
            'process.stdout.write(JSON.stringify(parseEnvContentForCompat(readFileSync(process.argv[2], "utf-8"))));',
            "",
        ].join("\n"),
    );
    const probeResult = run(bunBin, [probe, fixture], ctx);
    exit(probeResult, 0, "parser probe");
    const parsed = JSON.parse(probeResult.stdout);
    equals(parsed.HIVE_MP_SMOKE_EXPORT, "exported value", "export prefix");
    equals(parsed.HIVE_MP_SMOKE_WHITESPACE_TRIM, "trimmed value", "whitespace trim");
    equals(parsed.HIVE_MP_SMOKE_SQUOTE, "single quoted value", "single quoted value");
    equals(parsed.HIVE_MP_SMOKE_DQUOTE, "double quoted value", "double quoted value");
    equals(parsed.HIVE_MP_SMOKE_SQUOTE_MULTILINE, "single\nquoted\nvalue", "single quoted multiline");
    equals(parsed.HIVE_MP_SMOKE_DQUOTE_MULTILINE, "double\nquoted\nvalue", "double quoted multiline");
    includes(parsed.HIVE_MP_SMOKE_HASH_INSIDE_QUOTES, "#", "quoted hash");
    ok(parsed.HIVE_MP_SMOKE_INLINE_COMMENT_NOSPACE === "value", "inline comment without space mismatch");
    ok(parsed.HIVE_MP_SMOKE_INLINE_COMMENT_WITH_SPACE === "value", "inline comment with space mismatch");
    ok(!Object.hasOwn(parsed, "HIVE_MP_SMOKE_COMMENTED_OUT"), "commented key was parsed");
    ok(!Object.hasOwn(parsed, "HIVE_MP_SMOKE_BLANK_LINE_PROBE"), "blank-line probe was parsed");
    for (const line of fs.readFileSync(fixture, "utf-8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (/^HIVE_MP_SMOKE_[A-Z0-9_]+$/.test(trimmed)) ok(!Object.hasOwn(parsed, trimmed), `${trimmed} was parsed`);
    }
}
async function proxy(ctx) {
    const explicit = cli(ctx, [
        "publish",
        "--server",
        `https://localhost:${await freePort()}`,
        "--proxy",
        "http://127.0.0.1:1",
        "-f",
        fixturePublishMd,
        ...fakes(ctx),
    ]);
    nonzero(explicit, "explicit proxy rejection");
    ok(/--proxy.*not supported.*Bun|Bun.*--proxy.*not supported/i.test(explicit.stderr), "explicit proxy did not fail closed");
    ok(!explicit.stderr.includes("[Proxy] Bun runtime detected"), "explicit proxy used env warning path");

    const envProxy = cli(
        ctx,
        ["publish", "--server", `https://localhost:${await freePort()}`, "-f", fixturePublishMd, ...fakes(ctx)],
        { ...ctx.env, HTTPS_PROXY: "http://127.0.0.1:1" },
    );
    nonzero(envProxy, "HTTPS_PROXY network failure");
    includes(envProxy.stderr, "[Proxy] Bun runtime detected", "HTTPS_PROXY warning");
    ok(!/--proxy.*not supported/i.test(envProxy.stderr), "HTTPS_PROXY path failed as explicit proxy");
    ok(
        /Unable to connect|ECONNREFUSED|Connection refused|fetch failed|NetworkError/i.test(output(envProxy)),
        "HTTPS_PROXY did not reach network stage",
    );
}
async function startServe(ctx, db) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const port = await freePort();
        const child = spawn(bunBin, [cliJs, "serve", "--port", String(port), "--db", db], {
            cwd: ctx.tmp,
            env: ctx.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdoutText = "";
        child.stderrText = "";
        child.stdout.on("data", (chunk) => (child.stdoutText += chunk));
        child.stderr.on("data", (chunk) => (child.stderrText += chunk));
        armChildTimeout(child, SERVE_CHILD_TIMEOUT_MS, `serve on port ${port}`);
        try {
            await waitHealth(port, child);
            return { child, port };
        } catch (error) {
            lastError = error;
            if (!child.killed) child.kill("SIGTERM");
            await waitExit(child, 1000, "serve retry cleanup").catch(() => undefined);
            if (!/EADDRINUSE|已被占用/.test(child.stderrText)) break;
        }
    }
    throw lastError;
}
async function waitHealth(port, child) {
    for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
        if (child.exitCode !== null) throw new Error(`serve exited early: ${scrub(child.stderrText || child.stdoutText)}`);
        try {
            const health = await fetchJson(`http://localhost:${port}/health`);
            if (health.status === 200 && health.data.status === "ok") return;
        } catch {
            // Retry until the serve startup deadline.
        }
        await sleep(100);
    }
    throw new Error(`serve health timed out: ${scrub(child.stderrText || child.stdoutText)}`);
}
async function gatewayPair(ctx) {
    const envFile = await mockGateway(ctx);
    const preset = await mockGateway(ctx);
    return { envFile, preset, close: () => Promise.all([envFile.close(), preset.close()]) };
}
async function mockGateway(ctx) {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        const requestPath = new URL(req.url || "/", "http://localhost").pathname;
        requests.push({ method: req.method || "GET", path: requestPath, apiKey: req.headers["x-api-key"] });
        await drain(req);
        if (requestPath === "/health") return jsonRes(res, 200, { status: "ok" });
        if (requestPath === "/verify") return jsonRes(res, 200, { success: true, key: { id: 1, name: "smoke", prefix: "hmp_live_SMOKE" } });
        if (requestPath === "/upload") return jsonRes(res, 200, { success: true, data: { fileId: "smoke-file-id" } });
        if (requestPath === "/publish") return jsonRes(res, 500, { code: -1, desc: `bad ${ctx.apiKey} ${ctx.appSecret} in payload` });
        return jsonRes(res, 404, { code: -1, desc: "not found" });
    });
    await listen(server, 0);
    return { port: server.address().port, requests, close: () => close(server) };
}
function writeEnv(ctx, name, port) {
    const raw = fs.readFileSync(path.join(repoRoot, "tests", "fixtures", "env-oracle.env"), "utf-8");
    const envPath = path.join(ctx.tmp, name);
    fs.writeFileSync(
        envPath,
        `${raw}\nHIVE_MP_GATEWAY_URL=http://localhost:${port}\nHIVE_MP_API_KEY=${ctx.apiKey}\nWECHAT_APP_ID=${ctx.appId}\nWECHAT_APP_SECRET=${ctx.appSecret}\n`,
    );
    return envPath;
}
function childEnv(tmp) {
    const home = path.join(tmp, "home");
    const xdg = path.join(tmp, "xdg");
    for (const dir of [home, xdg, path.join(tmp, "uploads"), path.join(tmp, "dbs")]) fs.mkdirSync(dir, { recursive: true });
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        if (/^HIVE_MP_/i.test(key) || /^WECHAT_/i.test(key)) continue;
        if (["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY"].includes(key)) continue;
        env[key] = value;
    }
    return {
        ...env,
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        XDG_DATA_HOME: xdg,
        XDG_CACHE_HOME: xdg,
        APPDATA: xdg,
        HIVE_MP_CREDENTIAL_PATH: path.join(tmp, "credential.json"),
        HIVE_MP_GATEWAY_DB: path.join(tmp, "default-gateway.sqlite"),
    };
}
function cli(ctx, args, env = ctx.env, options = {}) { return run(bunBin, [cliJs, ...args], ctx, env, options); }
function cliAsync(ctx, args, env = ctx.env, options = {}) { return runAsync(bunBin, [cliJs, ...args], ctx, env, options); }
function run(bin, args, ctx, env = ctx.env, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;
    const result = spawnSync(bin, args, {
        cwd: ctx.tmp,
        env,
        encoding: "utf-8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
    });
    return {
        ...result,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        timedOut: result.error?.code === "ETIMEDOUT",
        command: commandText(bin, args),
        timeoutMs,
    };
}
function runAsync(bin, args, ctx, env = ctx.env, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;
    const command = commandText(bin, args);
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { cwd: ctx.tmp, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        let timedOut = false;
        let forceKill;
        const timeout = setTimeout(() => {
            timedOut = true;
            stderr += `\nTimed out after ${timeoutMs}ms: ${scrub(command)}\n`;
            child.kill("SIGTERM");
            forceKill = setTimeout(() => {
                stderr += `Process ignored SIGTERM after timeout; sent SIGKILL\n`;
                child.kill("SIGKILL");
            }, CHILD_KILL_GRACE_MS);
            forceKill.unref?.();
        }, timeoutMs);
        timeout.unref?.();
        const clearTimers = () => {
            clearTimeout(timeout);
            if (forceKill) clearTimeout(forceKill);
        };
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", (error) => {
            clearTimers();
            reject(error);
        });
        child.once("close", (status, signal) => {
            clearTimers();
            resolve({ status, signal, stdout, stderr, timedOut, command, timeoutMs });
        });
    });
}
function json(result, label) {
    try {
        exit(result, 0, label);
        return JSON.parse(result.stdout);
    } catch (error) {
        throw new Error(`${label} did not print JSON: ${scrub(result.stdout)}\n${error.message}`, { cause: error });
    }
}
function fakes(ctx) {
    return ["--app-id", ctx.appId, "--app-secret", ctx.appSecret, "--api-key", ctx.apiKey];
}
function exit(result, status, label) {
    assertProcessCompleted(result, label);
    if (result.status !== status) throw new Error(`${label} exited ${result.status}; expected ${status}\n${format(result)}`);
}
function nonzero(result, label) {
    assertProcessCompleted(result, label);
    if (result.status === 0) throw new Error(`${label} unexpectedly exited 0\n${format(result)}`);
}
function assertProcessCompleted(result, label) {
    if (result.timedOut) throw new Error(`${label} timed out after ${result.timeoutMs}ms\n${format(result)}`);
    if (result.error) throw new Error(`${label} failed to run: ${result.error.message}\n${format(result)}`);
}
function equals(actual, expected, label) {
    ok(actual === expected, `${label} mismatch: ${JSON.stringify(actual)}`);
}
function includes(text, expected, label) {
    ok(String(text).includes(expected), `${label} missing ${expected}`);
}
function ok(condition, message) {
    if (!condition) throw new Error(message);
}
function output(result) { return `${result.stdout || ""}${result.stderr || ""}`; }
function format(result) {
    const command = result.command ? `command: ${scrub(result.command)}\n` : "";
    const signal = result.signal ? `signal: ${result.signal}\n` : "";
    return `${command}${signal}stdout:\n${scrub(result.stdout || "")}\nstderr:\n${scrub(result.stderr || "")}`;
}
function scrub(value) {
    return String(value)
        .replace(/hmp_(live|test)_[A-Za-z0-9_-]+/g, "hmp_$1_[REDACTED]")
        .replaceAll("smoke_app_secret", "[REDACTED]")
        .replace(/access_token["':=\s]+[A-Za-z0-9._-]+/gi, "access_token=[REDACTED]");
}
async function fetchJson(url, init) {
    const response = await fetch(url, init);
    return { status: response.status, data: await response.json().catch(() => ({})) };
}
function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on("error", reject);
        server.listen(0, () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : undefined;
            server.close(() => (port ? resolve(port) : reject(new Error("failed to allocate port"))));
        });
    });
}
function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
            server.off("error", reject);
            resolve();
        });
    });
}
function close(server) { return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))); }
function armChildTimeout(child, timeoutMs, label) {
    let forceKill;
    const timeout = setTimeout(() => {
        child.stderrText = `${child.stderrText || ""}\n${label} timed out after ${timeoutMs}ms\n`;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => {
            child.stderrText = `${child.stderrText || ""}${label} ignored SIGTERM; sent SIGKILL\n`;
            child.kill("SIGKILL");
        }, CHILD_KILL_GRACE_MS);
        forceKill.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    const clearTimers = () => {
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
    };
    child.once("exit", clearTimers);
    return clearTimers;
}
function waitExit(child, ms, label) {
    if (child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`${label} did not exit within ${ms}ms`));
        }, ms);
        child.once("exit", () => {
            clearTimeout(timeout);
            resolve();
        });
    });
}
function commandText(bin, args) {
    return [bin, ...args].map((arg) => (/[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}
function drain(req) {
    return new Promise((resolve) => {
        req.on("data", () => undefined);
        req.on("end", resolve);
        req.on("error", resolve);
    });
}
function jsonRes(res, status, body) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function resolveNodeBin() { return isBun() ? locate("node") || "node" : process.execPath; }
function resolveBunBin() { return isBun() ? process.execPath : locate("bun") || "bun"; }
function isBun() { return Boolean(globalThis.Bun); }
function locate(name) {
    const found = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf-8" });
    return found.status === 0 ? found.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null : null;
}

main().catch((error) => {
    console.error(scrub(error?.stack || error?.message || error));
    process.exit(1);
});
