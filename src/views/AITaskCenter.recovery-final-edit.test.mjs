import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./AITaskCenter.vue', import.meta.url), 'utf8')

test('task center exposes an explicit rollback action for recovery final-edit exports', () => {
  assert.match(source, /rollbackRecoveryVideoFinalEdit/)
  assert.match(source, /handleRecoveryFinalEditRollback/)
  assert.match(source, /v-if="selectedTask\.isRecoveryFinalEdit && selectedTask\.canRollback"/)
  assert.match(source, /@click="handleRecoveryFinalEditRollback\(selectedTask\)"/)
})

test('task center labels recovery rework as candidate regeneration instead of final edit', () => {
  assert.match(source, /重新生成候选/)
  assert.match(source, /regenerate-recovery-candidate/)
  assert.match(source, /reworkReasons/)
})
