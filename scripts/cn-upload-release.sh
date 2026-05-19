#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${REMOTE:-ResoPodXavierCN}"
REMOTE_DIR="${REMOTE_DIR:-/home/xavier/hive-mp-publish}"

if [[ $# -lt 1 ]]; then
    printf 'Usage: %s <release-tar.gz>\n' "$0" >&2
    exit 2
fi

ARCHIVE="$1"
if [[ ! -f "$ARCHIVE" ]]; then
    printf 'Release archive not found: %s\n' "$ARCHIVE" >&2
    exit 2
fi

ARCHIVE_NAME="$(basename "$ARCHIVE")"

ssh "$REMOTE" "mkdir -p '$REMOTE_DIR/releases' '$REMOTE_DIR/bin' '$REMOTE_DIR/data' '$REMOTE_DIR/nginx'"
scp "$ARCHIVE" "$REMOTE:$REMOTE_DIR/releases/$ARCHIVE_NAME"
scp "$ROOT_DIR/scripts/server/hive-mp-publish-deploy.sh" "$REMOTE:$REMOTE_DIR/bin/hive-mp-publish-deploy.sh"
scp "$ROOT_DIR/scripts/server/nginx-hive-mp-publish.conf.template" "$REMOTE:$REMOTE_DIR/nginx/nginx-hive-mp-publish.conf.template"
ssh "$REMOTE" "chmod +x '$REMOTE_DIR/bin/hive-mp-publish-deploy.sh'"

printf 'Uploaded archive to %s:%s/releases/%s\n' "$REMOTE" "$REMOTE_DIR" "$ARCHIVE_NAME"
printf 'Deploy on server with:\n'
printf '  ssh %s %s/bin/hive-mp-publish-deploy.sh %s/releases/%s\n' "$REMOTE" "$REMOTE_DIR" "$REMOTE_DIR" "$ARCHIVE_NAME"
