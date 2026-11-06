import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTextModelHistory } from './model-history.ts'

test('builds a de-duplicated text model history with current model first', () => {
  const result = buildTextModelHistory(
    'current-model',
    [
      { key: 'AI_MODEL', value: 'default-model' },
      { key: 'AI_MODEL_SCRIPT', value: 'script-model' },
      { key: 'FRAME_MODEL', value: 'image-model' },
    ],
    ['script-model', 'older-model'],
  )
  assert.deepEqual(result, ['current-model', 'default-model', 'script-model', 'older-model'])
})
