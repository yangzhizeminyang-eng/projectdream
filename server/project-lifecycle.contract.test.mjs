import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const serverSource = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')

test('project deletion is owner-scoped and requires the exact displayed project name', () => {
  const routeStart = serverSource.indexOf('const projectDeletionMatch = pathname.match(')
  const routeEnd = serverSource.indexOf('const projectMatch = pathname.match(', routeStart)
  const route = serverSource.slice(routeStart, routeEnd)

  assert.notEqual(routeStart, -1)
  assert.match(route, /projectDeletionMatch && req\.method === 'DELETE'/)
  assert.match(route, /const confirmName = String\(body\.confirmName \|\| ''\)\.trim\(\)/)
  assert.match(route, /projectDeletionConfirmationName\(project\)/)
  assert.match(route, /fetchProjectForUser\(projectId, user\.id\)/)
  assert.match(route, /DELETE FROM projects WHERE id = \? AND user_id = \?/)
  assert.match(route, /connection\.beginTransaction\(\)/)
  assert.match(route, /connection\.commit\(\)/)
})

test('project deletion uses the same fallback name shown for corrupted projects', () => {
  assert.match(serverSource, /function projectDeletionConfirmationName\(project\)/)
  assert.match(serverSource, /未命名项目 PF-\$\{String\(project\?\.id \|\| ''\)\.padStart\(3, '0'\)\}/)
})
