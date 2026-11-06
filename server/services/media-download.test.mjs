import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { downloadMediaToFile } from './media-download.mjs'

test('downloads from object storage before attempting a fragile public media URL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'projectdream-media-download-'))
  const targetPath = path.join(directory, 'clip.mp4')
  let fetchCalls = 0

  try {
    await downloadMediaToFile({
      sourceUrl: 'https://example.invalid/clip.mp4',
      storageKey: 'projects/12/videos/clip.mp4',
      targetPath,
      storage: {
        async getObject(key) {
          assert.equal(key, 'projects/12/videos/clip.mp4')
          return { bytes: Buffer.from('from-cos') }
        },
      },
      fetchImpl: async () => {
        fetchCalls += 1
        throw new Error('public URL should not be used when storageKey is available')
      },
    })

    assert.equal(await readFile(targetPath, 'utf8'), 'from-cos')
    assert.equal(fetchCalls, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('falls back to the source URL when the object storage copy is unavailable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'projectdream-media-download-'))
  const targetPath = path.join(directory, 'audio.wav')

  try {
    await downloadMediaToFile({
      sourceUrl: 'https://example.test/audio.wav',
      storageKey: 'projects/12/audio/missing.wav',
      targetPath,
      storage: {
        async getObject() {
          return null
        },
      },
      fetchImpl: async (url) => {
        assert.equal(url, 'https://example.test/audio.wav')
        return new Response(Buffer.from('from-url'), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        })
      },
    })

    assert.equal(await readFile(targetPath, 'utf8'), 'from-url')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
