import assert from 'node:assert/strict'
import test from 'node:test'
import { dedupeRunningActivities } from './script-agent-activities.ts'

test('keeps the newest running record for the same action and preserves distinct and finished records', () => {
  const records = [
    { id: 1, actionKey: 'generate-season', stageKey: 'season', status: 'completed' },
    { id: 2, actionKey: 'generate-season', stageKey: 'season', status: 'running' },
    { id: 3, actionKey: 'generate-script', stageKey: 'script', status: 'running' },
    { id: 4, actionKey: 'generate-season', stageKey: 'season', status: 'running' },
  ]

  assert.deepEqual(dedupeRunningActivities(records), [records[0], records[2], records[3]])
})
