import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))

test('frontend runtime libraries are excluded from backend production installs', () => {
  for (const dependency of ['vue', 'pinia', 'vue-router']) {
    assert.equal(packageJson.dependencies?.[dependency], undefined, `${dependency} must not be a backend production dependency`)
    assert.equal(typeof packageJson.devDependencies?.[dependency], 'string', `${dependency} must remain available to frontend builds`)
  }
})

test('Aliyun phone verification remains while the unused legacy SMS SDK is excluded', () => {
  assert.equal(typeof packageJson.dependencies?.['@alicloud/dypnsapi20170525'], 'string')
  assert.equal(packageJson.dependencies?.['@alicloud/dysmsapi20170525'], undefined)
})

test('production dependency overrides pin patched Moment and UUID releases', () => {
  assert.equal(packageJson.overrides?.moment, '2.31.0')
  assert.equal(packageJson.overrides?.uuid, '11.1.1')
})
