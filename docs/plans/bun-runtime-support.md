# Plan: Public Bun runtime support for hive-mp-publish

<!-- 修订v1: 初稿——dev-planner 落地 -->
<!-- 修订v2: lead 拍板——折叠 Reviewer B-1..B-6 / C-1..C-5 / N-1..N-2 全部条目，理由收敛到一轮防漂移 -->
<!-- 修订v3: lead 拍板——折叠 Reviewer v2 round 的 B-1..B-6 / C-1..C-3 / N-1，理由 spec/D6/smoke 一致性收敛 -->
<!-- 修订v4: lead 仲裁——锁定 §5.2 smoke / §3.3 env parser / §4+§8 redaction 边界，理由同类条目反复 3 轮未收敛，需移除 executor 自由度 -->
<!-- 修订v5: lead 拍板——折叠 Reviewer v4 round 的 B-1..B-3 / C-1..C-3 / N-1，理由收尾轮 final polish -->

> **Arbitration lock (v4).** §3.3 (env parser + testable helpers), §5.2
> (smoke script mechanics), and the §4/§8 redaction scope (including
> `src/gatewayClient.ts` edit) are now lead-locked. Executor must
> implement these exact mechanics. If a step appears infeasible, the
> executor **stops and reports to the lead** — they must not deviate,
> substitute, or "simplify" the locked behavior. Reviewer round-3
> blockers (B-1..B-5 + C-1/C-2 + N-1) have all been folded below with
> `修订v4` markers.

## 1. Context

`hive-mp-publish` ships a Commander CLI (`src/cli.ts`) and a `serve` subcommand
(`src/commands/serve.ts`) that today run only on Node ≥22.19. Two Node-only APIs
make the package unable to start under Bun without explicit shims:

- `node:sqlite` (`DatabaseSync`) is used directly by `src/apiKeyStore.ts` for
  the Gateway API-key/usage store. Bun ships an incompatible `bun:sqlite`
  module instead.
- `node:process` `loadEnvFile` is called from `src/cli.ts` for `--env-file`
  support. Bun does not expose it.

Other Bun-incompatible touch-points discovered while scoping:

- `undici` `ProxyAgent` / `setGlobalDispatcher` / `install` in `setupProxy`
  (Bun has its own `fetch` impl; `undici.install()` is a no-op or throws).
- `process.versions.node` only in `runDoctor` (works on Bun but reports
  Node's bundled version).
- `import.meta.main` is already supported on both runtimes; existing fallback
  via `fileURLToPath` covers Node ≤22 — keep as-is.

We want to publicly support **`bun ./dist/cli.js …`** as a first-class invocation
for users who already have Bun installed, without disturbing the npm `bin`
default of Node.

## 2. Decisions

The following points were debated in prior rounds and are now closed; do not
re-litigate during implementation.

- **D1. Two parallel runtimes, one source tree.** Source compiles once with
  `tsc` and the same `dist/` bundle is loaded by either runtime. No
  per-runtime build, no conditional `exports`.
- **D2. `npm install -g` ⇒ Node.** Keep `#!/usr/bin/env node` in `src/cli.ts`.
  The `bin` entry in `package.json` is unchanged. Bun users invoke
  `bun ./dist/cli.js …` explicitly; we do not register a `bunx` shim or a
  second bin.
- **D3. No single-file `bun build --compile` artifact this phase.** Not in
  scope, not advertised, not in CI. A follow-up plan may revisit it.
- **D4. SQLite stays synchronous.** `ApiKeyStore` keeps its synchronous
  constructor and synchronous public methods. The adapter lives behind a
  unified interface (`src/sqlite.ts`) and dispatches to `node:sqlite` or
  `bun:sqlite` at module load.
- **D5. Tests stay on `node --import tsx --test`.** The existing
  `tests/**/*.test.ts` suite is not ported to `bun:test`. Bun coverage is
  added as a separate smoke target, see §5.
<!-- 修订v3: lead 拍板（应 Reviewer v2 B-1）——D6 重写，与 §3.4 一一对齐，删掉"setupProxy invoked => warn-and-continue"的笼统说法 -->
- **D6. Proxy under Bun: split by source of the directive.**
  - If the user passes `--proxy` explicitly under Bun, `setupProxy`
    **fails closed** with a clear unsupported error (process exits
    non-zero). We never silently drop a user-supplied proxy URL.
  - If `--proxy` is *not* passed but one of `HTTPS_PROXY` / `HTTP_PROXY`
    / `https_proxy` / `http_proxy` / `ALL_PROXY` is set, `setupProxy`
    prints one redacted `[Proxy] Bun runtime detected; …` warning and
    continues, relying on Bun's native `fetch` handling of those env
    vars.
  - If neither is present, `setupProxy` is a no-op (same as Node).
  - The undici `ProxyAgent` / `install()` path remains the Node-only
    branch and is unchanged.
<!-- 修订v2: lead 拍板（应 Reviewer C-3）——D7 降级，TTL 不要求 Bun smoke 覆盖，理由 10min 等待不适合 CI -->
<!-- 修订v3: lead 拍板（应 Reviewer v2 B-5）——再降级，appSecret 持久化不变量从 Bun smoke 移除，留作 code review + Node tests 不变量；Bun smoke 仅覆盖 redaction + Gateway URL 鉴权边界 -->
- **D7. Security invariants are runtime-agnostic.** The runtime split is:
  - **Bun smoke covers, mechanically:** HTTPS-only Gateway URLs (except
    localhost / `--allow-insecure-http`); redaction of API keys /
    appSecret / access tokens through `redactSensitive` against a
    deterministic local mock server (§5.2 step 5); Gateway auth
    boundary via `/verify` 200/401 (§5.2 step 4).
  - **Node tests + code review cover (not Bun smoke):** no persistence
    of customer appSecret to disk anywhere (CLI never writes appSecret
    to the credential file when passed via `--app-secret` flag at
    publish time; serve never logs/persists request bodies). The Bun
    smoke does **not** scan DB or filesystem to prove this; the
    invariant is enforced at the source level and validated in
    `tests/cli.test.ts` / `tests/serve.test.ts` on Node.
  - **Node tests cover (not Bun smoke):** the 10-minute upload TTL
    (existing `tests/serve.test.ts`). Bun smoke does not wait out the
    window; it only verifies that the cleanup `setInterval(...).unref()`
    does not block process exit (covered by the SIGTERM check in §5.2
    step 4, addressing R2).

## 3. Approach

### 3.1 New thin runtime abstraction: `src/runtime.ts`

Responsibility: a single source of truth for "am I on Bun or Node" plus the
small handful of runtime-conditional helpers callers need.

<!-- 修订v2: lead 拍板（应 Reviewer B-1）——禁止裸 `Bun` 全局，统一走 globalThis 鸭子检测，理由 Bun 全局在 Node 上没有类型声明会让 tsc 红 -->
Exports (intent, not signatures):

- `isBun: boolean` — derived once at import time by duck-typing
  `(globalThis as { Bun?: unknown }).Bun !== undefined`. Do **not** reference
  the bare `Bun` global identifier in typed code; do **not** add `@types/bun`
  or any Bun type augmentation. Keep this module compilable on a vanilla
  Node + `@types/node` toolchain.
- `runtimeLabel(): string` — `"bun"` or `"node"`, used by `doctor`.
- `runtimeVersion(): string` — when `isBun`, read
  `(globalThis as { Bun?: { version?: string } }).Bun?.version` (fallback
  `"unknown"`); else `process.versions.node`.

Boundaries:

- Synchronous module. No top-level `await`. Imported anywhere, including from
  the synchronous `ApiKeyStore` constructor path.
- Does **not** import `node:sqlite`, `bun:sqlite`, or `undici`. Those belong to
  their own adapters so that the runtime detection module stays cheap and
  side-effect-free.

<!-- 修订v3: 修正——应 Reviewer v2 N-1，措辞改为 "loads via createRequire"，不说 "imports" -->
### 3.2 Unified SQLite adapter: `src/sqlite.ts`

Responsibility: expose one minimal interface that `apiKeyStore.ts` consumes,
backed by whichever SQLite built-in the host runtime ships — `node:sqlite`
on Node, `bun:sqlite` on Bun. The adapter **loads** the chosen built-in
through `createRequire` at runtime; it does **not** statically or
dynamically `import` either module name.

Interface shape (intent):

- `openDatabase(path: string): SqliteDatabase` — synchronous.
- `SqliteDatabase` exposes only `prepare(sql)`, `exec(sql)`, `close()`.
- `SqliteStatement` exposes `run(...params) → { changes, lastInsertRowid }`,
  `get(...params) → row | undefined`, `all(...params) → row[]`.
- Rows are plain objects with snake_case columns (matches today's `ApiKeyRow`
  / `UsageRow` typing — do **not** change column casing).
- `lastInsertRowid` is normalized to `number | bigint` in a way that
  `Number(result.lastInsertRowid)` is safe on both backends (matches today's
  use in `issueKey`).

<!-- 修订v2: lead 拍板（应 Reviewer B-1）——固定 createRequire + untyped require 方案，禁止 import("bun:sqlite") 静态/动态，理由 tsc 无法解析 bun:sqlite 类型且 dynamic import 会破坏同步构造 -->
Loading strategy (fixed — do not deviate):

- The adapter resolves its backend through
  `createRequire(import.meta.url)` from `node:module`, then calls
  `require(isBun ? "bun:sqlite" : "node:sqlite")`. The `require` return
  value is typed as `any` (or an explicit `unknown` then cast) at this
  call site; from there it is immediately narrowed into the local
  structural types described below.
- Do **not** write `import "bun:sqlite"` (static) anywhere — `tsc` cannot
  resolve `bun:sqlite` against `@types/node` and there is no acceptable
  type package to add.
- Do **not** write `await import("bun:sqlite")` (dynamic) either — it
  forces a top-level `await` or async path that breaks `ApiKeyStore`'s
  synchronous constructor invariant (D4).
- Both `node:sqlite` and `bun:sqlite` are runtime built-ins that
  `createRequire` resolves synchronously without touching the file
  system; this is the only path that keeps the constructor sync.

Local structural types (defined in `src/sqlite.ts`, **not** imported
from any backend):

- `SqliteRow = Record<string, unknown>`.
- `SqliteRunResult = { changes: number; lastInsertRowid: number | bigint }`.
- `SqliteStatement = { run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): SqliteRow | undefined;
  all(...params: unknown[]): SqliteRow[] }`.
- `SqliteDatabase = { prepare(sql: string): SqliteStatement;
  exec(sql: string): void; close(): void }`.

The adapter wraps whichever backend `require` returned and exposes only
the structural types above to `apiKeyStore.ts`. The Node and Bun backends
already match these shapes; the wrapper is mostly a passthrough plus a
single normalisation point for `lastInsertRowid` (cast through
`Number()` at the `issueKey` call site as today — adapter just promises
the value is castable).

Behavior parity that the adapter contract must guarantee:

- `prepare("PRAGMA foreign_keys = ON; …")` via `exec` works on both
  backends (Bun's `bun:sqlite` exposes `exec`; Node's `DatabaseSync`
  exposes `exec`).
- `INSERT … ON CONFLICT … DO UPDATE` works identically.
- `:memory:` paths are supported and skip the `mkdirSync` branch (already
  handled in `apiKeyStore.ts`; just confirm under Bun).

### 3.3 Env-file compatibility shim: `src/env.ts`

Responsibility: provide a `loadEnvFile(path: string): void` function that
mimics Node's `process.loadEnvFile` semantics for Bun.

<!-- 修订v3: lead 拍板（应 Reviewer v2 B-6）——Node 分支同样走 createRequire，禁止静态 named import "node:process"，理由保持单一边界规则 -->
Boundaries:

- Synchronous. Used during CLI option parsing right before subcommand
  bodies run.
- On Node: retrieve `loadEnvFile` via
  `createRequire(import.meta.url)("node:process").loadEnvFile` and call
  it. Do **not** write `import { loadEnvFile } from "node:process"`
  (static) or `await import("node:process")` (dynamic) — keep
  `src/env.ts` as the one module where Node's process API is touched,
  and do it through the same untyped `createRequire` path the sqlite
  adapter uses, so the two adapters look uniform.
<!-- 修订v2: lead 拍板（应 Reviewer B-3）——env 解析器扩到 Node dotenv basics（含 export 前缀与引号多行），并显式记录与 Node 的任何差异，理由用户实际 .env 多用 export 前缀和带引号值 -->
<!-- 修订v3: lead 拍板（应 Reviewer v2 B-3 / C-1）——重写 parser 规范严格对齐 Node 官方文档，不夸口 escape，引入 Node loadEnvFile 作为 oracle 测试 -->
- On Bun: read the file synchronously with `node:fs.readFileSync` (UTF-8)
  and parse with a grammar aligned to Node's documented `.env` semantics
  (https://nodejs.org/api/process.html#processloadenvfilepath). The
  scope is *what the executor will test against Node as oracle*, not a
  best-effort superset.

<!-- 修订v4: lead 拍板（应 Reviewer round-3 B-4）——注释规则改为"未引用 # 即开始注释"，不要求前置空白；不再承诺任何 backslash 转义 -->
  In scope (must implement and must round-trip against Node's parser
  through the §5.1 oracle tests):
  - Whitespace trimming around the key. Trailing whitespace on the
    *unquoted* value is stripped; whitespace inside quoted values is
    preserved.
  - Optional `export ` prefix on the key — ignored (i.e. `export
    KEY=value` is parsed as `KEY=value`).
  - Comments: a `#` at any position in an *unquoted* segment of a line
    starts a comment that runs to end of line. The `#` does **not**
    require preceding whitespace — `KEY=value#tail` parses with value
    `value` and a discarded `#tail` (matches Node). A `#` inside a
    single- or double-quoted value is part of the value.
  - Double-quoted values (`KEY="value"`) and single-quoted values
    (`KEY='value'`). Both may span multiple physical lines until the
    matching closing quote — the newline is preserved literally in the
    value.
  - Blank lines and lines without `=` are ignored.
  - Assignment into `process.env` **only when the key is not already
    set**, matching Node's documented "does not override existing env
    vars" rule.

  Out of scope (do **not** implement; document in the module header):
  - Variable interpolation (`KEY=$OTHER` or `${}` expansion).
  - Backslash escape sequences inside double-quoted values (`\n`, `\t`,
    `\\`, `\"`). The plan does *not* commit the shim to honor these
    because the executor will not test the exact escape semantics
    against Node's parser. The shim treats double-quoted content as
    literal between the delimiting quotes, the same as single-quoted.
    If a future need arises, escape handling is a follow-up plan with
    its own oracle test pass.
  - YAML-style block scalars, JSON-style object values, anything
    fancier than the above.

- File-missing behavior: throw an `Error` whose `code === "ENOENT"` and
  whose message contains the path, mirroring Node's shape, so the
  existing `runCommandWrapper` redaction path prints the same message
  under both runtimes.

- **Oracle-test rule (Reviewer C-1).** Every grammar case listed "in
  scope" above has a corresponding fixture line in
  `tests/fixtures/env-oracle.env`. The Node-side unit test (§5.1) loads
  this fixture twice — once through `process.loadEnvFile` and once
  through the shim's Node branch — and asserts identical `process.env`
  delta. The Bun smoke (§5.2 step 6) runs the same fixture through the
  shim under Bun and asserts the expected values. If Node's parser
  disagrees with our spec on any case, **Node wins** and the spec is
  amended in a follow-up plan.

<!-- 修订v4: lead 拍板（应 Reviewer round-3 B-3）——env.ts 必须暴露非产品 helper，使 Bun smoke 可以 bun -e import dist/env.js 直接断言 parser 行为，避免依赖 CLI 间接观察 -->
- **Testable helpers (Reviewer round-3 B-3).** `src/env.ts` must export
  two named helpers in addition to the product-facing
  `loadEnvFile(path)`:
  - `parseEnvContentForCompat(raw: string): Record<string, string>` —
    pure function. Takes the raw text content of a `.env` file and
    returns the parsed key/value map. **Does not** touch `process.env`,
    does not read the filesystem. Same grammar as above. This is the
<!-- 修订v5: 修正——应 Reviewer v4 N-1，"bun -e" 措辞替换为 parser-probe.mjs，与 §5.2 step 6.b 实际机制一致 -->
    surface the §5.1 oracle test diffs against `process.loadEnvFile`'s
    observable behavior (by loading the same fixture into a clean
    sub-`process.env`-like map for comparison), and the surface the
    Bun smoke imports from `dist/env.js` through the
    `<tmp>/parser-probe.mjs` driver described in §5.2 step 6.b.
  - `loadEnvFileCompat(path: string): Record<string, string>` — reads
    the file synchronously, parses through `parseEnvContentForCompat`,
    returns the parsed map. **Does not** assign into `process.env` —
    that's the product `loadEnvFile`'s job. The split exists so tests
    can assert raw parser output independent of the env-mutation
    side-effect.
  - These helpers are not part of the public package API (no
    re-export from `src/index.ts`), but they are not "internal only"
    either — the smoke script imports them from the built
    `dist/env.js`. This is allowed: it is not a new CLI surface, it
    is a testability hook.

`src/cli.ts` is updated (one import swap) to call this shim instead of
`loadEnvFile` from `node:process`. Source change is one line of imports
plus call site updates; no behavioral drift on Node.

### 3.4 Proxy gap: `setupProxy`

Today's `setupProxy` does `undici.ProxyAgent` + `setGlobalDispatcher` +
`install()`. On Bun, `undici` resolves but `install()` either no-ops or
trips because Bun's `fetch` is not Node's `globalThis.fetch`.

<!-- 修订v2: lead 拍板（应 Reviewer B-2 / C-2）——`--proxy` 显式传入 Bun 下 fail closed；只有 env 走 warn-and-continue；wording 收回到 HTTP_PROXY/HTTPS_PROXY，不提 NO_PROXY，理由静默继续会让用户以为代理生效 -->
Behavior under Bun (per D6, split by source of the proxy directive):

- **Explicit `--proxy` CLI option passed under Bun → fail closed.**
  `setupProxy` throws a clear, redacted error along the lines of
  `--proxy is not supported under the Bun runtime; use Node or set
  HTTPS_PROXY in your shell instead.` The error bubbles through
  `runCommandWrapper` and the process exits non-zero. We never silently
  drop a user-provided proxy URL.
- **Only `HTTPS_PROXY` / `HTTP_PROXY` / `https_proxy` / `http_proxy` /
  `ALL_PROXY` env var present under Bun → warn and continue.**
  Print one redacted line to `stderr`:
  `[Proxy] Bun runtime detected; HTTPS_PROXY / HTTP_PROXY rely on Bun's
  native fetch — undici-based interception is unsupported.` Do not
  attempt `undici.install()`. Continue execution. Whether the request
  actually egresses through the proxy is then a function of Bun's
  native fetch handling of those env vars — we make no stronger claim
  in the warning text (specifically, do **not** mention `NO_PROXY`
  unless Bun's docs explicitly confirm it).
- **No proxy directive at all under Bun** → no-op, no warning. Same as
  today on Node.

On Node: behavior unchanged. The undici `ProxyAgent` + `install()` path
remains the supported route on Node, including when `--proxy` is given.

### 3.5 `doctor` updates

`runDoctor` is the only user-visible runtime-aware surface besides the
warnings above:

- Add a `Runtime` check that prints `bun X.Y.Z` or `node vA.B.C`.
- Keep the existing minimum-Node check, but only `warn` (not `fail`) when
  running under Bun — Bun's reported `process.versions.node` is its
  shimmed value and not a real Node install.
<!-- 修订v2: 修正——应 Reviewer C-2 / C-4，wording 收回到 HTTPS_PROXY/HTTP_PROXY；doctor 编辑归 Zone B，不单独排序 -->
- Add a one-line note when `isBun` and any of `HTTPS_PROXY` /
  `HTTP_PROXY` / `https_proxy` / `http_proxy` / `ALL_PROXY` is set at
  doctor time, referencing the §3.4 caveat. Do not mention `NO_PROXY`.
- `doctor` edits live in Zone B (see §8); they do not get their own
  commit/order slot in §6.

## 4. Files to change

Source (new):

- `src/runtime.ts` — runtime detection + `runtimeLabel` / `runtimeVersion`.
<!-- 修订v3: 修正——应 Reviewer v2 N-1 / B-6，措辞改为 "loads via createRequire"，并要求 env.ts 在 Node 分支同样走 createRequire -->
- `src/sqlite.ts` — unified sync SQLite adapter; the only module that
  *loads* `node:sqlite` / `bun:sqlite` (via `createRequire`, never via
  `import`).
- `src/env.ts` — `loadEnvFile` shim; the only module that touches
  `node:process`'s `loadEnvFile`. The Node branch retrieves it via
  `createRequire(import.meta.url)("node:process").loadEnvFile`, never
  via a static `import { loadEnvFile } from "node:process"` (see §3.3).

Source (edit):

- `src/apiKeyStore.ts` — replace `import { DatabaseSync } from "node:sqlite"`
  and the `new DatabaseSync(dbPath)` call with the `src/sqlite.ts` adapter.
  No public API change. Constructor stays synchronous.
- `src/cli.ts` — swap `import { loadEnvFile } from "node:process"` for
  `import { loadEnvFile } from "./env.js"`. Update `setupProxy` per §3.4.
  Update `runDoctor` per §3.5. **Do not** touch the shebang.
<!-- 修订v4: lead 拍板（应 Reviewer round-3 B-5）——scope expansion，gatewayClient.ts 必须改造 error desc 的 redaction；理由不改 client 拿不到 customer appSecret/api-key 的确定性脱敏，security rule 要求 -->
<!-- 修订v5: lead 拍板（应 Reviewer v4 C-1）——redaction 必须覆盖 desc / message / error 三个字段，含 /upload 路径的 error 字段 -->
- `src/gatewayClient.ts` — **scope expansion (locked).** Remote
  Gateway response error fields must be passed through
  `redactSensitive` with an explicit `sensitiveValues` list before
  being thrown, logged, or surfaced to the user. **All three of**
  these user-visible fields the Gateway returns today are in scope:
  - `desc` (used by `/publish` and `/verify` 4xx/5xx — see
    `src/commands/serve.ts` `errorHandler` for the server side),
  - `message` (legacy / generic error message field that the
    `@wenyan-md/core` publishing pipeline can surface),
  - `error` (used by the `/upload` error path on the Gateway side
    when multer rejects a file).
  Any thrown `Error` whose message originated from a Gateway
  response body — regardless of which of the three fields the body
  put the text in — must be redacted at the `gatewayClient` layer
  before propagating. The `sensitiveValues` list must include at
  minimum:
  - the resolved API key (whatever value was sent in the `x-api-key`
    header for this request — `--api-key` flag, env var, or stored
    credential),
  - the resolved appSecret (whatever value was sent in the publish
    payload — `--app-secret` flag, env var, or credential store
    lookup from `credentialStore`),
  - any explicit `--app-secret` option value (covers the case where
    the resolved value is loaded asynchronously after the request
    started).
  Coverage of `error` (upload path) is verified by a **targeted
  Node-side unit test** added in Zone B alongside the
  `gatewayClient.ts` edit: it constructs a fake Gateway HTTP
  response whose body is `{ error: "rejected hmp_live_… and
  smoke_app_secret" }` and asserts the thrown error message
  contains neither raw value and contains `[REDACTED]`. The Bun
  smoke (§5.2 step 5) continues to cover `desc` mechanically; if
  the executor finds the CLI upload flow easy to exercise under
  Bun, they may extend the mock with a `/upload` 4xx case and add
  an `error`-field assertion there, but it is not required because
  the Node unit test is the source of truth for this field.
  `src/security.ts` itself is **not** edited — its `redactSensitive`
  helper already supports the `sensitiveValues` parameter; only the
  caller in `src/gatewayClient.ts` changes. This is the only file
  outside the abstraction set that this plan modifies; it moves into
  Zone B (see §8).
- `src/commands/serve.ts` — no functional changes expected; verify it
  picks up the new `ApiKeyStore` transparently. If `installInMemoryAccessTokenCache`
  uses any Node-only `setTimeout`/`unref` semantics that diverge on Bun
  (`setInterval(...).unref()` is used here), validate during smoke and
  document — do not preemptively rewrite.

Tooling / packaging:

- `package.json`
  - Keep `"engines": { "node": ">=22.19.0" }`. Do **not** add a Bun
    engines pin; users can verify with `doctor`.
<!-- 修订v2: lead 拍板（应 Reviewer N-2）——test:bun:smoke 先 build 再跑，理由 smoke 假设 ./dist/cli.js 存在 -->
  - Add scripts (names exact, used by smoke and CI):
    - `"test:bun:smoke"` — `pnpm build && bun scripts/bun-smoke.mjs`.
      The chained `pnpm build` is mandatory so the script's `./dist/cli.js`
      assumption holds whether invoked locally or in CI.
    - Optional: `"cli:bun"` — `bun ./src/cli.ts` for local dev.
  - No new dependency. `bun:sqlite` / `node:sqlite` are built-ins.

- `scripts/bun-smoke.mjs` (new) — see §5.

- `.github/workflows/ci.yml` — add a parallel Bun job. See §5.

<!-- 修订v2: lead 拍板（应 Reviewer C-5）——docs 边界明确包含 first-trial-walkthrough.md 与 install/hive-mp-publish.md，以 Node-first + Bun 备注的方式更新，理由这两个文档是新用户首屏路径 -->
Docs:

- `README.md` — add a short "Running with Bun" subsection under usage:
  installation note, the exact `bun ./dist/cli.js …` invocation pattern,
  and the proxy caveat from §3.4.
- `docs/deployment.md` and `docs/server.md` — add a one-paragraph note
  that the `serve` subcommand works under Bun for the same `--help`,
  `--db`, `--env-file` flags; recommend Node for production until Bun
  parity is observed in the wild.
- `docs/first-trial-walkthrough.md` — remains the Node-first
  walkthrough. Add a short callout near the top: *"This walkthrough
  uses Node. If you already have Bun installed and prefer to use it,
  the equivalent commands replace `node ./dist/cli.js` with `bun
  ./dist/cli.js`; see §Running with Bun in the README."* No
  command-by-command duplication.
- `install/hive-mp-publish.md` — same treatment: keep it Node-first
  (matches the npm `bin` default), add the same one-paragraph callout
  pointing at the README's Bun section. Do **not** rewrite the
  installer to attempt Bun detection.
<!-- 修订v4: 修正——应 Reviewer round-3 N-1，AGENTS 措辞改为 "loaded via createRequire"，不说 "imported" -->
- `AGENTS.md` — list the new runtime abstraction modules
  (`src/runtime.ts`, `src/sqlite.ts`, `src/env.ts`) and the rule that
  `node:sqlite` / `bun:sqlite` / `node:process.loadEnvFile` are only
  *loaded* (via `createRequire`) from those modules. AGENTS.md must
  not describe them as "imported" — `import` syntax against those
  specifiers is forbidden by §3.2 / §3.3.

Out of scope (explicitly listed so executor does not drift):

- No `bun build --compile`, no single-file binary, no second `bin` entry.
- No port of tests from `node --test` to `bun:test`.
- No replacement of `undici` with a runtime-agnostic HTTP client.
- No `package.json` `exports` rework.
- No change to wire formats, SQLite schema, or migration logic.

## 5. Test and CI plan

### 5.1 Existing Node tests

Unchanged. `pnpm test` continues to run `node --import tsx --test
"tests/**/*.test.ts"`. New modules (`runtime.ts`, `sqlite.ts`, `env.ts`)
get Node-side unit tests in `tests/`:

- `tests/runtime.test.ts` — asserts `isBun === false` under Node, label
  and version reporting.
- `tests/sqlite.test.ts` — opens an in-memory DB, exercises
  `prepare/run/get/all/exec`, asserts row shape and `lastInsertRowid`
  normalization.
<!-- 修订v3: lead 拍板（应 Reviewer v2 C-1）——env 单测扩到 comments + multiline + 共享 oracle fixture -->
<!-- 修订v4: lead 拍板（应 Reviewer round-3 B-3 / B-4）——单测改为对比 parseEnvContentForCompat 与 process.loadEnvFile 的可观察 delta；fixture 加入 KEY=value#tail（无前置空白）和 KEY=  value 之类的注释 case -->
- `tests/env.test.ts` — diff `parseEnvContentForCompat(fs.readFileSync(
  "tests/fixtures/env-oracle.env", "utf-8"))` against the observable
  delta produced by Node's `process.loadEnvFile` on the same fixture
  (the test compares values key-by-key for keys that the fixture
  introduces, using a save/restore of `process.env` around the Node
  oracle call). Cases covered, one fixture line each:
  - whitespace-trim around key,
  - `export` prefix,
  - whole-line comment (`# …`),
  - inline `#` comment with **no** preceding whitespace
    (`KEY=value#tail` → value is `value`, **not** `value#tail`),
  - inline `#` comment with preceding whitespace
    (`KEY=value #tail` → value is `value`),
  - single-quoted value,
  - double-quoted value,
  - single-quoted multiline value,
  - double-quoted multiline value,
  - `#` inside a quoted value (must be preserved as content),
  - "does not override existing env" rule (Node sets var first, then
    fixture line tries to override),
  - ENOENT shape on missing file (`loadEnvFileCompat("/missing/path")`).
  This same fixture is the one §5.2 step 6 reuses for the Bun smoke,
  giving Node-Bun parity by construction.

### 5.2 Bun smoke script: `scripts/bun-smoke.mjs`

<!-- 修订v2: lead 拍板（应 Reviewer B-4 / B-5 / B-6 / C-1 / N-1）——smoke 重写：env 隔离、唯一 tmp、env-file 用例、serve 不在 verify 前 revoke、安全用例机械化 -->
<!-- 修订v4: 修正——应 Reviewer round-3 B-1，§5.2 intro 不再使用 `bun ./dist/cli.js` 字面，改为常量描述 -->
A self-contained script (executable under either runtime; we invoke
with `bun` in CI). It spawns the CLI as a child process through the
`${bunBin} ${cliJs}` (and, where noted, `${nodeBin} ${cliJs}`) constants
defined in Step 0; no shell snippet in this section uses the raw
relative path. No test framework — exit code 0 on success, non-zero
with a diagnostic on failure. Coverage:

<!-- 修订v3: lead 拍板（应 Reviewer v2 B-2 / C-2）——绝对路径 + 端口分配机械化，cwd 仍用唯一 tmp 做 env 隔离 -->
<!-- 修订v4: lead 拍板（应 Reviewer round-3 B-1 / C-2）——绝对常量集扩到 nodeBin + bunBin，移除所有 ./dist/cli.js / node ./dist/cli.js / tests/publish.md / tests/manhua.css 出现位置；端口措辞去掉"guaranteed closed port"，改用 live mock servers 绑 0；加 grep 审查 guard -->
**Step 0 — Test isolation (always runs first).**

- **Path constants (mandatory).** Compute `repoRoot` from
  `import.meta.url` (`fileURLToPath` then `path.resolve("..", "..")`
  relative to `scripts/bun-smoke.mjs`). Define exactly six constants at
  the top of the smoke script:
  - `repoRoot` — absolute path to the repository root.
  - `cliJs` — `path.join(repoRoot, "dist", "cli.js")`.
  - `fixturePublishMd` — `path.join(repoRoot, "tests", "publish.md")`.
  - `fixtureManhuaCss` — `path.join(repoRoot, "tests", "manhua.css")`.
  - `nodeBin` — `process.execPath` when the smoke runs under Node, or
    the resolved `node` binary discovered via `which`/`where` when it
    runs under Bun (Bun ships its own `process.execPath` pointing at
    `bun`).
  - `bunBin` — `"bun"` (relying on `$PATH`), or `process.execPath` when
    the smoke itself is running under Bun, whichever the script's
    bootstrap resolves first.
  Every child-process invocation below references these constants by
  name. No invocation relies on the child's `cwd` resolving
  repo-relative paths.
<!-- 修订v5: 修正——应 Reviewer v4 C-3，明示 grep 守卫只覆盖 `scripts/bun-smoke.mjs` 与 §5.2 plan snippets；README/docs 等 user-facing 文档仍可使用真实 `bun ./dist/cli.js` 字面命令 -->
- **Forbidden literals (review guard, scoped).** The grep guard
  applies to exactly two surfaces: (1) the smoke implementation file
  `scripts/bun-smoke.mjs`, and (2) command snippets in §5.2 of this
  plan. Within those surfaces, the literals `./dist/cli.js`,
  `node ./dist/cli.js`, `bun ./dist/cli.js`, `tests/publish.md`, and
  `tests/manhua.css` are forbidden except in this paragraph (which
  enumerates them) and in `修订` markers that quote the rule. Every
  command description in §5.2 below uses the constants above written
  as JS template-literal interpolations (`${bunBin} ${cliJs} --help`,
  `${nodeBin} ${cliJs} key list …`, etc.). The guard explicitly does
  **not** apply to user-facing documentation surfaces — `README.md`,
  `docs/first-trial-walkthrough.md`, `install/hive-mp-publish.md`,
  `docs/deployment.md`, `docs/server.md`, `AGENTS.md`, §1 / §2 / §4
  / §6 prose of this plan — which legitimately quote `bun
  ./dist/cli.js …` as the exact command users type.
- **Unique temp dir for child cwd / writable artifacts.** Create one
  temp directory per smoke run via
  `fs.mkdtempSync(path.join(os.tmpdir(), "hive-mp-bun-smoke-"))`. All
  files *written* by the smoke (SQLite DBs, `.env` files, mock server
  state) live inside this directory. Children spawn with `cwd` set to
  the temp dir purely for env isolation (Bun auto-loads any `.env`
  found in `cwd` — the temp dir has none). The child never has to
  look up repo files via `cwd`.
<!-- 修订v5: lead 拍板（应 Reviewer v4 B-2）——child env 必须重定向 HOME/XDG_CONFIG_HOME 等用户配置根，避免 @wenyan-md/core configDir 读到/写到真实用户配置 -->
- **Scrubbed + redirected child env.** Strip any variable matching
  `/^HIVE_MP_/i`, `/^WECHAT_/i`, plus `HTTPS_PROXY`, `HTTP_PROXY`,
  `https_proxy`, `http_proxy`, `ALL_PROXY`. Combined with the
  empty-`.env` `cwd`, the child sees a known-empty baseline;
  individual steps below add back exactly the vars they need.
  Additionally, **redirect every config-resolving env var into the
  temp dir** so neither the CLI nor `@wenyan-md/core`'s `configDir`
  lookup can read or write the real user profile:
  - Pre-create `<tmp>/home` and `<tmp>/xdg` (and `<tmp>/uploads`,
    `<tmp>/dbs` if used by step 4) via `fs.mkdirSync(...,
    { recursive: true })` before any child spawn.
  - In the child env, force:
    - `HOME=<tmp>/home`
    - `XDG_CONFIG_HOME=<tmp>/xdg`
    - `XDG_DATA_HOME=<tmp>/xdg`
    - `XDG_CACHE_HOME=<tmp>/xdg`
    - `APPDATA=<tmp>/xdg` (no-op on Linux CI, but keeps the script
      sane if a developer runs it on Windows locally)
    - `HIVE_MP_CREDENTIAL_PATH=<tmp>/credential.json` (forces the
      `src/gatewayConfig.ts` credential file off the real path; see
      `getCredentialPath`).
    - `HIVE_MP_GATEWAY_DB=<tmp>/default-gateway.sqlite` (forces
      `getDefaultGatewayDbPath` off the real path; individual `--db`
      flags in steps 3/4 still override this).
  - **Invariant.** Every SQLite DB, every `.env` file, every upload
    artifact, every credential file the smoke causes the CLI to read
    or write must reside under the unique `<tmp>` root. After the
    smoke exits (success or failure) the temp dir is torn down; if
    the smoke ever ends up touching `$HOME` or the real user
    profile, that is a bug against this step.
- **No hard-coded paths.** No `/tmp/bun-smoke*.sqlite` literals — they
  collide on parallel CI runners.
- **Port allocation helper (Reviewer round-3 C-2).** Define one helper
  `acquireFreePort()` that opens a `node:net` server on port `0`,
  reads `address().port`, closes the server, returns the integer.
  Usage rules:
  - For **live mock Gateway servers** (§5.2 step 5 and §5.2 step 6):
    do **not** pre-allocate via `acquireFreePort()` and then re-bind.
    Instead, bind the mock server itself to port `0`, then read
    `server.address().port` after `listen` resolves, and feed that
    port number to the CLI subprocess via `--server
    http://localhost:<port>` or via the env-file content. This is
    race-free and is the locked mechanism — the plan no longer
    references a "guaranteed closed port" surface.
  - For the **`serve` subprocess** (§5.2 step 4) where the CLI's
    `--port` requires a concrete integer before the server binds,
    call `acquireFreePort()` and pass the result; on `EADDRINUSE`,
    retry up to 3 times with a freshly allocated port. The race
    window is acceptable for a CI smoke and the retry budget caps
    tail latency.

<!-- 修订v4: 修正——应 Reviewer round-3 B-1，全部命令改写为常量形式 -->
1. **`--help` / `--version` smoke.** `${bunBin} ${cliJs} --help` exits
   0, stdout includes `Usage:`. `${bunBin} ${cliJs} --version` prints
   the package version from `package.json`.

<!-- 修订v5: 修正——应 Reviewer v4 B-3，Step 2 漏改的 `bun <cliJs>` 同步替换为 `${bunBin} ${cliJs}` 模板字面 -->
2. **`render` smoke.** `${bunBin} ${cliJs} render -f
   ${fixturePublishMd} -c ${fixtureManhuaCss} --no-mac-style` exits
   0, stdout includes `<section` (sanity that the wenyan renderer
   ran). Paths are absolute per Step 0.

<!-- 修订v4: 修正——应 Reviewer round-3 B-1，命令改写为常量形式（${bunBin} ${cliJs} / ${nodeBin} ${cliJs}） -->
3. **`key issue / list / revoke` against a temp SQLite file (DB-A).**
   - Path: `<tmp>/keys.sqlite` (call this DB-A).
   - `${bunBin} ${cliJs} key issue --name smoke --db DB-A --json` →
     captures `id` and `key`; asserts DB-A exists; asserts the key
     matches `^hmp_(live|test)_`.
   - `${bunBin} ${cliJs} key list --db DB-A --json` → length ≥ 1,
     `currentMonthRequests === 0`, listed `id` matches the issued one.
   - `${bunBin} ${cliJs} key revoke --id <id> --db DB-A --json` →
     `{ revoked: true }`.
   - **DB-A is dedicated to issue/list/revoke.** It is *not* reused by
     the `serve` step (B-5 fix from round 1).
   - Cross-runtime DB readability check: spawn `${nodeBin} ${cliJs} key
     list --db DB-A --json` after the Bun revoke and assert it parses
     the same data. Proves on-disk format parity between
     `bun:sqlite` and `node:sqlite`.

<!-- 修订v4: 修正——应 Reviewer round-3 B-1，命令改写为常量形式 -->
4. **`serve` lifecycle (DB-B, fresh key kept active for /verify).**
   - Path: `<tmp>/serve.sqlite` (DB-B, *separate* from DB-A).
   - Pre-seed by running `${bunBin} ${cliJs} key issue --name serve-smoke
     --db DB-B --json` → capture `key` as `SERVE_KEY`. Do **not**
     revoke this key before `/verify` (B-5 from round 1).
   - Allocate `<servePort>` via `acquireFreePort()` (with up to 3
     `EADDRINUSE` retries per Step 0). Launch `${bunBin} ${cliJs} serve
     --port <servePort> --db DB-B` in the background, redirecting
     stderr to a captured buffer.
   - Poll `GET http://localhost:<servePort>/health` until 200 (5s
     timeout). Assert `{ status: "ok" }`.
   - `GET /verify` with header `x-api-key: SERVE_KEY` → 200,
     `success: true`, `key.prefix` matches `SERVE_KEY.slice(0, 14)`.
   - `GET /verify` with header `x-api-key: hmp_live_bogus_BOGUSBOGUSBOGUS`
     → 401.
   - (Optional, after the two `/verify` assertions succeed) issue a
     second key and revoke it via `${bunBin} ${cliJs} key revoke --id
     <id2> --db DB-B --json` to exercise revoke against the live
     serve DB, then assert a follow-up `/verify` with that second key
     → 401. The original `SERVE_KEY` stays active throughout.
   - Send `SIGTERM`; assert the process exits within 5s (this also
     covers the cleanup-interval `.unref()` risk R2 and the TTL
     downgrade in D7).

<!-- 修订v3: lead 拍板（应 Reviewer v2 B-5）——redaction 用本地确定性 mock server 触发，不再依赖 connection-refused 错误链能否带出 secrets -->
<!-- 修订v4: lead 拍板（应 Reviewer round-3 B-5 / C-1）——mock 用 Bun 进程内 node:http（不再启独立 Node 子进程）；redaction 改由 gatewayClient.ts 已知敏感值列表注入，断言原文不漏 + 含 [REDACTED] / [REDACTED_API_KEY] -->
5. **Security invariants — mechanical assertions (B-5 / B-6).**
   All `publish` invocations here pass deterministic fakes so URL /
   parameter validation is the *first* gate reached. Use:
   - `--app-id smoke_app_id`
   - `--app-secret smoke_app_secret`
   - `--api-key hmp_live_SMOKEKEY_SMOKEKEY_SMOKEKEY` (matches
     `KEY_PATTERN` so any echo through `redactSensitive` triggers).

   **Mock Gateway server — in-process, under Bun.** The smoke script
   itself runs under Bun in CI (per §5.3); the mock server is spawned
   *inside the same Bun process* via Bun's Node-compatible `node:http`
   API. There is no separate Node child process for the mock. Bind to
   port `0` and read `server.address().port` after `listen` resolves
   (per Step 0 port rules); feed the resolved port to the CLI
   subprocess via `--server http://localhost:<port>`. Routes:
   - `GET /health` → 200 `{ status: "ok" }`.
   - `GET /verify` → 200 `{ success: true, key: { id: 1, name:
     "smoke", prefix: "hmp_live_SMOKE" } }` (no auth check; the
     smoke does not test the gateway's own auth here).
   - `POST /upload` → 200 `{ success: true, data: { fileId:
     "smoke-file-id" } }`.
   - `POST /publish` → 500 `{ code: -1, desc: "bad
     hmp_live_SMOKEKEY_SMOKEKEY_SMOKEKEY smoke_app_secret in
     payload" }`. The body deliberately echoes both the fake API key
     and the fake appSecret so we have a deterministic surface for
     the CLI's redaction path to act on.

   Assertions:
   - **HTTPS-only enforcement.** `${bunBin} ${cliJs} publish --server
     http://example.com -f ${fixturePublishMd} <fakes>` exits non-zero;
     stderr contains the literal substring `HTTPS` and does **not**
     contain the raw appSecret string.
   - **Localhost exemption.** Allocate one fresh ephemeral port via
     `acquireFreePort()` (this port is *not* used to bind anything —
     it serves only as a localhost target that will refuse connection
     for this assertion). `${bunBin} ${cliJs} publish --server
     http://localhost:<port> -f ${fixturePublishMd} <fakes>` exits
     non-zero (connection refused) but the error message does **not**
     contain the substring `HTTPS` — proving the URL check passed and
     we reached the network layer.
   - **Redaction parity — anchored to the live mock.** `bunBin
     <cliJs> publish --server http://localhost:<mockPort> -f
     ${fixturePublishMd} --allow-insecure-http <fakes>` exits non-zero
     because the mock `/publish` returns 500 with the leaked
     substrings. Assert combined stderr+stdout:
     - does **not** contain the raw API-key string
       `hmp_live_SMOKEKEY_SMOKEKEY_SMOKEKEY`, and
     - does **not** contain the raw `smoke_app_secret`, and
     - contains `[REDACTED_API_KEY]` (from the regex pattern
       redaction in `src/security.ts`) **and** contains the literal
       `[REDACTED]` token at least once (from the known-sensitive-
       value substitution that `src/gatewayClient.ts` will install on
       Gateway error descriptions — see B-5 scope expansion in §4 /
       §8).
   - These three assertions together pin the security invariant: the
     CLI never echoes raw API keys or appSecret to the user's
     terminal, regardless of what the remote Gateway puts in an error
     description. The mock is the deterministic anchor.

<!-- 修订v3: lead 拍板（应 Reviewer v2 B-4 / C-1）——env-file smoke 不引入新 CLI surface，通过 publish Gateway 路由选择来观察 env 是否被加载，no-override 用预置 env 端口偏离来确认，oracle fixture 复用 -->
<!-- 修订v4: lead 拍板（应 Reviewer round-3 B-2 / B-3 / C-1）——env-file URL 证据切换为两台 live mock Gateway（envFileGateway 与 presetGateway），断言哪台接到 /health；parser parity 直接 bun -e import dist/env.js 调用 parseEnvContentForCompat，不再需要 probe server；移除 closed-port 推断 -->
6. **`--env-file` smoke (mechanical through live mock Gateways +
   helper-direct parser assertion).**

   This step now has two independent halves: a **URL-routing proof**
   that the env file's contents reach the publish path (no closed-port
   reasoning), and a **parser-parity proof** that calls the exported
   `parseEnvContentForCompat` helper directly under Bun.

<!-- 修订v5: lead 拍板（应 Reviewer v4 B-1）——每个 subcase 起独立 mock Gateway 对，禁止跨 subcase 共享 log，避免上一轮请求污染下一轮断言 -->
   **6.a. URL-routing proof — fresh live mock Gateway pair per
   subcase.**

   Each subcase below (loaded-env, no-override, ENOENT) launches its
   own pair of in-process mock Gateway servers via the same Bun
   `node:http` pattern from §5.2 step 5. Each pair is bound to port
   `0` (read `server.address().port` after `listen`), services the
   single child spawn, then is closed before the next subcase starts.
   Per-subcase server names within this section: `envFileGateway`
   (port `${envFileGwPort}`) and `presetGateway` (port
   `${presetGwPort}`). Each server records every request it receives
   (method, path, `x-api-key` header) into its own in-memory log;
   logs are **never** carried across subcases. Both servers in a
   pair respond to all routes with the same shape as step 5's mock
   — the point is to observe *which* server the CLI hit, not what
   the server returned. (`resetLogs()` is therefore unnecessary;
   fresh instances are the locked mechanism.)

   - **Per-subcase setup.** Each of the three subcases below begins by
     constructing a fresh pair `(envFileGateway, presetGateway)` —
     each bound to port `0`, each with its own empty in-memory
     request log — and ends by closing both servers. The
     `envFileGwPort` / `presetGwPort` values for one subcase are not
     reused by the next; the env-file written for each subcase
     references the port that subcase just allocated.
   - **Fixture reuse.** Each subcase copies
     `tests/fixtures/env-oracle.env` (see §5.1) into a fresh
     per-subcase env file (e.g. `${tmpDir}/smoke-loaded.env`,
     `${tmpDir}/smoke-noverride.env`) and *appends* the
     publish-driving keys, so the same fixture body drives all three
     subcases.
   - **Loaded-env subcase.** Spin up its own
     `(envFileGateway, presetGateway)` pair. Append to
     `${tmpDir}/smoke-loaded.env`:
     - `HIVE_MP_GATEWAY_URL=http://localhost:${envFileGwPort}`
     - `HIVE_MP_API_KEY=hmp_live_SMOKEKEY_SMOKEKEY_SMOKEKEY`
     - `WECHAT_APP_ID=smoke_app_id`
     - `WECHAT_APP_SECRET=smoke_app_secret`
     Spawn `${bunBin} ${cliJs} publish -f ${fixturePublishMd}
     --env-file ${tmpDir}/smoke-loaded.env --allow-insecure-http`
     with **no** `--server` / `--api-key` / `--app-id` /
     `--app-secret` flags, and with the scrubbed child env from
     Step 0 (so neither `HIVE_MP_GATEWAY_URL` nor `WECHAT_APP_ID` is
     preset). Assert:
     - `envFileGateway`'s request log received at least one request
       (`/health` and/or `/verify` and/or `/publish` — exact path
       depends on the CLI's Gateway flow; only the presence of *any*
       request on `envFileGateway` is asserted).
     - `presetGateway`'s request log is empty (no env var was set, so
       the CLI must have used the env-file value).
     - Combined CLI stderr+stdout does **not** contain a "missing
       --api-key / --server / --app-id" style error — that would
       mean `--env-file` was not loaded at all.
     Close both servers before proceeding.
   - **No-override subcase.** Spin up its own *new*
     `(envFileGateway, presetGateway)` pair (fresh ports, fresh
     logs). Write `${tmpDir}/smoke-noverride.env` with
     `HIVE_MP_GATEWAY_URL=http://localhost:${envFileGwPort}` (and
     the same other publish-driving keys). Spawn the same command
     against that env file, but plant
     `HIVE_MP_GATEWAY_URL=http://localhost:${presetGwPort}` in the
     child env. After the child exits, assert:
     - `presetGateway`'s request log received at least one request.
     - `envFileGateway`'s request log is empty (the env-file did
       **not** override the preset env var; matches Node's documented
       rule).
     Close both servers before proceeding.
   - **ENOENT subcase.** Spin up its own *new*
     `(envFileGateway, presetGateway)` pair. Spawn `${bunBin}
     ${cliJs} publish -f ${fixturePublishMd} --env-file
     ${tmpDir}/nope.env --server
     http://localhost:${envFileGwPort} --allow-insecure-http
     ${fakes}` and assert: process exits non-zero **before** any
     Gateway connection attempt; stderr contains `ENOENT` and the
     missing path; **both** mock Gateway request logs are still
     empty (the ENOENT path pre-empted the network call). Close
     both servers.

<!-- 修订v5: 修正——应 Reviewer v4 N-1，heading 从 "bun -e" 改为 parser-probe.mjs 措辞 -->
   **6.b. Parser-parity proof — `parser-probe.mjs` against
   `dist/env.js`.**

   This sub-step does not go through the CLI surface and does not
   require a probe server. It asserts that the Bun runtime parses the
   in-scope grammar identically to Node's `process.loadEnvFile` by
   invoking the exported helper directly:

   - The smoke script writes a small one-liner driver to
     `<tmp>/parser-probe.mjs`:
     ```
     import { parseEnvContentForCompat } from "${repoRoot}/dist/env.js";
     import { readFileSync } from "node:fs";
     const out = parseEnvContentForCompat(
         readFileSync(process.argv[2], "utf-8"));
     process.stdout.write(JSON.stringify(out));
     ```
<!-- 修订v5: 修正——应 Reviewer v4 B-3，spawn 命令改写为 `${bunBin}` + 路径常量风格 -->
   - Spawn `${bunBin} ${tmpDir}/parser-probe.mjs
     ${repoRoot}/tests/fixtures/env-oracle.env` and capture stdout.
     Parse the JSON.
<!-- 修订v5: lead 拍板（应 Reviewer v4 C-2）——窄化 Bun helper 断言范围：smoke 只断言下列具名键；whole-fixture 全语法 parity 仍由 §5.1 Node oracle 兜底 -->
   - **Scope of this Bun assertion.** The Bun helper-call covers the
     explicit list of keys below — these are the grammar cases we
     mechanically verify under Bun. Full-fixture parity against
     Node's `process.loadEnvFile` (including any case not listed
     here) is covered by the §5.1 Node oracle test, not this step.
     Assert the parsed map has the expected keys with expected
     values for:
     - `HIVE_MP_SMOKE_EXPORT` (export prefix)
     - `HIVE_MP_SMOKE_WHITESPACE_TRIM` (whitespace-trim around key
       and trailing whitespace on unquoted value)
     - `HIVE_MP_SMOKE_SQUOTE` (single-quoted)
     - `HIVE_MP_SMOKE_DQUOTE` (double-quoted)
     - `HIVE_MP_SMOKE_SQUOTE_MULTILINE` (single-quoted multiline)
     - `HIVE_MP_SMOKE_DQUOTE_MULTILINE` (double-quoted multiline)
     - `HIVE_MP_SMOKE_HASH_INSIDE_QUOTES` (`#` preserved inside
       quotes)
     - `HIVE_MP_SMOKE_INLINE_COMMENT_NOSPACE` (`KEY=value#tail` →
       `value`, B-4)
     - `HIVE_MP_SMOKE_INLINE_COMMENT_WITH_SPACE` (`KEY=value #tail`
       → `value`)
     And assert *absent* from the parsed map:
     - `HIVE_MP_SMOKE_COMMENTED_OUT` (a whole-line `#`-prefixed key
       must not appear)
     - `HIVE_MP_SMOKE_BLANK_LINE_PROBE` and any key that the fixture
       only mentions on a `=`-less line (blank-line / no-`=`
       skipping)
   - This is the locked mechanism. Executor must not substitute a
     probe-server based approach or "rely on §5.1 only" — the helper
     export is mandatory (§3.3 v4) precisely so this assertion is
     mechanical under Bun.

<!-- 修订v4: 修正——应 Reviewer round-3 B-1，命令改写为常量形式；目标 URL 改为 https://localhost:<acquireFreePort()> 表示一个无服务监听的端口 -->
7. **Proxy warning / error (B-6 + B-2 anchored to `publish`).**
   `setupProxy` is only wired through the `publish` subcommand, so all
   proxy assertions go through `publish` (not `render` / `serve` /
   `--help`). For both sub-cases the target URL uses a fresh
   `acquireFreePort()` value as the localhost port (nothing is
   listening there at that moment — Step 0 documents the rule).
   - **Explicit `--proxy` under Bun fails closed.** `${bunBin} ${cliJs}
     publish --server https://localhost:<freePort> --proxy
     http://127.0.0.1:1 -f ${fixturePublishMd} <fakes>` exits non-zero;
     stderr contains a message indicating `--proxy` is unsupported
     under Bun and does **not** include `[Proxy] Bun runtime detected`
     (because the warning path is for env-only, not explicit-flag).
   - **`HTTPS_PROXY` env under Bun warns and continues to the URL /
     network stage.** Spawn `${bunBin} ${cliJs} publish --server
     https://localhost:<freePort> -f ${fixturePublishMd} <fakes>` with
     `HTTPS_PROXY=http://127.0.0.1:1` in the child env (overriding
     the scrub from Step 0 for this case only). Assert stderr
     contains the `[Proxy] Bun runtime detected` warning line *and*
     the process proceeded past `setupProxy` (i.e. it ultimately
     fails for connection-refused, not for the proxy unsupported
     error).

The script is the single executable artifact for "does Bun still
work"; keep it strictly under ~400 lines so it stays reviewable.

### 5.3 CI

Add a second job `test-bun` to `.github/workflows/ci.yml`:

- `runs-on: ubuntu-latest`.
- Same checkout + pnpm + Node setup as today (Node is still needed to
  install deps and build `dist/`).
- Adds `oven-sh/setup-bun@v2` with a pinned version (executor: pick the
  latest stable Bun at implementation time, write the exact version
  here).
<!-- 修订v2: 修正——应 Reviewer N-2，明确 build 后再 smoke -->
- Steps: `pnpm install --frozen-lockfile` → `pnpm build` →
  `bun scripts/bun-smoke.mjs`. Equivalent to `pnpm test:bun:smoke`
  locally; CI splits them so build cache hits are observable in the
  Actions log.
- The Bun job runs in parallel with the existing `test` job. Both gate
  PR merges.
- Do **not** add Bun to the release workflow yet; release still goes
  through Node-only `prepublishOnly`.

## 6. Rollout and docs

<!-- 修订v2: lead 拍板（应 Reviewer C-4）——doctor 更新合进 Zone B 的 cli.ts 提交，不单独列条目，理由 doctor 仅住 cli.ts 内 -->
Order of merges (executor should keep these as separate commits within
the same PR for clean review):

1. New modules `src/runtime.ts`, `src/sqlite.ts`, `src/env.ts` + their
   Node-side unit tests. Repo still builds and tests pass on Node only.
2. `src/apiKeyStore.ts` + `src/cli.ts` swap to the new modules,
   `setupProxy` Bun behavior (§3.4), and the `runDoctor` updates
   (§3.5) all land together — `doctor` lives entirely inside
   `src/cli.ts` so it shares this commit. Existing Node tests still
   pass.
3. `scripts/bun-smoke.mjs` + CI job + README/docs notes.

User-facing rollout:

- README "Running with Bun" stays small: one paragraph + a code block
  showing `bun ./dist/cli.js --help`, plus a callout pointing at the
  proxy caveat.
- No CHANGELOG-breaking changes. Version can bump patch
  (`0.1.2 → 0.1.3`) when this lands.
- `doctor` becomes the recommended self-check for new Bun users.

## 7. Risks

- **R1. `node:sqlite` ↔ `bun:sqlite` row-shape drift.** Most likely place
  for silent breakage. Mitigation: §5.1 unit tests cover row shape on
  Node, §5.2 step 3 round-trips a real DB file across both runtimes.
- **R2. Bun's `setInterval(...).unref()` semantics.** Used in
  `serve.ts` for the upload cleanup sweep. Bun supports `.unref()` but
  has had regressions historically. Mitigation: §5.2 step 4 verifies
  the server exits cleanly on SIGTERM (a hanging timer would block
  exit).
<!-- 修订v3: 修正——应 Reviewer v2 C-3，R3 措辞与 §3.3 v3 parser 范围对齐，明示 export + 引号多行已纳入测试 -->
<!-- 修订v4: 修正——应 Reviewer round-3 B-4，R3 措辞同步：无前置空白 # 也开始注释；不承诺 backslash 转义 -->
- **R3. `loadEnvFile` parser divergence.** Node's parser is only
  loosely documented and its behavior is the *de facto* spec.
  Mitigation: the in-scope grammar (whitespace trim, `export` prefix,
  `#` comments — including the no-preceding-whitespace form
  `KEY=value#tail` — single/double quoted values, single/double
  quoted *multiline* values, `#` literal preservation inside quotes,
  no-override rule) is pinned by `tests/fixtures/env-oracle.env`
  plus the §5.1 Node-oracle test, and the Bun smoke (§5.2 step 6.b)
  reuses the same fixture by importing `parseEnvContentForCompat`
  from `dist/env.js`. Out-of-scope items — backslash escape sequences
  inside quoted values (`\n`, `\t`, `\\`, `\"`), variable
  interpolation, block scalars — are documented in `src/env.ts`'s
  file header so neither the executor nor a future reader assumes
  parity. If a customer `.env` works on Node but not the shim, the
  triage rule is: if it falls under the in-scope list, fix the shim;
  if it falls under the out-of-scope list, open a follow-up plan.
- **R4. Proxy silent failure.** If we drop the undici install on Bun and
  Bun's native proxy honor is incomplete, customer requests could
  egress without a proxy and confuse the user. Mitigation: the warning
  in §3.4 is mandatory; do not suppress it under `--quiet` even if such
  a flag is added later.
- **R5. Future Bun version drift in CI.** Pinning Bun in CI is required;
  floating `latest` will surprise us. Mitigation: pin exact version in
  the workflow; bumps are intentional PRs.

## 8. Executor file-zones

To allow parallel implementation without merge conflicts, file ownership
is split into four zones. An executor claims one zone at a time.

<!-- 修订v3: 修正——应 Reviewer v2 C-1，Zone A 加入 env-oracle fixture，作为 Node oracle + Bun smoke 共用基准 -->
- **Zone A — Runtime abstractions (new files only).**
  Files: `src/runtime.ts`, `src/sqlite.ts`, `src/env.ts`,
  `tests/runtime.test.ts`, `tests/sqlite.test.ts`, `tests/env.test.ts`,
  `tests/fixtures/env-oracle.env`. Must land first.

<!-- 修订v4: lead 拍板（应 Reviewer round-3 B-5）——Zone B 纳入 src/gatewayClient.ts，以承载 error desc 的显式 redaction -->
<!-- 修订v5: lead 拍板（应 Reviewer v4 C-1）——Zone B 同时纳入新增 Node 单测 tests/gatewayClient.redaction.test.ts，覆盖 desc / message / error 三字段，作为 `error` 字段的 source of truth -->
- **Zone B — Call-site swaps + Gateway error redaction.**
  Files: `src/apiKeyStore.ts`, `src/cli.ts`, `src/gatewayClient.ts`,
  `tests/gatewayClient.redaction.test.ts` (new). Depends on Zone A.
  Does not touch `src/commands/serve.ts` (transitive consumer; should
  require zero edits — flag to lead if it does). The
  `src/gatewayClient.ts` edit is bounded: only the error-handling
  paths that surface remote `desc` / `message` / `error` strings are
  modified, to pipe them through `redactSensitive(...,
  [apiKey, appSecret, ...])` before throwing/logging. No protocol
  changes, no retry/timeout changes, no shape changes to thrown
  errors beyond the redacted text. The new Node unit test covers
  the three fields against synthetic Gateway responses (see §4 v5
  scope note).

- **Zone C — Smoke + CI.**
  Files: `scripts/bun-smoke.mjs` (new), `.github/workflows/ci.yml`,
  `package.json` (scripts block only).
  Can be developed in parallel with Zone A/B but only merged after Zone
  B lands.

<!-- 修订v2: lead 拍板（应 Reviewer C-5）——Zone D 加入 first-trial-walkthrough.md 与 install/hive-mp-publish.md -->
- **Zone D — Docs.**
  Files: `README.md`, `docs/deployment.md`, `docs/server.md`,
  `docs/first-trial-walkthrough.md`, `install/hive-mp-publish.md`,
  `AGENTS.md`.
  Independent of A/B/C for editing; merge last so wording reflects
  shipped behavior.

Cross-zone rules:

<!-- 修订v4: 修正——应 Reviewer round-3 B-5，gatewayClient.ts 从禁改清单移到 Zone B；security.ts 保持禁改 -->
- No zone may edit `src/commands/serve.ts`, `src/security.ts`,
  `src/gatewayConfig.ts`, `src/tokenCache.ts`, `src/utils.ts`, or
  `src/index.ts` as part of this plan. If a Bun incompatibility
  surfaces in any of those, executor stops and pings the lead — do
  not patch in-band. `src/gatewayClient.ts` is now in Zone B per
  the B-5 scope expansion (above); its bounded edit scope is
  described there.
- No zone may change SQL schema, table names, column casing, or any
  on-disk format.
- No zone touches `src/cli.ts` shebang, `package.json` `bin`, or
  `engines` (per D2).
