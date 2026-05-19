#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${REMOTE:-ResoPodXavierCN}"
REMOTE_DIR="${REMOTE_DIR:-/home/xavier/hive-mp-publish}"
IMAGE_REPO="${IMAGE_REPO:-hive-mp-publish}"
TAG="${1:-$(date +%Y%m%d%H%M%S)}"
SOURCE_ARCHIVE="${ROOT_DIR}/releases/hive-mp-publish-source-${TAG}.tar.gz"
REMOTE_SOURCE="${REMOTE_DIR}/sources/hive-mp-publish-source-${TAG}.tar.gz"
REMOTE_BUILD_DIR="${REMOTE_DIR}/builds/${TAG}"
NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"

cd "$ROOT_DIR"
mkdir -p releases

pnpm typecheck
pnpm test
pnpm build

COPYFILE_DISABLE=1 tar \
    --exclude .git \
    --exclude node_modules \
    --exclude dist \
    --exclude releases \
    --exclude .DS_Store \
    -czf "$SOURCE_ARCHIVE" \
    -C "$ROOT_DIR" .

ssh "$REMOTE" "mkdir -p '$REMOTE_DIR/sources' '$REMOTE_DIR/builds' '$REMOTE_DIR/releases' '$REMOTE_DIR/bin' '$REMOTE_DIR/data' '$REMOTE_DIR/nginx'"
scp "$SOURCE_ARCHIVE" "$REMOTE:$REMOTE_SOURCE"
scp "$ROOT_DIR/scripts/server/hive-mp-publish-deploy.sh" "$REMOTE:$REMOTE_DIR/bin/hive-mp-publish-deploy.sh"
scp "$ROOT_DIR/scripts/server/nginx-hive-mp-publish.conf.template" "$REMOTE:$REMOTE_DIR/nginx/nginx-hive-mp-publish.conf.template"
ssh "$REMOTE" "chmod +x '$REMOTE_DIR/bin/hive-mp-publish-deploy.sh'"

ssh "$REMOTE" "test ! -e '$REMOTE_BUILD_DIR' && mkdir -p '$REMOTE_BUILD_DIR' && tar -xzf '$REMOTE_SOURCE' -C '$REMOTE_BUILD_DIR'"
ssh "$REMOTE" "cd '$REMOTE_BUILD_DIR' && docker build --build-arg NPM_CONFIG_REGISTRY='$NPM_CONFIG_REGISTRY' -t '$IMAGE_REPO:$TAG' ."

printf 'Built remote image: %s:%s\n' "$IMAGE_REPO" "$TAG"
printf 'Deploy with:\n'
printf '  ssh %s %s/bin/hive-mp-publish-deploy.sh %s:%s\n' "$REMOTE" "$REMOTE_DIR" "$IMAGE_REPO" "$TAG"
