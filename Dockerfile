FROM node:24-alpine AS builder

WORKDIR /app

ARG NPM_CONFIG_REGISTRY=
RUN if [ -n "$NPM_CONFIG_REGISTRY" ]; then npm config set registry "$NPM_CONFIG_REGISTRY"; fi \
    && npm install -g pnpm@9.15.4
COPY package.json pnpm-lock.yaml ./
RUN if [ -n "$NPM_CONFIG_REGISTRY" ]; then pnpm config set registry "$NPM_CONFIG_REGISTRY"; fi \
    && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:24-alpine AS runner

ENV NODE_ENV=production
ENV HIVE_MP_GATEWAY_DB=/data/gateway.sqlite

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/dist ./dist/
COPY package.json ./

VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["node", "./dist/cli.js"]
CMD ["--help"]
