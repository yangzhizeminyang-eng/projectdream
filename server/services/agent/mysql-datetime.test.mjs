import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMysqlDateTime } from './mysql-datetime.mjs'

test('normalizes ISO timestamps and Date values for MySQL DATETIME', () => {
  assert.equal(
    normalizeMysqlDateTime('2026-10-01T18:36:00.797Z'),
    '2026-10-01 18:36:00',
  )
  assert.equal(
    normalizeMysqlDateTime(new Date('2026-10-01T18:36:59.999Z')),
    '2026-10-01 18:36:59',
  )
  assert.equal(normalizeMysqlDateTime(null), null)
})

test('rejects invalid timestamps instead of sending them to MySQL', () => {
  assert.throws(
    () => normalizeMysqlDateTime('not-a-date'),
    /无法转换为 MySQL DATETIME/,
  )
})
