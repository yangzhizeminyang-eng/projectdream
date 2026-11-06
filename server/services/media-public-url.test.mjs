import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeGeneratedMediaUrl } from './media-public-url.mjs'

test('repairs generated media URLs persisted without the public port', () => {
  assert.equal(
    normalizeGeneratedMediaUrl(
      'http://<YOUR_SERVER_IP>/generated/video/storyboard-421-v1-c1.mp4',
      'http://<YOUR_SERVER_IP>:8002',
    ),
    'http://<YOUR_SERVER_IP>:8002/generated/video/storyboard-421-v1-c1.mp4',
  )
})

test('keeps provider and object-storage URLs untouched', () => {
  const url = 'https://cdn.example.com/video.mp4'
  assert.equal(normalizeGeneratedMediaUrl(url, 'http://<YOUR_SERVER_IP>:8002'), url)
  assert.equal(
    normalizeGeneratedMediaUrl(
      'https://projectdream-media.cos.ap-guangzhou.myqcloud.com/projects/49/videos/x.mp4',
      'http://<YOUR_SERVER_IP>:8002',
    ),
    'https://projectdream-media.cos.ap-guangzhou.myqcloud.com/projects/49/videos/x.mp4',
  )
})

