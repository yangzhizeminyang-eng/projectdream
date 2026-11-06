import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildScriptAgentActivityPayload,
  buildScriptAgentReaction,
  getScriptAgentAction,
  normalizeScriptAgentActivityInput,
} from './script-agent.mjs'

test('normalizes supported script actions with durable agent metadata', () => {
  const activity = normalizeScriptAgentActivityInput({
    actionKey: 'generate-bible',
    source: 'button',
    context: { stage: 'bible' },
  })

  assert.equal(activity.agentKey, 'script-agent')
  assert.equal(activity.stageKey, 'bible')
  assert.equal(activity.status, 'running')
  assert.equal(activity.title, '重新生成故事设定')
})

test('rejects unknown actions and invalid statuses', () => {
  assert.throws(() => normalizeScriptAgentActivityInput({ actionKey: 'chat-only' }), /未知 Script Agent 动作/)
  assert.throws(() => normalizeScriptAgentActivityInput({ actionKey: 'save-script', status: 'queued' }), /无效 Script Agent 状态/)
})

test('returns a working reaction without pretending the action is complete', () => {
  const reaction = buildScriptAgentReaction({
    actionKey: 'generate-season',
    status: 'running',
    summary: '正在检查故事设定版本。',
  })

  assert.equal(reaction.tone, 'working')
  assert.match(reaction.headline, /已开始/)
  assert.deepEqual(reaction.nextActions, [])
})

test('turns a completed story bible action into concrete review steps', () => {
  const reaction = buildScriptAgentReaction({
    actionKey: 'generate-bible',
    status: 'completed',
    result: {
      versionNo: 3,
      characterCount: 4,
      locationCount: 3,
      changed: ['主线冲突已更新'],
    },
  })

  assert.equal(reaction.tone, 'success')
  assert.match(reaction.facts[0], /第 3 版/)
  assert.ok(reaction.nextActions.some((item) => item.label.includes('4 个角色')))
  assert.ok(reaction.nextActions.some((item) => item.label.includes('3 个主要场景')))
})

test('reports failed actions with a real retry action', () => {
  const reaction = buildScriptAgentReaction({
    actionKey: 'generate-script',
    status: 'failed',
    errorText: '文本模型额度不足',
  })

  assert.equal(reaction.tone, 'danger')
  assert.equal(reaction.nextActions[0].actionKey, 'generate-script')
  assert.match(reaction.message, /额度不足/)
})

test('registers the batch scene正文 action with a resumable next step', () => {
  const activity = normalizeScriptAgentActivityInput({ actionKey: 'generate-all-scenes' })
  assert.equal(activity.title, '批量生成全部剧集正文')
  assert.equal(activity.stageKey, 'script')
  assert.equal(activity.status, 'running')
})

test('asset parsing points to the asset workspace after completion', () => {
  const payload = buildScriptAgentActivityPayload({
    actionKey: 'parse-assets',
    status: 'completed',
    result: { characterCount: 2, sceneCount: 5 },
  })

  assert.equal(payload.reaction.agentKey, 'asset-parser-agent')
  assert.equal(payload.reaction.nextActions[0].actionKey, 'open-assets')
  assert.match(payload.reaction.nextActions[0].label, /2 个角色 \/ 5 个场景/)
})

test('exposes action metadata for a future registered adapter', () => {
  assert.deepEqual(getScriptAgentAction('generate-script').nextAction, {
    key: 'parse-assets',
    label: '解析角色与场景资产',
    actionKey: 'parse-assets',
  })
})
