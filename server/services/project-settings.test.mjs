import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeProjectUpdateInput } from './project-settings.mjs'

test('accepts a partial update and keeps only the fields that were sent', () => {
  const result = normalizeProjectUpdateInput({ name: '  零点回声  ' })

  assert.equal(result.error, undefined)
  assert.deepEqual(result.updates, [{ column: 'name', value: '零点回声' }])
})

test('rejects an empty name instead of writing a blank project title', () => {
  for (const value of ['', '   ', '\n\t']) {
    const result = normalizeProjectUpdateInput({ name: value })
    assert.match(result.error, /项目名/)
  }
})

test('rejects a name past the column limit so MySQL does not silently truncate', () => {
  const result = normalizeProjectUpdateInput({ name: '长'.repeat(201) })
  assert.match(result.error, /项目名/)
})

test('accepts the ratio labels the rest of the pipeline already understands', () => {
  for (const ratio of ['16:9', '9:16', '2.39:1', '1:1', '4：3', '自适应']) {
    const result = normalizeProjectUpdateInput({ aspectRatio: ratio })
    assert.equal(result.error, undefined, `${ratio} 应被接受`)
    assert.deepEqual(result.updates, [{ column: 'aspect_ratio', value: ratio }])
  }
})

test('rejects a ratio it cannot resolve rather than storing a value nothing can use', () => {
  for (const ratio of ['随便', '16比9', '0:9', 'abc']) {
    const result = normalizeProjectUpdateInput({ aspectRatio: ratio })
    assert.match(result.error, /画面比例/, `${ratio} 应被拒绝`)
  }
})

test('an empty ratio clears the declared value instead of storing an empty string', () => {
  const result = normalizeProjectUpdateInput({ aspectRatio: '  ' })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.updates, [{ column: 'aspect_ratio', value: null }])
})

test('rejects unknown fields instead of dropping them silently', () => {
  // 拼错字段名时静默忽略，用户会以为已经保存了
  const result = normalizeProjectUpdateInput({ visualSytle: '冷峻科幻' })
  assert.match(result.error, /不支持/)
  assert.match(result.error, /visualSytle/)
})

test('rejects an empty update so the route never issues a no-op query', () => {
  assert.match(normalizeProjectUpdateInput({}).error, /没有可更新/)
  // 完全没有请求体属于另一种情况：不是"没东西可改"，而是"没收到内容"
  assert.match(normalizeProjectUpdateInput().error, /无效/)
  assert.match(normalizeProjectUpdateInput(null).error, /无效/)
})

test('maps every creatable project field to its real column', () => {
  const result = normalizeProjectUpdateInput({
    name: '零点回声',
    category: '悬疑推理漫剧',
    narrativeVision: '一档深夜广播节目',
    visualStyle: '冷峻科幻，冷蓝金属与红色警示灯',
  })

  assert.equal(result.error, undefined)
  assert.deepEqual(result.updates, [
    { column: 'name', value: '零点回声' },
    { column: 'category', value: '悬疑推理漫剧' },
    { column: 'narrative_vision', value: '一档深夜广播节目' },
    { column: 'visual_style', value: '冷峻科幻，冷蓝金属与红色警示灯' },
  ])
})

test('long text fields clear to NULL when blanked out', () => {
  const result = normalizeProjectUpdateInput({ narrativeVision: '', visualStyle: '   ' })

  assert.equal(result.error, undefined)
  assert.deepEqual(result.updates, [
    { column: 'narrative_vision', value: null },
    { column: 'visual_style', value: null },
  ])
})
