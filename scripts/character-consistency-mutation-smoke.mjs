// FastAPI-Only 迁移第六阶段：隔离 mock 后端由 Node 服务切换为 FastAPI（uvicorn + mock providers，
// 经 /api/health 就绪探测与 /api 业务端点执行 P5 越权与角色一致性冒烟）。
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import mysql from 'mysql2/promise'

function text(value) {
  return String(value ?? '').trim()
}

function apiBaseUrl(port) {
  return `http://127.0.0.1:${port}/api`
}

function isSuccess(response, label) {
  if (response.status < 200 || response.status >= 300 || response.body?.code !== 0) {
    throw new Error(
      `${label}: HTTP ${response.status} (${response.body?.message || '请求失败'})`,
    )
  }
  return response.body.data
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  })
  let body
  try {
    body = await response.json()
  } catch {
    body = { message: '响应不是 JSON' }
  }
  return { status: response.status, body }
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function postJson(baseUrl, path, token, body, label) {
  return isSuccess(
    await requestJson(`${baseUrl}${path}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),
    label,
  )
}

async function putJson(baseUrl, path, token, body, label) {
  return isSuccess(
    await requestJson(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),
    label,
  )
}

async function getJson(baseUrl, path, token, label) {
  return isSuccess(
    await requestJson(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    label,
  )
}

async function waitForHealth(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await requestJson(`${baseUrl}/health`)
      if (response.status === 200 && response.body?.code === 0) return
      lastError = new Error(`health HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`隔离 mock 服务未在时限内启动：${lastError?.message || 'unknown error'}`)
}

/**
 * 启动隔离 mock 后端（FastAPI）。
 *
 * FastAPI-Only 第六阶段：原实现 spawn Node 服务作为隔离 mock；现改为在
 * api-service/ 目录下启动 uvicorn（app.main:app），并注入 mock 供应商环境
 * 变量（AI/FRAME/VIDEO/AUDIO 均 mock）与本地数据库配置，保证无外部依赖。
 *
 * @param {number} port 隔离后端监听端口。
 * @returns {{ child: import('node:child_process').ChildProcess, output: string[] }} 子进程与日志缓冲。
 */
function startMockServer(port) {
  const output = []
  const db = dbConfig()
  const pythonBin = text(process.env.SMOKE_PYTHON) || 'python'
  const child = spawn(
    pythonBin,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      // FastAPI 应用以 api-service/ 为根，uvicorn 需在该目录下才能导入 app.main。
      cwd: path.join(process.cwd(), 'api-service'),
      env: {
        ...process.env,
        API_PORT: String(port),
        DB_HOST: db.host,
        DB_PORT: String(db.port),
        DB_USER: db.user,
        DB_PASSWORD: db.password,
        DB_NAME: db.database,
        AI_PROVIDER: 'mock',
        FRAME_PROVIDER: 'mock',
        VIDEO_PROVIDER: 'mock',
        AUDIO_PROVIDER: 'mock',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const append = (chunk) => {
    output.push(String(chunk))
    if (output.length > 30) output.shift()
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  return { child, output }
}

async function stopMockServer(server) {
  if (!server?.child || server.child.exitCode !== null) return
  server.child.kill()
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    server.child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function dbConfig() {
  return {
    host: text(process.env.DB_HOST || '127.0.0.1'),
    port: Number(process.env.DB_PORT || 3306),
    user: text(process.env.DB_USER || 'root'),
    password: process.env.DB_PASSWORD || '',
    database: text(process.env.DB_NAME || 'projectdream'),
  }
}

async function createTemporaryIntruder(db) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 8), 16) % 100_000_000
    const phone = `139${String(suffix).padStart(8, '0')}`
    const password = randomUUID().replaceAll('-', '')
    try {
      const [result] = await db.execute(
        `INSERT INTO users (phone, nickname, password_hash)
         VALUES (?, ?, ?)`,
        [
          phone,
          'P5 越权冒烟账号',
          createHash('sha256').update(password).digest('hex'),
        ],
      )
      return {
        id: Number(result.insertId),
        phone,
        password,
      }
    } catch (error) {
      if (error?.code !== 'ER_DUP_ENTRY') throw error
    }
  }
  throw new Error('无法创建唯一的跨用户冒烟账号')
}

async function createFixtureSceneAndFrame(db, { projectId, character, versionNo }) {
  const [sceneResult] = await db.execute(
    `INSERT INTO script_scenes
      (project_id, scene_no, title, summary, content, mood, location, time_of_day,
       estimated_duration, sort_order, status)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, 5, 0, 'storyboard_ready')`,
    [
      projectId,
      'P5 冒烟场景',
      '角色在档案室确认一条线索。',
      '冒烟角色在档案室看向镜头。',
      '悬疑、克制',
      '档案室',
      '夜晚',
    ],
  )
  const sceneId = Number(sceneResult.insertId)
  const [storyboardResult] = await db.execute(
    `INSERT INTO storyboards
      (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
       character_id, character_name, action_text, dialogue_text, visual_prompt, sort_order, status)
     VALUES (?, '1', '中景', '平视', '居中构图', 5, ?, ?, ?, ?, ?, 0, 'pending')`,
    [
      sceneId,
      character.id,
      character.name,
      `${character.name}站在档案室灯下，抬头观察墙上的文件。`,
      `${character.name}：线索就在这里。`,
      `${character.name}站在夜晚档案室，电影感中景。`,
    ],
  )
  const storyboardId = Number(storyboardResult.insertId)
  const snapshot = buildOldFrameCharacterSnapshot({
    characterId: character.id,
    versionNo,
    name: character.name,
    appearance: character.appearance,
    costume: character.costume,
    referenceImageUrl: character.referenceImageUrl,
  })
  const [imageResult] = await db.execute(
    `INSERT INTO image_assets
      (storyboard_id, version_no, image_url, thumbnail_url, prompt_snapshot, frame_role,
       negative_prompt, character_snapshot, model_name, status, confirmed_at)
     VALUES (?, 1, ?, ?, ?, 'primary', NULL, ?, 'smoke-frame-v1', 'confirmed', NOW())`,
    [
      storyboardId,
      'https://example.com/p5-smoke-frame.png',
      'https://example.com/p5-smoke-frame-thumb.png',
      `${character.name}在档案室，固定服装=${character.costume}`,
      JSON.stringify(snapshot),
    ],
  )
  await db.execute(
    `UPDATE storyboards SET image_url = ? WHERE id = ?`,
    ['https://example.com/p5-smoke-frame.png', storyboardId],
  )
  return {
    sceneId,
    storyboardId,
    imageAssetId: Number(imageResult.insertId),
  }
}

export function buildOldFrameCharacterSnapshot({
  characterId,
  versionNo,
  name,
  appearance,
  costume,
  referenceImageUrl,
}) {
  return {
    version: 1,
    primaryCharacterId: Number(characterId),
    characterFree: false,
    characters: [
      {
        characterId: Number(characterId),
        characterVersionNo: Number(versionNo),
        name: text(name),
        roleTag: '主角',
        gender: 'female',
        genderLabel: '女性',
        ageGroup: 'young_adult',
        ageGroupLabel: '青年（19-35岁）',
        appearance: text(appearance),
        costume: text(costume),
        referenceImageUrl: text(referenceImageUrl),
        isPrimary: true,
        inferredGender: false,
        inferredAge: false,
      },
    ],
  }
}

export function assertStaleVideoGateResponse(response) {
  if (response.status !== 409) {
    throw new Error(`旧静帧视频门禁: 预期 HTTP 409，实际 HTTP ${response.status}`)
  }
  const message = text(response.body?.message)
  if (!/旧角色版本|重新生成静帧/.test(message)) {
    throw new Error(`旧静帧视频门禁: 返回未说明版本过期，实际为“${message}”`)
  }
}

export function assertCrossUserDeniedResponse(response, label) {
  if (response.status !== 404) {
    throw new Error(`${label}: 预期 HTTP 404，实际 HTTP ${response.status}`)
  }
  if (Number(response.body?.code) !== 4004) {
    throw new Error(`${label}: 预期业务码 4004，实际 ${response.body?.code ?? 'empty'}`)
  }
  if (!/不存在或无权访问/.test(text(response.body?.message))) {
    throw new Error(`${label}: 返回未使用资源隐藏语义，实际为“${text(response.body?.message)}”`)
  }
}

async function login(baseUrl, options = {}) {
  const phone = text(options.phone || process.env.SMOKE_PHONE || '13912345678')
  const password = text(options.password || process.env.SMOKE_PASSWORD || '123456')
  const label = text(options.label || '隔离服务演示账号登录')
  const payload = isSuccess(
    await requestJson(`${baseUrl}/auth/login-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone,
        password,
      }),
    }),
    label,
  )
  const token = text(payload.token)
  if (!token) throw new Error(`${label}: 缺少 token`)
  return token
}

export async function runCharacterConsistencyMutationSmoke(options = {}) {
  const port = Number(options.port || process.env.SMOKE_PORT || 3012)
  const baseUrl = apiBaseUrl(port)
  const fixtureName = `P5-HTTP-SMOKE-${randomUUID().slice(0, 8)}`
  let server = null
  let db = null
  let projectId = null
  let temporaryUserId = null
  let temporaryUserPhone = ''

  try {
    server = startMockServer(port)
    await waitForHealth(baseUrl)
    const token = await login(baseUrl)
    db = await mysql.createConnection(dbConfig())
    const intruder = await createTemporaryIntruder(db)
    temporaryUserId = intruder.id
    temporaryUserPhone = intruder.phone
    const intruderToken = await login(baseUrl, {
      phone: intruder.phone,
      password: intruder.password,
      label: '隔离服务跨用户账号登录',
    })
    const project = await postJson(
      baseUrl,
      '/projects',
      token,
      {
        name: fixtureName,
        category: '验证',
        targetDuration: 30,
        narrativeVision: '只用于角色一致性 HTTP 冒烟验证。',
        visualStyle: '写实动漫',
        aspectRatio: '9:16',
      },
      '创建临时项目',
    )
    projectId = Number(project.id)
    if (!projectId) throw new Error('创建临时项目: 响应缺少项目 ID')

    const character = await postJson(
      baseUrl,
      `/projects/${projectId}/characters`,
      token,
      {
        name: '冒烟角色',
        roleTag: '主角',
        personality: '冷静、敏锐',
        appearance: '25岁女性，黑色短发，右眉有细疤。',
        costume: '深灰制服，银色识别牌。',
        ageGroup: 'young_adult',
        gender: 'female',
        voiceStyle: '低沉克制',
      },
      '创建临时角色',
    )
    const characterId = Number(character.id)
    if (!characterId) throw new Error('创建临时角色: 响应缺少角色 ID')

    const profiles = await getJson(baseUrl, '/voice-profiles', token, '读取音色库')
    const profile = (profiles.items || []).find((item) => item.gender === 'female') || profiles.items?.[0]
    if (!profile?.profileKey) throw new Error('读取音色库: 没有可用音色')
    await putJson(
      baseUrl,
      `/characters/${characterId}/voice-binding`,
      token,
      {
        voiceProfileKey: profile.profileKey,
        ageGroup: 'young_adult',
        gender: 'female',
        voiceStyle: '低沉克制',
        locked: true,
      },
      '锁定临时角色音色',
    )

    const [characterImageResult] = await db.execute(
      `INSERT INTO character_images
        (character_id, version_no, image_url, thumbnail_url, prompt_snapshot, model_name, status)
       VALUES (?, 1, ?, ?, ?, 'smoke-frame-v1', 'candidate')`,
      [
        characterId,
        'https://example.com/p5-smoke-reference.png',
        'https://example.com/p5-smoke-reference-thumb.png',
        '冒烟角色定妆图',
      ],
    )
    const characterImageId = Number(characterImageResult.insertId)
    await postJson(
      baseUrl,
      `/character-images/${characterImageId}/confirm`,
      token,
      {},
      '确认临时角色定妆图',
    )
    await putJson(
      baseUrl,
      `/characters/${characterId}/locks`,
      token,
      { group: 'costume', locked: true },
      '锁定临时角色服装',
    )
    await putJson(
      baseUrl,
      `/characters/${characterId}/locks`,
      token,
      { group: 'appearance', locked: true },
      '锁定临时角色外貌',
    )

    const versionsBeforeMutation = await getJson(
      baseUrl,
      `/characters/${characterId}/versions`,
      token,
      '读取锁定后的角色版本',
    )
    const oldVersionNo = Number(versionsBeforeMutation.current?.versionNo)
    if (!oldVersionNo) throw new Error('读取锁定后的角色版本: 缺少当前版本号')

    const currentCharacter = await getJson(
      baseUrl,
      `/characters/${characterId}`,
      token,
      '读取锁定后的角色档案',
    )
    const fixture = await createFixtureSceneAndFrame(db, {
      projectId,
      character: currentCharacter,
      versionNo: oldVersionNo,
    })

    const crossUserProjectReportResponse = await requestJson(
      `${baseUrl}/projects/${projectId}/character-consistency`,
      { headers: authHeaders(intruderToken) },
    )
    assertCrossUserDeniedResponse(crossUserProjectReportResponse, '越权读取项目一致性报告')

    const crossUserCharacterReadResponse = await requestJson(
      `${baseUrl}/characters/${characterId}`,
      { headers: authHeaders(intruderToken) },
    )
    assertCrossUserDeniedResponse(crossUserCharacterReadResponse, '越权读取角色')

    const crossUserCharacterMutationResponse = await requestJson(
      `${baseUrl}/characters/${characterId}`,
      {
        method: 'PUT',
        headers: authHeaders(intruderToken),
        body: JSON.stringify({ costume: '越权写入不得生效' }),
      },
    )
    assertCrossUserDeniedResponse(crossUserCharacterMutationResponse, '越权修改角色')

    const crossUserVideoResponse = await requestJson(
      `${baseUrl}/storyboards/${fixture.storyboardId}/videos/generate`,
      {
        method: 'POST',
        headers: authHeaders(intruderToken),
        body: JSON.stringify({ candidateCount: 1 }),
      },
    )
    assertCrossUserDeniedResponse(crossUserVideoResponse, '越权提交视频任务')

    await putJson(
      baseUrl,
      `/characters/${characterId}`,
      token,
      { costume: '黑色行动制服，银色识别牌。' },
      '更新临时角色服装',
    )
    await putJson(
      baseUrl,
      `/characters/${characterId}/locks`,
      token,
      { group: 'costume', locked: true },
      '重新锁定临时角色服装',
    )
    const versionsAfterMutation = await getJson(
      baseUrl,
      `/characters/${characterId}/versions`,
      token,
      '读取服装变更后的角色版本',
    )
    const currentVersionNo = Number(versionsAfterMutation.current?.versionNo)
    if (currentVersionNo <= oldVersionNo) {
      throw new Error(`角色版本未升级：旧版本 v${oldVersionNo}，当前版本 v${currentVersionNo}`)
    }

    const staleVideoResponse = await requestJson(
      `${baseUrl}/storyboards/${fixture.storyboardId}/videos/generate`,
      {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ candidateCount: 1 }),
      },
    )
    assertStaleVideoGateResponse(staleVideoResponse)

    const audioPayload = await postJson(
      baseUrl,
      `/projects/${projectId}/audio/generate`,
      token,
      {
        trackType: 'dialogue',
        storyboardId: fixture.storyboardId,
        characterId,
        text: '冒烟角色：线索就在这里。',
        candidateCount: 1,
      },
      '生成 mock 对白音频',
    )
    const audio = audioPayload.items?.[0]
    if (
      !audio ||
      Number(audio.characterVersionNo) !== currentVersionNo ||
      Number(audio.characterSnapshot?.characterVersionNo) !== currentVersionNo
    ) {
      throw new Error('对白音频没有写入当前角色版本快照')
    }

    return {
      temporaryProject: fixtureName,
      projectId,
      characterId,
      oldVersionNo,
      currentVersionNo,
      staleVideoStatus: staleVideoResponse.status,
      audioCharacterVersionNo: Number(audio.characterVersionNo),
      crossUserDeniedStatuses: {
        projectReport: crossUserProjectReportResponse.status,
        characterRead: crossUserCharacterReadResponse.status,
        characterMutation: crossUserCharacterMutationResponse.status,
        videoGeneration: crossUserVideoResponse.status,
      },
      cleanup: 'pending',
    }
  } finally {
    const cleanupErrors = []
    if (db && projectId) {
      try {
        const [result] = await db.execute(
          `DELETE FROM projects WHERE id = ? AND name = ?`,
          [projectId, fixtureName],
        )
        if (result.affectedRows !== 1) {
          throw new Error(`临时项目清理失败：预期删除 1 条项目记录，实际 ${result.affectedRows}`)
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (db && temporaryUserId) {
      try {
        await db.execute(`DELETE FROM sessions WHERE user_id = ?`, [temporaryUserId])
        const [result] = await db.execute(
          `DELETE FROM users WHERE id = ? AND phone = ?`,
          [temporaryUserId, temporaryUserPhone],
        )
        if (result.affectedRows !== 1) {
          throw new Error(`临时跨用户账号清理失败：预期删除 1 条用户记录，实际 ${result.affectedRows}`)
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    await db?.end()
    await stopMockServer(server)
    if (cleanupErrors.length) {
      throw new Error(cleanupErrors.map((error) => text(error?.message || error)).join('；'))
    }
  }
}

function isMainModule(moduleUrl, executablePath) {
  return Boolean(executablePath) && moduleUrl === pathToFileURL(executablePath).href
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCharacterConsistencyMutationSmoke()
    .then((result) => {
      console.log(JSON.stringify({ ...result, cleanup: 'completed' }, null, 2))
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
