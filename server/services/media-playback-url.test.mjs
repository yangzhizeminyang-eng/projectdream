import test from 'node:test'
import assert from 'node:assert/strict'

import { createSignedPlaybackProxyUrl } from './media-playback-url.mjs'

test('creates a relative signed playback URL with encoded object key segments', () => {
  const url = createSignedPlaybackProxyUrl({
    key: 'projects/12/exports/35/final.mp4',
    signingSecret: 'test-secret',
    basePath: '/storage',
    expiresInSeconds: 900,
    now: 1_700_000_000,
  })

  assert.equal(
    url,
    '/storage/projects/12/exports/35/final.mp4?expires=1700000900&signature=8c25f4f91e01721549adfef4d0576ef21cd98e3086484820dfd631d4ca04d23e',
  )
})

test('rejects missing playback signing configuration', () => {
  assert.throws(
    () => createSignedPlaybackProxyUrl({
      key: 'projects/12/exports/35/final.mp4',
      signingSecret: '',
    }),
    /signing secret/i,
  )
})
