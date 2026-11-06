import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeBrowserMediaUrl } from './media-url.ts'

test('rewrites same-host generated media to the browser origin when the public port is missing', () => {
  assert.equal(
    normalizeBrowserMediaUrl(
      'http://<YOUR_SERVER_IP>/generated/audio/audio-15-voice-preview.wav',
      'http://<YOUR_SERVER_IP>:8002',
    ),
    'http://<YOUR_SERVER_IP>:8002/generated/audio/audio-15-voice-preview.wav',
  )
})

test('keeps provider media URLs untouched', () => {
  const url = 'https://cdn.example.com/audio/preview.wav'
  assert.equal(normalizeBrowserMediaUrl(url, 'http://<YOUR_SERVER_IP>:8002'), url)
})
