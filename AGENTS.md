# AGENTS.md

## Build, Test, And Lint

- Install dependencies: `pnpm install`
- Type-check: `pnpm typecheck`
- Test: `pnpm test`
- Lint check: `pnpm exec eslint .`
- Build: `pnpm build`

Run one test file:

```bash
pnpm exec node --import tsx --test tests/serve.test.ts
```

## Architecture

- `src/cli.ts` defines the `hive-mp-publish` CLI: `publish`, `render`, `theme`, `serve`, `key`, `credential`, and `token`.
- `src/gatewayClient.ts` is the client-side Gateway publish path. It requires HTTPS for non-localhost server URLs, resolves local WeChat credentials, uploads local assets, and sends `appId/appSecret` only in the final `/publish` request.
- `src/commands/serve.ts` is the fixed-IP Gateway. It authenticates every protected request with SQLite-backed API keys, rewrites `asset://` uploads to temp files, and calls WeChat draft APIs through `@wenyan-md/core`.
- `src/apiKeyStore.ts` owns SQLite API key issue/revoke/list and monthly usage counts. Store only key hashes, never plaintext keys.
- `src/runtime.ts` owns Node/Bun runtime detection and version labels.
- `src/sqlite.ts` is the only SQLite runtime boundary. It loads `node:sqlite` or `bun:sqlite` through `createRequire`; static `import` statements for those specifiers are forbidden.
- `src/env.ts` is the only env-file runtime boundary. It loads `node:process` `loadEnvFile` through `createRequire` on Node and uses the compatibility parser on Bun.
- `src/tokenCache.ts` replaces the upstream persistent token store with an in-memory access_token cache for server mode.
- `src/security.ts` contains hashing and redaction helpers.

## Security Rules

- Do not add server-side persistence for customer `appSecret`.
- Do not log request bodies, full API keys, access tokens, or app secrets.
- Remote Gateway client URLs must stay HTTPS-only except localhost or explicit controlled test mode.
- Keep Gateway uploads temporary; permanent customer content storage is out of scope for the MVP.
