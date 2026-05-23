<!-- 修订v1: 初稿——Bun-first 全局 CLI 计划 -->
# Plan: Bun-first global `hive-mp-publish` CLI

## Context

Current runtime support already lets the same built `dist/` run on Bun and
Node. The remaining product change is packaging and documentation: the global
command name stays `hive-mp-publish`, but that command should now default to
Bun by way of the package bin shebang.

The server/Docker path is a separate invariant. Docker already runs
`node ./dist/cli.js` explicitly on `node:24-alpine`; that explicit invocation
must remain stable and unaffected by the shebang change.

## Decisions

- Change `src/cli.ts` shebang to `#!/usr/bin/env bun`. Because
  `package.json` keeps `bin.hive-mp-publish = ./dist/cli.js`, installed global
  commands will use Bun without renaming the command.
- Keep `package.json` `bin` unchanged. Do not add a second `hive-mp-publish-bun`
  binary or publish a wrapper script.
- Remove `package.json` `engines.node` rather than keeping it. Trade-off:
  losing npm's Node-version warning is acceptable because the default global
  CLI no longer presents as Node-dependent; server/Docker docs and Dockerfile
  continue to pin/recommend Node 24 where Node is the actual runtime.
- Do not add an `engines.bun` field. npm does not enforce Bun engines reliably,
  and the release/global-install smoke is the mechanical guarantee.
<!-- 修订v2: 修正——应 Reviewer C-4，tarball wording 明确 npm 自动 metadata/README/LICENSE 允许，禁止只说 dist/NOTICE -->
- Do not publish a Bun compiled artifact. The npm tarball continues to be the
  standard npm package: allow the `files` allowlist output (`dist/`, `NOTICE`)
  plus npm's automatic package metadata and README/LICENSE files; reject Bun
  compile binaries, unintended source, generated temp files, or secrets.
- Release CI must test both direct Bun execution and the installed global bin.
  The global-bin test is the one that proves the final shebang and package
  metadata work together.
<!-- 修订v4: 修正——应 Reviewer v3 B-1，global install smoke 必须机械证明 bin shebang 是 Bun -->
- The tarball global-install smoke must mechanically fail if the installed
  global bin still uses a Node shebang. After `bun add -g <tgz>` in an
  isolated `BUN_INSTALL`/`PATH`, inspect the resolved installed bin target (or
  shim target) and assert the referenced CLI file's first line is exactly
  `#!/usr/bin/env bun`, then run `hive-mp-publish doctor` from that same
  isolated PATH.
<!-- 修订v3: 修正——应 Reviewer v2 B-1，CI/release gate 禁止打印完整 API key，理由 release logs 不应包含 secret -->
- Release and CI verification must not print full API keys, access tokens, or
  app secrets. Node `dist` smoke commands must use non-secret output such as
  `--help`, `doctor`, or `key list --db :memory: --json`; do not use
  `key issue` in logged workflow steps.
<!-- 修订v2: lead 拍板（应 Reviewer B-1）——文档命令按 client vs server/operator 分流，理由 Bun-first 全局 bin 不能成为 server 默认路径 -->
- Documentation must split commands by actor:
  - Client/customer commands (`credential`, `publish`, `doctor`) may use the
    Bun-first global `hive-mp-publish`.
  - Server/operator commands (`key`, `serve`) must not use the global bin in
    docs after this change; use explicit `node ./dist/cli.js ...` for
    source/operator instructions, or existing Docker commands for Docker docs.

## Approach

1. Make Bun the package-bin runtime by changing only the CLI shebang and leaving
   `bin` pointed at `./dist/cli.js`.
2. Preserve Node as an explicit runtime for server deployments by keeping
   Dockerfile entrypoint and deployment examples on `node ./dist/cli.js`.
<!-- 修订v4: 修正——应 Reviewer v3 B-1/C-1，release smoke 复用同一个 tgz 且检查 shebang -->
3. Update release workflow to install Bun, run the existing Bun smoke, pack the
   npm tarball once into the release asset directory, inspect and smoke-test
   that same `.tgz`, verify the installed global bin resolves to a
   `#!/usr/bin/env bun` shebang, run `hive-mp-publish doctor`, and upload the
   same smoke-tested `.tgz`.
<!-- 修订v2: 修正——应 Reviewer B-1，Approach 显式拆分客户 CLI 与运维命令 -->
4. Update user-facing install docs to lead with Bun/global CLI for customer
   publish/credential workflows, while rewriting any server/operator examples
   in mixed docs to explicit Node `dist` invocations or Docker commands.
<!-- 修订v3: 修正——应 Reviewer v2 B-1，Node dist gate 改为 non-secret commands -->
5. Add a cheap, non-secret Node `dist` gate in local verification and release
   workflow so the explicit Node server/operator path is protected
   independently of Docker.

## Files to change

- `src/cli.ts`
  - Change the first line to `#!/usr/bin/env bun`.
  - No other runtime behavior should change for this task unless verification
    exposes a Bun global-bin bug.
- `package.json`
  - Keep `bin.hive-mp-publish` unchanged.
  - Remove the `engines.node` block. If executor finds package tooling that
    requires an `engines` object, stop and report rather than replacing it with
    a misleading Node requirement.
  - Keep `files` as `["dist", "NOTICE"]`; do not add Bun compile outputs.
- `.github/workflows/release.yml`
  - Add `oven-sh/setup-bun@v2` with the same pinned Bun version used by CI
    unless lead requests a version bump.
<!-- 修订v4: 修正——应 Reviewer v3 N-1，Node SQLite key-list gate 固定为 mandatory -->
  - After build, run the Node `dist` gate: `node ./dist/cli.js --help`,
    `node ./dist/cli.js doctor`, and `node ./dist/cli.js key list --db
    :memory: --json`. All three commands are mandatory, independent of Docker
    availability, and must not emit secrets.
  - After build, run the existing Bun smoke (`bun scripts/bun-smoke.mjs` or the
    package script).
<!-- 修订v4: 修正——应 Reviewer v3 C-1，release asset dir 单一化，smoke-tested tgz 即上传 tgz -->
  - Use one release asset directory consistently. Prefer the existing
    repo-local `release-assets/`: pack the npm tarball there, build the skill
    tarballs there, run the global-install smoke against the produced
    `release-assets/hive-mp-publish-*.tgz`, and pass that same directory to
    `gh release create release-assets/*`. If executor chooses
    `$RUNNER_TEMP/release-assets` instead, every pack/smoke/skill/`gh release
    create` path must use that same directory.
  - For the tarball global-install smoke: create a temp `BUN_INSTALL`, prepend
    its `bin` directory to `PATH`, run `bun add -g <produced-tgz>`, assert
    `command -v hive-mp-publish` resolves inside the temp `BUN_INSTALL`,
    resolve the installed bin/shim to the package CLI target, assert that
    target's first line is exactly `#!/usr/bin/env bun`, then run
    `hive-mp-publish doctor`. The step must fail if the shebang is still
    `#!/usr/bin/env node`.
  - The smoke must not use the developer/user real Bun global directory.
- `.github/workflows/ci.yml`
  - No required change if existing `test-bun` continues to build and run
    `scripts/bun-smoke.mjs`. Only touch this file if the executor extracts a
    shared global-install smoke script and wants CI to call it too.
- `README.md`
  - Quick Start becomes Bun-first (`bun add -g hive-mp-publish`,
    `hive-mp-publish doctor`).
  - Source-run examples should use Bun for CLI usage.
<!-- 修订v2: 修正——应 Reviewer B-1/C-2，README 混合命令拆分并加入 missing Bun 失败说明 -->
  - Split examples by role: customer `credential` / `publish` commands may use
    global `hive-mp-publish`; Gateway operator `key` / `serve` examples must use
    explicit `node ./dist/cli.js ...` or point to Docker docs.
<!-- 修订v3: 修正——应 Reviewer v2 C-1，README 按 actor/section 明确命令边界 -->
  - Implement the split by README section, not only with a generic note:
    customer quickstart/global CLI sections use `hive-mp-publish`;
    customer source-run examples use `bun ./dist/cli.js`; Gateway
    operator/server source-run examples use `node ./dist/cli.js` or Docker.
  - Add a short compatibility note: explicit `node ./dist/cli.js ...` remains
    the server/deployment path; Docker is unchanged.
  - Add missing-Bun guidance: verify `bun --version` before global install, and
    if the installed command fails with `env: bun` / `bun: No such file or
    directory`, install Bun or add the Bun bin directory to `PATH`.
- `install/hive-mp-publish.md`
  - Change the agent install path from Node/npm-first to Bun-first.
  - Keep warnings about secrets, HTTPS Gateway URLs, and Node 24 for
    Gateway/server operations.
<!-- 修订v2: 修正——应 Reviewer B-1/C-2，install guide 同步拆分 server/operator 命令并记录缺 Bun 处理 -->
  - Before global CLI install, tell the agent to verify `bun --version`.
    Document the failure mode where `hive-mp-publish` cannot find
    `/usr/bin/env bun`, and instruct the agent to install Bun or add the Bun
    bin directory to `PATH`.
  - Customer setup/publish commands may use global `hive-mp-publish`; Gateway
    operator commands in this guide (`key issue`, `serve`) must use explicit
    `node ./dist/cli.js ...` or Docker commands.
<!-- 修订v2: 修正——应 Reviewer C-3，移除不可用的 github: 全局安装 fallback -->
  - Remove the `npm install -g github:xavierliang/hive-mp-publish#...`
    fallback because `dist/` is not committed and that install path cannot
    reliably produce a runnable global bin.
  - Replacement fallback: use the release tarball only for global install; if a
    source fallback is needed, instruct operators to clone, `pnpm install`,
    `pnpm build`, and run an explicit local path (`bun ./dist/cli.js` for
    client CLI checks, `node ./dist/cli.js` for server/operator checks), not a
    global GitHub package install.
<!-- 修订v4: 修正——应 Reviewer v3 C-2，credential doc 纳入客户侧全局 CLI scope -->
- `docs/first-trial-walkthrough.md`, `docs/customer-onboarding.md`,
  `docs/publish.md`, `docs/credential.md`
  - Update customer/global CLI examples to match Bun-first install assumptions
    where they discuss installing or invoking the global command.
  - In `docs/first-trial-walkthrough.md`, rewrite any Gateway setup,
    `key issue`, or `serve` snippets to explicit Node `dist` commands or Docker
    commands; leave customer publish/credential snippets on global
    `hive-mp-publish`.
- `docs/server.md`, `docs/deployment.md`
  - Keep production server examples on Node 24 / `node dist/cli.js serve`.
  - Remove or demote existing Bun server snippets so production docs do not
    imply a runtime migration for the Gateway host.
- `docs/docker.md`, `README.docker.md`, `docs/deploy-cn-docker.md`
  - Keep Docker command examples unchanged (`docker run ... hive-mp-publish
    serve ...` is acceptable because the image entrypoint is explicit Node).
<!-- 修订v3: 修正——应 Reviewer v2 C-2，Docker docs 中若有客户侧命令需指向 Bun 前置条件 -->
  - If these docs include customer-side `hive-mp-publish credential` or
    `hive-mp-publish publish` snippets outside the container, add a short
    prerequisite/callout that the customer CLI is Bun-first and point to
    `install/hive-mp-publish.md`. Do not add Bun install steps inside
    Docker/server sections.
  - If touched, only clarify that Docker continues to use Node 24 internally.
    Do not introduce Bun install steps in Docker docs.
- `docs/plans/bun-runtime-support.md`
  - Do not rewrite this historical plan unless lead explicitly asks. This new
    plan supersedes its Node-first packaging decision.

## Verification

Run the normal Node gate:

```bash
pnpm typecheck
pnpm test
pnpm exec eslint .
pnpm build
```

<!-- 修订v4: 修正——应 Reviewer v3 N-1，本地验证同 release 一样 mandatory key-list -->
Run the mandatory non-secret Node `dist` gate after build:

```bash
node ./dist/cli.js --help
node ./dist/cli.js doctor
node ./dist/cli.js key list --db :memory: --json
```

Run the existing Bun smoke after build:

```bash
bun scripts/bun-smoke.mjs
```

Verify the npm package contents and installed global bin:

```bash
RELEASE_ASSETS="$(mktemp -d)"
npm pack --pack-destination "$RELEASE_ASSETS"
```

<!-- 修订v3: 修正——应 Reviewer v2 N-1，pack verification 使用单一路径，dry-run 降为可选本地检查 -->
Inspect the produced `.tgz` from that single pack command. Expected package
contents are `dist/`, `NOTICE`, and npm-automatic package metadata / README /
LICENSE files. There must be no Bun compiled binary, no unintended source tree,
no temp files, and no secrets. `npm pack --dry-run` is optional for local
preflight only; do not duplicate it as a second release workflow pack step.

<!-- 修订v4: 修正——应 Reviewer v3 B-1，packaged bin smoke 增加 shebang inspection -->
Then install the produced tarball into an isolated Bun global prefix and run the
real command from that prefix. The executor should use a temp directory for
`BUN_INSTALL`, put only that temp `bin` ahead of `PATH`, confirm
`hive-mp-publish` resolves there, resolve the installed bin/shim to the package
CLI target, assert that target's first line is exactly `#!/usr/bin/env bun`,
and run `hive-mp-publish doctor`. This check is required because direct
`bun ./dist/cli.js` does not prove the packaged bin shebang works, and merely
running `doctor` could still pass with a Node shebang on a machine where Node is
available.

<!-- 修订v4: 修正——应 Reviewer v3 C-3，Docker invariant 加 cheap textual guard -->
Verify the Docker Node invariant with a cheap textual guard:

```bash
grep -F 'ENTRYPOINT ["node", "./dist/cli.js"]' Dockerfile
```

Docker build/run verification is required once for this migration when Docker
is available, but should stay out of the normal release workflow unless lead
asks for a slower release gate:

```bash
docker build -t hive-mp-publish:bun-first-smoke .
docker run --rm hive-mp-publish:bun-first-smoke --help
```

For a stronger local server smoke when Docker is available, run the image with
`serve --port 3000`, publish port `127.0.0.1:3000:3000`, poll `/health`, then
stop the container. If Docker is unavailable in the executor environment,
report that gap explicitly.

<!-- 修订v3: 修正——应 Reviewer v2 C-1/C-2，新增文档 review checklist -->
Documentation review checklist:

- README actor/section split is explicit: customer quickstart/global CLI uses
  `hive-mp-publish`; customer source-run examples use `bun ./dist/cli.js`;
  Gateway operator/server source-run examples use `node ./dist/cli.js` or
  Docker.
<!-- 修订v4: 修正——应 Reviewer v3 C-2，docs/credential.md 加入 checklist -->
- `docs/credential.md` customer-side command examples follow the same
  Bun-first global CLI assumptions and point to install guidance when needed.
- Mixed docs do not show global `hive-mp-publish key` or
  `hive-mp-publish serve` for server/operator workflows.
- Docker/deploy docs that mention customer-side global CLI commands point to
  the Bun-first install guide or include a Bun prerequisite callout, while
  Docker/server sections themselves remain free of Bun install steps.

## Release impact

- This is a user-visible runtime default change: after upgrade, the global
  `hive-mp-publish` command requires `bun` on `PATH`.
- The release notes should say the command name is unchanged, the global CLI is
  Bun-first, and server/Docker deployments continue to use Node 24.
<!-- 修订v2: 修正——应 Reviewer C-4，release impact 对 npm 自动内容表述收窄为 allowlist review -->
- The npm tarball should still be the standard package tarball containing
  `dist/`, `NOTICE`, and npm-automatic README/LICENSE/package metadata. No
  standalone Bun binary is attached or referenced, and pack review should catch
  unintended source/temp/secret files.
- Existing release assets for skills remain unchanged.
- Removing `engines.node` avoids false Node dependency signaling for the
  default CLI, but docs must carry the Node 24 requirement for Gateway/server
  operators.

## Server/Docker invariant

- `Dockerfile` remains based on Node 24 and keeps
  `ENTRYPOINT ["node", "./dist/cli.js"]`.
<!-- 修订v4: 修正——应 Reviewer v3 C-3，Docker invariant 必须有文本 guard -->
- Verification includes a textual guard that fails if that Dockerfile
  entrypoint changes away from `ENTRYPOINT ["node", "./dist/cli.js"]`.
- No Bun runtime, Bun install directory, or Bun global package state is added to
  the Docker image.
- Server deployment docs keep `node ./dist/cli.js serve` as the production
  path. Bun may remain a developer/runtime compatibility path, but not the
  documented production server default.
<!-- 修订v2: lead 拍板（应 Reviewer B-1）——server/operator docs 禁止全局 bin，理由 shebang 已指向 Bun -->
- Mixed docs must not show `hive-mp-publish key ...` or `hive-mp-publish serve
  ...` as server/operator instructions. Use `node ./dist/cli.js key ...` /
  `node ./dist/cli.js serve ...`, or Docker commands whose image entrypoint is
  already explicit Node.
<!-- 修订v3: 修正——应 Reviewer v2 B-1，server Node path 验证不得泄露 API key -->
- The explicit Node server/operator path is verified with non-secret commands
  only. Do not add `key issue` to CI/release logs unless output is captured and
  redacted; this plan does not require that complexity.
- Existing security rules remain unchanged: no server-side persistence of
  customer `appSecret`, no full API key/access token/app secret logging, remote
  Gateway client URLs stay HTTPS-only except localhost or controlled tests, and
  Gateway uploads stay temporary.

## Executor zones

- Zone A: packaging/runtime default
  - Files: `src/cli.ts`, `package.json`.
  - Owns shebang, engines decision, and confirming `bin`/`files` stay scoped.
- Zone B: release verification
  - Files: `.github/workflows/release.yml`; optional shared script only if it
    keeps the workflow clearer.
<!-- 修订v4: 修正——应 Reviewer v3 B-1/C-1/N-1，Zone B 覆盖 shebang inspection、单一 release dir、mandatory key-list -->
  - Owns Setup Bun, mandatory non-secret Node `dist` gate including
    `key list --db :memory: --json`, direct Bun smoke, single release asset
    directory, single `npm pack --pack-destination` path, isolated
    `bun add -g <tgz>` smoke, installed-bin shebang inspection, and final
    `hive-mp-publish doctor`.
- Zone C: user docs
  - Files: `README.md`, `install/hive-mp-publish.md`,
    `docs/first-trial-walkthrough.md`, `docs/customer-onboarding.md`,
    `docs/publish.md`, `docs/credential.md`.
<!-- 修订v2: 修正——应 Reviewer B-1/C-2/C-3，Zone C 扩展安装失败与 source fallback 边界 -->
  - Owns Bun-first install and global CLI wording, missing-Bun failure docs,
    removal of GitHub global-install fallback, and client/server command split
    inside mixed first-run docs.
- Zone D: server/Docker docs
  - Files: `docs/server.md`, `docs/deployment.md`, `docs/docker.md`,
    `README.docker.md`, `docs/deploy-cn-docker.md`.
  - Owns Node 24 server/Docker invariant wording and verifies no server/operator
    snippet uses the Bun-first global bin outside Docker container commands.
  - Also owns the Docker/deploy doc boundary: customer-side CLI snippets need a
    Bun prerequisite pointer, but Docker/server sections do not gain Bun install
    instructions.
- Zone E: verification only
  - Runs Node test gate, mandatory Node `dist` gate, Bun smoke,
    pack/global-install smoke, and Docker smoke.
  - Does not broaden runtime behavior or refactor source outside Zones A/B.
