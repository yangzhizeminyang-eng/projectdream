import assert from 'node:assert/strict'
import test from 'node:test'

import { generateStoryboards } from './storyboard.mjs'
import { buildStoryboardPrompts } from './prompts/storyboard.mjs'

test('storyboard prompt separates prop identity references from prop asset-sheet instructions', () => {
  const { systemPrompt, userPrompt } = buildStoryboardPrompts({
    scene: { title: '档案室取证', location: '旧档案室' },
    project: { name: '悬疑短剧' },
    scriptContent: '唐宁从第三层抽出蓝色档案盒。',
    assetCatalog: {
      props: [{
        name: '蓝色档案盒',
        promptText: '纯白背景，完整结构居中，单件道具资产，完整展示，不要场景。',
      }],
    },
  })

  assert.match(userPrompt, /道具资产清单：蓝色档案盒/u)
  assert.doesNotMatch(userPrompt, /纯白背景，完整结构居中/u)
  assert.match(systemPrompt, /资产参考图只锁定角色\/道具身份/u)
  assert.match(systemPrompt, /剧情镜头必须根据剧本写场景、人物或道具动作、空间关系、机位和景别/u)
  assert.match(systemPrompt, /禁止继承资产图的白底、居中陈列、安全边距、完整产品展示/u)
  assert.match(systemPrompt, /精确可读的中文正文、账号、编号交由后期合成/u)
  assert.match(systemPrompt, /每镜只设一个可见主事件/u)
  assert.match(systemPrompt, /动作事件超过两个或无法在镜头时长内完成时必须拆镜/u)
})

test('storyboard prompt prefers RAG memory when the sidecar returns context', () => {
  const { userPrompt } = buildStoryboardPrompts({
    scene: { episode_no: 1, title: '值班台', content: '林知夏看向窗口。' },
    project: { name: '夜班', visualStyle: '半写实' },
    scriptContent: '林知夏看向窗口。',
    ragContext: [{
      text: '传送窗口位于值班台左侧，红色发卡从活动托盘滑出。',
      score: 0.91,
      metadata: { asset_type: 'scene' },
    }],
  })

  assert.match(userPrompt, /项目记忆检索上下文/u)
  assert.match(userPrompt, /传送窗口位于值班台左侧/u)
})

test('storyboard generation falls back to editable shots when the configured text model is unavailable', async () => {
  const originalEnv = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    AI_MODEL_STORYBOARD: process.env.AI_MODEL_STORYBOARD,
    AI_FALLBACK_TO_MOCK: process.env.AI_FALLBACK_TO_MOCK,
  }
  Object.assign(process.env, {
    AI_PROVIDER: 'openai-compatible',
    AI_BASE_URL: 'http://127.0.0.1:1/v1',
    AI_API_KEY: 'test-key',
    AI_MODEL: 'test-model',
    AI_MODEL_STORYBOARD: 'test-model',
    AI_FALLBACK_TO_MOCK: 'true',
  })

  try {
    const result = await generateStoryboards({
      sceneId: 9,
      scene: {
        scene_no: 1,
        title: '雨夜来电',
        location: '旧城区街口',
        time_of_day: '深夜',
        estimated_duration: 60,
      },
      project: {
        name: '回声',
        visualStyle: '都市悬疑',
      },
      scriptContent: '林夏在雨夜接起电话。\n\n电话那头传来一段熟悉的录音。',
      characters: [{ name: '林夏', gender: '女', age_group: '青年' }],
    })

    assert.equal(result.scene_id, 9)
    assert.ok(result.shots.length >= 4)
    assert.ok(result.shots.every((shot) => shot.visual_prompt && shot.action_text))
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('storyboard generation does not fabricate shots when real fallback is disabled', async () => {
  const originalEnv = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    AI_MODEL_STORYBOARD: process.env.AI_MODEL_STORYBOARD,
    AI_FALLBACK_TO_MOCK: process.env.AI_FALLBACK_TO_MOCK,
  }
  Object.assign(process.env, {
    AI_PROVIDER: 'openai-compatible',
    AI_BASE_URL: 'http://127.0.0.1:1/v1',
    AI_API_KEY: 'test-key',
    AI_MODEL: 'test-model',
    AI_MODEL_STORYBOARD: 'test-model',
    AI_FALLBACK_TO_MOCK: 'false',
  })

  try {
    await assert.rejects(
      () =>
        generateStoryboards({
          sceneId: 10,
          scene: { title: '真实场景', location: '公寓客厅', time_of_day: '深夜' },
          project: { name: '真实项目', visualStyle: '都市悬疑' },
          scriptContent: '林默在客厅打开电脑。',
          characters: [{ name: '林默' }],
        }),
      /AI 请求失败|连接|fetch failed/i,
    )
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('storyboard generation retries one invalid timing plan and accepts a corrected result', async () => {
  const originalEnv = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    AI_MODEL_STORYBOARD: process.env.AI_MODEL_STORYBOARD,
    AI_FALLBACK_TO_MOCK: process.env.AI_FALLBACK_TO_MOCK,
  }
  const originalFetch = globalThis.fetch
  Object.assign(process.env, {
    AI_PROVIDER: 'openai-compatible',
    AI_BASE_URL: 'https://text-model.example/v1',
    AI_API_KEY: 'test-key',
    AI_MODEL: 'test-model',
    AI_MODEL_STORYBOARD: 'test-model',
    AI_FALLBACK_TO_MOCK: 'false',
  })
  const requests = []
  const payloads = [
    { scene_id: 9, shots: [{ shot_no: '01', duration_seconds: 0 }] },
    { scene_id: 9, shots: [{
      shot_no: '01',
      duration_seconds: 5,
      duration_breakdown: [{ phase: '动作', seconds: 3, observable: '人物抬头' }, { phase: '停顿', seconds: 2, observable: '视线停住' }],
      duration_basis: '动作和反应停顿共需五秒。',
      dialogue_text: '（无对白）',
      action_text: '林夏抬头看向門口。',
    }] },
  ]
  globalThis.fetch = async (_url, options = {}) => {
    requests.push(JSON.parse(String(options.body || '{}')))
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payloads[requests.length - 1]) } }],
    }), { status: 200 })
  }

  try {
    const result = await generateStoryboards({
      sceneId: 9,
      scene: { id: 9, title: '门口', location: '值班室' },
      project: { name: '测试项目', visualStyle: '半写实' },
      scriptContent: '林夏抬头看向门口。',
      characters: [{ name: '林夏' }],
    })

    assert.equal(requests.length, 2)
    assert.match(requests[1].messages[1].content, /上一次输出未通过时长或镜头内时间轴契约/u)
    assert.equal(result.shots[0].duration_seconds, 5)
    assert.equal(result.shots[0].duration_breakdown.length, 2)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
