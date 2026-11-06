// FastAPI-Only 迁移第六阶段：部署脚本断言对齐新 compose 服务名（api/worker-node/rag/frontend/mysql）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { platform } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = readFileSync(new URL('./deploy-production.sh', import.meta.url), 'utf8')
const redeploy = source.match(/redeploy\(\) \{([\s\S]*?)\n\}/)?.[1]

function runVerifyHarness({ missingHealth = '', unhealthyService = '' } = {}) {
  const bash = process.env.BASH || (platform() === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash')
  const scriptPath = resolve(fileURLToPath(new URL('./deploy-production.sh', import.meta.url)))
  const deployScript = platform() === 'win32'
    ? scriptPath.replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
    : scriptPath
  return spawnSync(bash, ['-c', `
    source "$DEPLOY_SCRIPT"
    container_id() { printf 'container-%s' "$1"; }
    docker() {
      [[ "$1" == inspect ]] || return 2
      case "$3" in
        '{{.State.Status}}') printf 'running';;
        *)
          service="\${4#container-}"
          [[ "$service" != "$MISSING_HEALTH" ]] || return 0
          [[ "$service" != "$UNHEALTHY_SERVICE" ]] && printf 'healthy' || printf 'unhealthy'
          ;;
      esac
    }
    compose() {
      case "$*" in
        'exec -T worker-node ffmpeg -version') printf 'ffmpeg\\n';;
        'exec -T worker-node ffprobe -version') printf 'ffprobe\\n';;
        'exec -T worker-node sh -lc '*) return 0;;
        *) printf 'unexpected compose call: %s\\n' "$*" >&2; return 2;;
      esac
    }
    curl() { return 0; }
    verify
  `], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEPLOY_SCRIPT: deployScript,
      DEPLOY_PRODUCTION_LIBRARY_ONLY: '1',
      COMPOSE_PROJECT_NAME: 'projectdream',
      HTTP_PORT: '8002',
      MISSING_HEALTH: missingHealth,
      UNHEALTHY_SERVICE: unhealthyService,
    },
  })
}

test('production redeploy snapshots all rollback images before replacing any service', () => {
  assert.ok(redeploy, 'redeploy function exists')
  const snapshotLoop = redeploy.indexOf('for service in "$@"; do')
  const firstComposeUp = redeploy.indexOf('compose up -d --no-build --force-recreate')
  assert.ok(snapshotLoop >= 0 && snapshotLoop < firstComposeUp)
  assert.match(redeploy.slice(snapshotLoop, firstComposeUp), /docker tag "\$old_id" "\$rollback_ref"/)
  assert.match(redeploy, /compose up -d --no-build --force-recreate "\$service"/)
})

test('production redeploy validates the whole stack before deleting temporary rollback tags', () => {
  assert.ok(redeploy, 'redeploy function exists')
  const stackVerify = redeploy.indexOf('verify')
  const rollbackTagRemoval = redeploy.indexOf('docker image rm "$rollback_ref"')
  assert.ok(stackVerify >= 0 && rollbackTagRemoval > stackVerify)
})

test('production verification does not treat a worker without a healthcheck as healthy', () => {
  const verify = source.match(/verify\(\) \{([\s\S]*?)\n\}/)?.[1]
  const wait = source.match(/wait_for_service\(\) \{([\s\S]*?)\n\}/)?.[1]
  assert.match(verify, /\[\[ -n "\$health" \]\] \|\| die/)
  assert.match(verify, /\[\[ "\$health" == healthy \]\] \|\| die/)
  assert.doesNotMatch(verify, /-z "\$health"/)
  assert.match(wait, /worker.*healthcheck|healthcheck.*worker/i)
  assert.match(redeploy, /wait_for_service "\$service" 1/)
  assert.match(wait, /allow_legacy_worker/)
})

test('protected build and redeploy commands cover the FastAPI-only service set', () => {
  const allowed = source.match(/service_allowed\(\) \{([\s\S]*?)\n\}/)?.[1]
  const buildAll = source.match(/build_all\(\) \{([\s\S]*?)\n\}/)?.[1]
  assert.match(allowed, /api\|worker-node\|rag\|frontend/)
  assert.match(buildAll, /for service in api worker-node rag frontend;/)
  assert.match(source, /set -- api worker-node rag frontend/)
  assert.match(source, /Build one service: api\|worker-node\|rag\|frontend/)
})

test('runtime stack verification accepts only five healthy services', () => {
  const healthy = runVerifyHarness()
  assert.equal(healthy.status, 0, `${healthy.stdout}\n${healthy.stderr}`)
  assert.match(healthy.stdout, /verification complete/)

  for (const result of [
    runVerifyHarness({ missingHealth: 'api' }),
    runVerifyHarness({ unhealthyService: 'frontend' }),
  ]) {
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(result.stdout, /verification complete/)
  }
})

test('production stack verification failure returns control to the batch rollback handler', () => {
  assert.ok(redeploy, 'redeploy function exists')
  assert.match(redeploy, /if ! \(verify\); then\s+deploy_failed=1/)
})

test('production redeploy rolls back every service in the batch when any health gate fails', () => {
  assert.ok(redeploy, 'redeploy function exists')
  assert.match(redeploy, /deploy_failed=1/)
  assert.match(redeploy, /for service in "\$\{services\[@\]\}"; do[\s\S]*docker tag "\$rollback_ref" "\$target_ref"/)
  assert.match(redeploy, /service deployment failed; the requested batch was rolled back/)
})

test('a later service failure restores earlier services and retains rollback tags', () => {
  const bash = process.env.BASH || (platform() === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash')
  const scriptPath = resolve(fileURLToPath(new URL('./deploy-production.sh', import.meta.url)))
  const deployScript = platform() === 'win32'
    ? scriptPath.replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
    : scriptPath
  const result = spawnSync(bash, ['-c', `
    source "$DEPLOY_SCRIPT"
    API_WAIT_COUNT=0
    container_id() { printf 'container-%s' "$1"; }
    docker() {
      if [[ "$1" == inspect ]]; then printf 'sha256-old-%s' "$4"; return; fi
      printf 'EVENT docker:%s\\n' "$*"
    }
    compose() { printf 'EVENT compose:%s\\n' "$*"; }
    wait_for_service() {
      printf 'EVENT wait:%s\\n' "$1"
      if [[ "$1" == api && "$API_WAIT_COUNT" == 0 ]]; then
        API_WAIT_COUNT=1
        return 1
      fi
      return 0
    }
    verify() { printf 'EVENT verify\\n'; }
    redeploy worker-node api
  `], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEPLOY_SCRIPT: deployScript,
      DEPLOY_PRODUCTION_LIBRARY_ONLY: '1',
      COMPOSE_PROJECT_NAME: 'projectdream',
    },
  })

  assert.equal(result.status, 1)
  const events = result.stdout + result.stderr
  const firstDeploy = events.indexOf('EVENT compose:up -d --no-build --force-recreate worker-node')
  const apiFailure = events.indexOf('EVENT wait:api')
  const workerNodeRestore = events.lastIndexOf('EVENT compose:up -d --no-build --force-recreate worker-node')
  const apiRestore = events.lastIndexOf('EVENT compose:up -d --no-build --force-recreate api')
  assert.ok(firstDeploy >= 0 && apiFailure > firstDeploy, events)
  assert.ok(workerNodeRestore > apiFailure && apiRestore > workerNodeRestore)
  assert.match(events, /rollback-\d{8}-\d{6}/)
  assert.match(events, /requested batch was rolled back and rollback image tags were retained/)
  assert.doesNotMatch(events, /EVENT verify/)
  assert.doesNotMatch(events, /EVENT docker:image rm/)
})

test('cleanup preview only marks dangling images with no container references as candidates', () => {
  const bash = process.env.BASH || (platform() === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash')
  const scriptPath = resolve(fileURLToPath(new URL('./deploy-production.sh', import.meta.url)))
  const deployScript = platform() === 'win32'
    ? scriptPath.replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
    : scriptPath
  const result = spawnSync(bash, ['-c', `
    source "$DEPLOY_SCRIPT"
    container_id() { printf 'running-api'; }
    compose() { :; }
    docker() {
      case "$1 $2" in
        'inspect -f') printf 'sha256:active\\n';;
        'image ls') printf 'sha256:active\\nsha256:latest\\nsha256:rollback\\nsha256:dangling-free\\nsha256:dangling-used\\n';;
        'image inspect')
          case "$4" in
            *RepoTags*)
              case "$5" in
                sha256:active|sha256:latest) printf 'projectdream-api:latest';;
                sha256:rollback) printf 'projectdream-api:rollback-20261016-120000';;
                *) printf '<none>:<none>';;
              esac
              ;;
            *service*) printf 'api';;
            *Size*) printf '1024';;
            *Created*) printf '2026-10-16T00:00:00Z';;
          esac
          ;;
        'ps -a')
          case "$*" in *ancestor=sha256:dangling-used*) printf 'old-container\\n';; esac
          ;;
        *) printf 'unexpected docker call: %s\\n' "$*" >&2; return 2;;
      esac
    }
    cleanup_preview
  `], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEPLOY_SCRIPT: deployScript,
      DEPLOY_PRODUCTION_LIBRARY_ONLY: '1',
      COMPOSE_PROJECT_NAME: 'projectdream',
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /candidate id=sha256:dangling-free/)
  assert.match(result.stdout, /virtual_size=1024/)
  assert.match(result.stdout, /shared image layers can make actual reclaimed disk space lower/)
  assert.doesNotMatch(result.stdout, /candidate.*sha256:(active|latest|rollback|dangling-used)/)
  assert.match(result.stdout, /preserved reason=container-reference id=sha256:dangling-used/)
  assert.match(result.stdout, /preserved.*projectdream-api:rollback-/)
})

test('cleanup preview stops when Docker image enumeration or container-reference checks fail', () => {
  const bash = process.env.BASH || (platform() === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash')
  const scriptPath = resolve(fileURLToPath(new URL('./deploy-production.sh', import.meta.url)))
  const deployScript = platform() === 'win32'
    ? scriptPath.replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
    : scriptPath

  for (const failAt of ['image-list', 'container-reference']) {
    const result = spawnSync(bash, ['-c', `
      source "$DEPLOY_SCRIPT"
      container_id() { printf 'running-api'; }
      compose() { :; }
      docker() {
        case "$1 $2" in
          'inspect -f') printf 'sha256:active\\n';;
          'image ls')
            [[ "$FAIL_AT" != image-list ]] || return 9
            printf 'sha256:active\\nsha256:dangling\\n'
            ;;
          'image inspect')
            case "$4" in
              *RepoTags*)
                case "$5" in sha256:active) printf 'projectdream-api:latest';; *) printf '<none>:<none>';; esac
                ;;
              *service*) printf 'api';;
              *Size*) printf '1024';;
              *Created*) printf '2026-10-16T00:00:00Z';;
            esac
            ;;
          'ps -a')
            [[ "$FAIL_AT" != container-reference ]] || return 9
            ;;
          *) return 2;;
        esac
      }
      cleanup_preview
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPLOY_SCRIPT: deployScript,
        DEPLOY_PRODUCTION_LIBRARY_ONLY: '1',
        COMPOSE_PROJECT_NAME: 'projectdream',
        FAIL_AT: failAt,
      },
    })

    assert.equal(result.status, 1, `${failAt}: ${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(result.stdout, /--- exited containers ---/)
  }
})

test('explicit image cleanup accepts only full-ID dangling images from approved ProjectDream services', () => {
  const bash = process.env.BASH || (platform() === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash')
  const scriptPath = resolve(fileURLToPath(new URL('./deploy-production.sh', import.meta.url)))
  const deployScript = platform() === 'win32'
    ? scriptPath.replace(/^([A-Z]):/i, (_, drive) => `/${drive.toLowerCase()}`).replaceAll('\\', '/')
    : scriptPath
  const imageId = `sha256:${'a'.repeat(64)}`

  for (const mode of ['safe', 'safe-worker', 'tagged', 'other-project', 'unsupported-service', 'referenced', 'short-id']) {
    const result = spawnSync(bash, ['-c', `
      source "$DEPLOY_SCRIPT"
      docker() {
        case "$1 $2" in
          'image inspect')
            case "$4" in
              *RepoTags*) [[ "$MODE" != tagged ]] && printf '[]' || printf '["projectdream-api:rollback"]';;
              *project*) [[ "$MODE" == other-project ]] && printf 'another-project' || printf 'projectdream';;
              *service*)
                [[ "$MODE" == safe-worker ]] && printf 'worker-node' || {
                  [[ "$MODE" != unsupported-service ]] && printf 'api' || printf 'unknown'
                }
                ;;
              *) return 2;;
            esac
            ;;
          'ps -a')
            if [[ "$MODE" == referenced ]]; then printf 'referencing-container\\n'; fi
            return 0
            ;;
          'image rm') printf 'EVENT image-rm:%s\\n' "$*";;
          *) printf 'unexpected docker call: %s\\n' "$*" >&2; return 2;;
        esac
      }
      cleanup_image "$IMAGE_ID"
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPLOY_SCRIPT: deployScript,
        DEPLOY_PRODUCTION_LIBRARY_ONLY: '1',
        MODE: mode,
        IMAGE_ID: mode === 'short-id' ? '8fde018fb6f5' : imageId,
      },
    })

    if (mode === 'safe' || mode === 'safe-worker') {
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /EVENT image-rm:image rm sha256:/)
      assert.doesNotMatch(result.stdout, /image rm -f/)
    } else {
      assert.equal(result.status, 1, `${mode}: ${result.stdout}\n${result.stderr}`)
      assert.doesNotMatch(result.stdout, /EVENT image-rm/)
    }
  }
})
