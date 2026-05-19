#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_REPO="${IMAGE_REPO:-hive-mp-publish}"
TAG="${1:-$(date +%Y%m%d%H%M%S)}"
IMAGE="${IMAGE_REPO}:${TAG}"
OUT_DIR="${OUT_DIR:-${ROOT_DIR}/releases}"
ARCHIVE="${OUT_DIR}/hive-mp-publish-${TAG}.tar.gz"

cd "$ROOT_DIR"
mkdir -p "$OUT_DIR"

pnpm typecheck
pnpm test
pnpm build

docker build -t "$IMAGE" .
docker save "$IMAGE" | gzip -c > "$ARCHIVE"

printf 'Built image: %s\n' "$IMAGE"
printf 'Archive: %s\n' "$ARCHIVE"
