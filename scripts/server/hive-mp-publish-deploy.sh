#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_DIR="${HIVE_MP_DEPLOY_DIR:-$HOME/hive-mp-publish}"
DATA_DIR="${HIVE_MP_DATA_DIR:-$DEPLOY_DIR/data}"
HOST_PORT="${HIVE_MP_HOST_PORT:-3007}"
CONTAINER_NAME="${HIVE_MP_CONTAINER_NAME:-hive-mp-publish-gateway}"
HEALTH_URL="http://127.0.0.1:${HOST_PORT}/health"

if [[ $# -lt 1 ]]; then
    printf 'Usage: %s <image-archive.tar.gz|image:tag>\n' "$0" >&2
    exit 2
fi

mkdir -p "$DATA_DIR" "$DEPLOY_DIR/releases"

if ss -ltn "sport = :$HOST_PORT" | tail -n +2 | grep -q .; then
    if ! docker ps --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
        printf 'Port %s is already in use by another service. Refusing to deploy.\n' "$HOST_PORT" >&2
        exit 1
    fi
fi

TARGET="$1"
if [[ -f "$TARGET" || "$TARGET" == *.tar || "$TARGET" == *.tar.gz || "$TARGET" == *.tgz ]]; then
    ARCHIVE="$TARGET"
    if [[ "$ARCHIVE" != /* ]]; then
        ARCHIVE="$DEPLOY_DIR/$ARCHIVE"
    fi
    if [[ ! -f "$ARCHIVE" ]]; then
        printf 'Image archive not found: %s\n' "$ARCHIVE" >&2
        exit 2
    fi

    LOAD_OUTPUT="$(docker load -i "$ARCHIVE")"
    printf '%s\n' "$LOAD_OUTPUT"
    IMAGE="$(printf '%s\n' "$LOAD_OUTPUT" | sed -n 's/^Loaded image: //p' | tail -n 1)"
    if [[ -z "$IMAGE" ]]; then
        printf 'Could not determine loaded image name from docker load output.\n' >&2
        exit 1
    fi
else
    IMAGE="$TARGET"
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
        printf 'Docker image not found locally: %s\n' "$IMAGE" >&2
        exit 2
    fi
fi

PREVIOUS_NAME=""
if docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
    PREVIOUS_NAME="${CONTAINER_NAME}-previous-$(date +%Y%m%d%H%M%S)"
    docker stop "$CONTAINER_NAME"
    docker rename "$CONTAINER_NAME" "$PREVIOUS_NAME"
fi

rollback() {
    printf 'Deployment failed; attempting rollback.\n' >&2
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    if [[ -n "$PREVIOUS_NAME" ]] && docker ps -a --format '{{.Names}}' | grep -Fxq "$PREVIOUS_NAME"; then
        docker rename "$PREVIOUS_NAME" "$CONTAINER_NAME"
        docker start "$CONTAINER_NAME"
    fi
}
trap rollback ERR

docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -p "127.0.0.1:${HOST_PORT}:3000" \
    -v "${DATA_DIR}:/data" \
    "$IMAGE" \
    serve --port 3000

for _ in $(seq 1 30); do
    if curl -fsS "$HEALTH_URL" >/dev/null; then
        trap - ERR
        if [[ -n "$PREVIOUS_NAME" ]]; then
            printf 'Previous container kept as %s. Remove it manually after confidence.\n' "$PREVIOUS_NAME"
        fi
        printf 'Gateway is healthy: %s\n' "$HEALTH_URL"
        printf 'Container: %s\n' "$CONTAINER_NAME"
        printf 'Data dir: %s\n' "$DATA_DIR"
        exit 0
    fi
    sleep 1
done

printf 'Health check failed: %s\n' "$HEALTH_URL" >&2
docker logs --tail 80 "$CONTAINER_NAME" >&2 || true
false
