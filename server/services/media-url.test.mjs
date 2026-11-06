import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveStoredMediaUrl, resolveVideoConfirmationSource } from './media-url.mjs'

test('prefers a fresh signed URL when a media row has a storage key', () => {
  const signedCalls = []
  const url = resolveStoredMediaUrl(
    {
      storage_key: 'projects/12/frames/storyboards/88/v3/c1.png',
      image_url: 'https://legacy.example/frame.png',
      thumbnail_url: 'https://legacy.example/thumb.png',
    },
    {
      createSignedUrl: (input) => {
        signedCalls.push(input)
        return 'http://127.0.0.1:3001/storage/signed-frame'
      },
    },
  )

  assert.equal(url, 'http://127.0.0.1:3001/storage/signed-frame')
  assert.deepEqual(signedCalls, [
    { key: 'projects/12/frames/storyboards/88/v3/c1.png' },
  ])
})

test('falls back to the historical media URL when no storage key exists', () => {
  assert.equal(
    resolveStoredMediaUrl({
      image_url: 'https://legacy.example/frame.png',
      thumbnail_url: 'https://legacy.example/thumb.png',
    }),
    'https://legacy.example/frame.png',
  )
  assert.equal(
    resolveStoredMediaUrl(
      {
        image_url: 'https://legacy.example/frame.png',
        thumbnail_url: 'https://legacy.example/thumb.png',
      },
      { thumbnail: true },
    ),
    'https://legacy.example/thumb.png',
  )
})

test('falls back to the historical URL when signing a stored object fails', () => {
  assert.equal(
    resolveStoredMediaUrl(
      {
        storage_key: 'projects/12/frames/storyboards/88/v3/c1.png',
        image_url: 'https://legacy.example/frame.png',
      },
      {
        createSignedUrl: () => {
          throw new Error('invalid key')
        },
      },
    ),
    'https://legacy.example/frame.png',
  )
})

test('resolves stored video media with the same signed URL and legacy fallback rules', () => {
  assert.equal(
    resolveStoredMediaUrl(
      {
        storage_key: 'projects/12/videos/storyboards/88/v3/c1.mp4',
        video_url: 'http://127.0.0.1:3001/generated/video/legacy.mp4',
      },
      {
        kind: 'video',
        createSignedUrl: ({ key }) => `signed:${key}`,
      },
    ),
    'signed:projects/12/videos/storyboards/88/v3/c1.mp4',
  )
  assert.equal(
    resolveStoredMediaUrl(
      {
        video_url: 'http://127.0.0.1:3001/generated/video/legacy.mp4',
      },
      { kind: 'video' },
    ),
    'http://127.0.0.1:3001/generated/video/legacy.mp4',
  )
})

test('video confirmation refreshes a durable object URL instead of downloading the expired URL again', () => {
  const source = resolveVideoConfirmationSource({
    storageKey: 'projects/12/videos/storyboards/88/v3/c1.mp4',
    videoUrl: 'https://cos.example/video.mp4?sign=expired',
    createSignedUrl: ({ key }) => `https://cos.example/${key}?sign=fresh`,
  })

  assert.deepEqual(source, {
    videoUrl: 'https://cos.example/projects/12/videos/storyboards/88/v3/c1.mp4?sign=fresh',
    shouldPersist: false,
  })
})

test('video confirmation keeps local-file and legacy temporary-source behavior', () => {
  assert.deepEqual(resolveVideoConfirmationSource({
    videoUrl: 'http://localhost:3001/generated/video/candidate.mp4',
    localPath: 'D:/runtime/candidate.mp4',
  }), {
    videoUrl: 'http://localhost:3001/generated/video/candidate.mp4',
    shouldPersist: false,
  })

  assert.deepEqual(resolveVideoConfirmationSource({
    videoUrl: 'https://provider.example/temporary.mp4?sign=expired',
  }), {
    videoUrl: 'https://provider.example/temporary.mp4?sign=expired',
    shouldPersist: true,
  })
})

test('video confirmation does not fall back to an expired URL when stored-object signing fails', () => {
  assert.throws(() => resolveVideoConfirmationSource({
    storageKey: 'projects/12/videos/storyboards/88/v3/c1.mp4',
    videoUrl: 'https://cos.example/video.mp4?sign=expired',
    createSignedUrl: () => { throw new Error('COS unavailable') },
  }), /COS unavailable/)
})
