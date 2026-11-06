import assert from 'node:assert/strict'
import test from 'node:test'

import { createStoreZip, crc32, readStoreZipEntries } from './zip-archive.mjs'

test('store zip round-trips entries without a compression library', () => {
  const zip = createStoreZip([
    { path: 'materials/01_镜头.mp4', content: Buffer.from('fake-video-bytes') },
    { path: 'audio/对白/01_DLG.mp3', content: Buffer.from('fake-audio') },
    { path: 'README.md', content: '# 交付包\n' },
  ])

  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'zip 必须以本地文件头签名开头')

  const entries = readStoreZipEntries(zip)
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['materials/01_镜头.mp4', 'audio/对白/01_DLG.mp3', 'README.md'],
  )
  for (const entry of entries) {
    assert.equal(entry.method, 0, '交付包使用 store 模式')
    assert.equal(entry.crc32, entry.computedCrc32, 'CRC32 必须与内容一致')
  }
  assert.equal(entries[0].content.toString('utf8'), 'fake-video-bytes')
  assert.equal(entries[2].content.toString('utf8'), '# 交付包\n')
})

test('store zip is byte-stable for the same input', () => {
  const build = () =>
    createStoreZip([{ path: 'a.txt', content: 'same' }, { path: 'b/c.txt', content: 'same' }])
  assert.ok(build().equals(build()))
})

test('crc32 matches the reference value for a known payload', () => {
  // "123456789" 的标准 CRC32 结果
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('store zip rejects unsafe paths and empty names', () => {
  assert.throws(() => createStoreZip([{ path: '../escape.txt', content: 'x' }]), /非法的 ZIP 条目路径/)
  assert.throws(() => createStoreZip([{ path: '', content: 'x' }]), /非法的 ZIP 条目路径/)
})

test('a folder-only zip is still a valid archive', () => {
  const zip = createStoreZip([])
  assert.equal(readStoreZipEntries(zip).length, 0)
})
