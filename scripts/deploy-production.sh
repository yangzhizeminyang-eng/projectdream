#!/usr/bin/env bash
set -Eeuo pipefail

# ProjectDream production guard for the small cloud host.
# Build one service at a time and never restart a service after a failed build.
# FastAPI-Only 迁移第六阶段：服务名对齐新 compose（api/worker-node/rag/frontend/mysql），
# Node API 服务已退役，本脚本不再出现 backend/worker 旧服务名。

ROOT_DIR="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APP_ENV_FILE="${APP_ENV_FILE:-.env.production}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-projectdream}"
DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/projectdream-deploy-production.lock}"
export COMPOSE_PROJECT_NAME

cd "$ROOT_DIR"

compose() {
  docker compose --env-file "$APP_ENV_FILE" "$@"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_tools() {
  command -v docker >/dev/null 2>&1 || die 'docker is not installed or is not on PATH'
  command -v flock >/dev/null 2>&1 || die 'flock is required to prevent concurrent production builds'
  command -v curl >/dev/null 2>&1 || die 'curl is required for public entrypoint verification'
  docker info >/dev/null 2>&1 || die 'Docker engine is unavailable; do not start a build until the daemon is healthy'
  [[ -f "$APP_ENV_FILE" ]] || die "missing environment file: $ROOT_DIR/$APP_ENV_FILE"
}

acquire_deploy_lock() {
  exec 9>"$DEPLOY_LOCK_FILE"
  flock -n 9 || die "another ProjectDream deployment is already running (lock: $DEPLOY_LOCK_FILE)"
}

env_value() {
  local key="$1"
  sed -nE "s/^${key}=([^#]*)/\1/p" "$APP_ENV_FILE" | tail -n 1 | tr -d '\r'
}

resource_snapshot() {
  local mem_available swap_free disk_available
  mem_available="$(awk '/MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
  swap_free="$(awk '/SwapFree:/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
  disk_available="$(df -Pk "$ROOT_DIR" | awk 'NR == 2 { printf "%d", $4 / 1024 }')"
  printf 'resources: mem_available=%sMiB swap_free=%sMiB disk_available=%sMiB\n' \
    "$mem_available" "$swap_free" "$disk_available"
  (( mem_available >= 256 )) || die "only ${mem_available}MiB memory is available; postpone the build"
  (( swap_free >= 256 )) || die "only ${swap_free}MiB swap is free; postpone the build"
  (( disk_available >= 1536 )) || die "only ${disk_available}MiB disk space is free; clean approved resources first"
}

validate_compose() {
  compose config --quiet
}

service_allowed() {
  case "$1" in
    api|worker-node|rag|frontend) return 0 ;;
    *) return 1 ;;
  esac
}

build_service() {
  local service="$1"
  service_allowed "$service" || die "unsupported build service: $service"
  resource_snapshot
  printf 'building %s (serial, cached where possible)\n' "$service"
  compose build "$service"
  printf 'build complete: %s\n' "$service"
}

build_all() {
  resource_snapshot
  validate_compose
  local service
  for service in api worker-node rag frontend; do
    build_service "$service"
  done
}

container_id() {
  compose ps -q "$1" | head -n 1
}

wait_for_service() {
  local service="$1" allow_legacy_worker="${2:-0}" id status health attempt
  for attempt in $(seq 1 30); do
    id="$(container_id "$service")"
    if [[ -n "$id" ]]; then
      status="$(docker inspect -f '{{.State.Status}}' "$id")"
      health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$id")"
      if [[ "$service" == worker-node && "$health" == no-healthcheck ]]; then
        if [[ "$allow_legacy_worker" == 1 && "$status" == running ]]; then
          printf 'rollback restored legacy worker (running; healthcheck absent)\n'
          return 0
        fi
        printf 'not ready: worker requires a configured Docker healthcheck\n' >&2
        return 1
      fi
      if [[ "$status" == running && ( "$health" == healthy || ( "$service" != worker-node && "$health" == no-healthcheck ) ) ]]; then
        printf 'ready: %s (%s)\n' "$service" "$health"
        return 0
      fi
    fi
    sleep 2
  done
  compose ps "$service"
  compose logs --tail=80 "$service" || true
  return 1
}

redeploy() {
  local service container old_id rollback_ref target_ref deploy_stamp deploy_failed rollback_failed
  local -a services rollback_refs
  deploy_stamp="$(date +%Y%m%d-%H%M%S)"
  if (( $# == 0 )); then
    set -- api worker-node rag frontend
  fi
  services=("$@")
  for service in "$@"; do
    service_allowed "$service" || die "unsupported redeploy service: $service"
  done

  # Snapshot every target before changing any service, so a later failure can
  # restore the whole requested batch instead of leaving a mixed release.
  for service in "${services[@]}"; do
    container="$(container_id "$service")"
    [[ -n "$container" ]] || die "cannot create an atomic release: service has no existing container: $service"
    old_id="$(docker inspect -f '{{.Image}}' "$container")"
    rollback_ref="${COMPOSE_PROJECT_NAME}-${service}:rollback-${deploy_stamp}"
    docker tag "$old_id" "$rollback_ref"
    rollback_refs+=("$rollback_ref")
  done

  deploy_failed=0
  for service in "${services[@]}"; do
    # --no-build is deliberate: a failed build must never be hidden by an implicit rebuild.
    if ! compose up -d --no-build --force-recreate "$service" || ! wait_for_service "$service"; then
      deploy_failed=1
      break
    fi
  done

  if (( deploy_failed == 0 )); then
    if ! (verify); then
      deploy_failed=1
    fi
  fi

  if (( deploy_failed != 0 )); then
    printf 'release validation failed; restoring all services in the requested batch\n' >&2
    rollback_failed=0
    for service in "${services[@]}"; do
      rollback_ref="${COMPOSE_PROJECT_NAME}-${service}:rollback-${deploy_stamp}"
      target_ref="${COMPOSE_PROJECT_NAME}-${service}:latest"
      docker tag "$rollback_ref" "$target_ref" || rollback_failed=1
      if ! compose up -d --no-build --force-recreate "$service" || ! wait_for_service "$service" 1; then
        rollback_failed=1
      fi
    done
    (( rollback_failed == 0 )) || die "release failed and one or more services could not be rolled back; rollback image tags were retained"
    die "service deployment failed; the requested batch was rolled back and rollback image tags were retained"
  fi

  for rollback_ref in "${rollback_refs[@]}"; do
    docker image rm "$rollback_ref" >/dev/null 2>&1 || true
  done
}

verify() {
  local service id status health http_port base_url
  for service in mysql api rag frontend worker-node; do
    id="$(container_id "$service")"
    [[ -n "$id" ]] || die "missing container: $service"
    status="$(docker inspect -f '{{.State.Status}}' "$id")"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{end}}' "$id")"
    [[ "$status" == running ]] || die "$service is not running: $status"
    [[ -n "$health" ]] || die "$service is missing its required Docker healthcheck"
    [[ "$health" == healthy ]] || die "$service health is $health"
  done
  compose exec -T worker-node ffmpeg -version | sed -n '1p'
  compose exec -T worker-node ffprobe -version | sed -n '1p'
  compose exec -T worker-node sh -lc \
    'set -eu; rm -f /tmp/projectdream-ffmpeg-smoke.mp4; ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=64x64:d=1 -c:v libx264 -pix_fmt yuv420p -y /tmp/projectdream-ffmpeg-smoke.mp4; test "$(ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/projectdream-ffmpeg-smoke.mp4)" = "1.000000"; rm -f /tmp/projectdream-ffmpeg-smoke.mp4'
  http_port="${HTTP_PORT:-$(env_value HTTP_PORT)}"
  http_port="${http_port:-80}"
  base_url="http://127.0.0.1:${http_port}"
  curl -fsS --max-time 10 "$base_url/" >/dev/null || die "public homepage is unavailable: $base_url/"
  curl -fsS --max-time 10 "$base_url/nginx-health" >/dev/null || die "nginx health endpoint is unavailable: $base_url/nginx-health"
  curl -fsS --max-time 10 "$base_url/api/health" >/dev/null || die "API health endpoint is unavailable: $base_url/api/health"
  printf 'verification complete: containers healthy, public endpoints and ffmpeg/ffprobe smoke test passed\n'
}

cleanup_preview() {
  local active_api_id active_api_short image_id image_short image_ref image_service image_virtual_size image_age container_refs image_ids
  printf '%s\n' 'cleanup preview only; no Docker resource will be deleted'
  printf '%s\n' '--- eligible dangling ProjectDream service images (candidate only; no deletion) ---'
  active_api_id=""
  if [[ -n "$(container_id api)" ]]; then
    active_api_id="$(docker inspect -f '{{.Image}}' "$(container_id api)")" || die 'failed to inspect the active api image'
    active_api_short="${active_api_id#sha256:}"
    active_api_short="${active_api_short:0:12}"
  fi
  image_ids="$(docker image ls -q \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" | sort -u)" || die 'failed to enumerate project images; cleanup preview is incomplete'
  while IFS= read -r image_id; do
    [[ -n "$image_id" ]] || continue
    image_short="${image_id#sha256:}"
    image_short="${image_short:0:12}"
    image_ref="$(docker image inspect -f '{{if .RepoTags}}{{join .RepoTags ","}}{{else}}<none>:<none>{{end}}' "$image_id")" || die "failed to inspect image tags: $image_id"
    image_service="$(docker image inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$image_id")" || die "failed to inspect image service: $image_id"
    image_virtual_size="$(docker image inspect -f '{{.Size}}' "$image_id")" || die "failed to inspect image size: $image_id"
    image_age="$(docker image inspect -f '{{.Created}}' "$image_id")" || die "failed to inspect image creation time: $image_id"
    if [[ "$image_short" == "$active_api_short" ]]; then
      printf 'preserved reason=active-api id=%s image=%s\n' "$image_id" "$image_ref"
      continue
    fi
    if [[ "$image_ref" != '<none>:<none>' ]]; then
      printf 'preserved reason=tagged id=%s image=%s\n' "$image_id" "$image_ref"
      continue
    fi
    case "$image_service" in
      api|worker-node|frontend|rag) ;;
      *) printf 'preserved reason=unsupported-service id=%s service=%s\n' "$image_id" "$image_service"; continue ;;
    esac
    container_refs="$(docker ps -a -q --filter "ancestor=$image_id")" || die "failed to check container references: $image_id"
    if [[ -n "$container_refs" ]]; then
      printf 'preserved reason=container-reference id=%s image=%s containers=%s\n' \
        "$image_id" "$image_ref" "$(tr '\n' ',' <<<"$container_refs" | sed 's/,$//')"
      continue
    fi
    printf 'candidate id=%s service=%s image=%s virtual_size=%s created=%s\n' \
      "$image_id" "$image_service" "$image_ref" "$image_virtual_size" "$image_age"
  done <<< "$image_ids"
  printf '%s\n' '--- exited containers ---'
  docker ps -a --filter 'status=exited' \
    --format 'id={{.ID}} name={{.Names}} image={{.Image}} status={{.Status}}' || true
  printf '%s\n' '--- Docker disk usage ---'
  docker system df || true
  printf '%s\n' 'Image virtual_size includes shared layers; shared image layers can make actual reclaimed disk space lower. Check docker system df after removal.'
  printf '%s\n' '--- protected projectdream volumes (never delete from this preview) ---'
  docker volume ls --filter "name=${COMPOSE_PROJECT_NAME}_" \
    --format 'name={{.Name}} driver={{.Driver}}' || true
  printf '%s\n' 'Candidates are informational only. No image, container, volume or cache is deleted by this command.'
}

cleanup_image() {
  local image_id image_tags image_project image_service container_refs
  [[ $# == 1 ]] || die 'cleanup-image requires exactly one full image ID'
  image_id="$1"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die 'cleanup-image accepts only a full sha256 image ID'
  image_tags="$(docker image inspect -f '{{json .RepoTags}}' "$image_id")" || die "image does not exist or cannot be inspected: $image_id"
  image_project="$(docker image inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$image_id")" || die "failed to inspect project label: $image_id"
  image_service="$(docker image inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$image_id")" || die "failed to inspect service label: $image_id"
  container_refs="$(docker ps -a -q --filter "ancestor=$image_id")" || die "failed to check container references: $image_id"
  [[ "$image_tags" == '[]' ]] || die "refusing to remove a tagged image: $image_id ($image_tags)"
  [[ "$image_project" == "$COMPOSE_PROJECT_NAME" ]] || die "refusing to remove an image outside project $COMPOSE_PROJECT_NAME: $image_id"
  case "$image_service" in
    api|worker-node|frontend|rag) ;;
    *) die "refusing to remove an unsupported service image: $image_id (service=$image_service)" ;;
  esac
  [[ -z "$container_refs" ]] || die "refusing to remove an image referenced by containers: $image_id ($container_refs)"
  printf 'removing verified dangling ProjectDream image: %s service=%s\n' "$image_id" "$image_service"
  docker image rm "$image_id" || die "Docker refused to remove image without force: $image_id"
}

usage() {
  cat <<'EOF'
Usage: scripts/deploy-production.sh <command> [service ...]

Commands:
  check             Check Docker, compose configuration and host resources.
  build <service>   Build one service: api|worker-node|rag|frontend.
  build-all         Build api, worker-node, rag and frontend serially.
  redeploy [svc...] Recreate already-built services without implicit builds.
  verify            Check all containers and run the FFmpeg/FFprobe smoke test.
  cleanup-preview   List cleanup candidates; never deletes resources.
  cleanup-image ID  Remove one full-ID dangling ProjectDream service image after safety checks.
EOF
}

main() {
  local command="${1:-}"
  [[ -n "$command" ]] || { usage; exit 2; }
  shift || true
  require_tools
  acquire_deploy_lock
  case "$command" in
    check)
      validate_compose
      resource_snapshot
      compose ps
      ;;
    build)
      [[ $# == 1 ]] || die 'build requires exactly one service'
      validate_compose
      build_service "$1"
      ;;
    build-all)
      build_all
      ;;
    redeploy)
      validate_compose
      redeploy "$@"
      ;;
    verify)
      validate_compose
      verify
      ;;
    cleanup-preview)
      cleanup_preview
      ;;
    cleanup-image)
      cleanup_image "$@"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

if [[ "${DEPLOY_PRODUCTION_LIBRARY_ONLY:-0}" != 1 ]]; then
  main "$@"
fi
