import assert from 'node:assert/strict'
import test from 'node:test'

import { createCaptchaStore } from './auth-captcha.mjs'

test('captcha challenge is signed, one-time and rejects a wrong position', () => {
  let now = 1000
  const store = createCaptchaStore({ secret: 'test-secret', now: () => now, ttlMs: 100, randomTargetX: () => 140 })
  const challenge = store.createChallenge({ ip: '127.0.0.1', phone: '13900000000' })
  assert.equal('targetX' in challenge, false)
  assert.equal('targetX' in JSON.parse(Buffer.from(challenge.challenge.split('.')[0], 'base64url').toString()), false)
  assert.match(challenge.backgroundImage, /^data:image\/svg\+xml,/)
  assert.match(challenge.pieceImage, /^data:image\/svg\+xml,/)
  assert.equal(store.verify({ challenge: challenge.challenge, position: 0, ip: '127.0.0.1', phone: '13900000000' }).ok, false)
  const verified = store.verify({ challenge: challenge.challenge, position: 140, ip: '127.0.0.1', phone: '13900000000' })
  assert.equal(verified.ok, true)
  assert.equal(store.consumeVerificationToken(verified.verificationToken), true)
  assert.equal(store.consumeVerificationToken(verified.verificationToken), false)
})

test('captcha challenge expires and binds to its source', () => {
  let now = 1000
  const store = createCaptchaStore({ secret: 'test-secret', now: () => now, ttlMs: 100, randomTargetX: () => 140 })
  const challenge = store.createChallenge({ ip: 'a', phone: '1' })
  assert.equal(store.verify({ challenge: challenge.challenge, position: 140, ip: 'b', phone: '1' }).ok, false)
  now = 1200
  assert.equal(store.verify({ challenge: challenge.challenge, position: 140, ip: 'a', phone: '1' }).ok, false)
})

test('captcha verification tokens expire and cannot be consumed later', () => {
  let now = 1000
  const store = createCaptchaStore({ secret: 'test-secret', now: () => now, ttlMs: 100, randomTargetX: () => 140 })
  const challenge = store.createChallenge()
  const verified = store.verify({ challenge: challenge.challenge, position: 140 })

  assert.equal(verified.ok, true)
  now = 1101
  assert.equal(store.consumeVerificationToken(verified.verificationToken), false)
})

test('captcha store evicts oldest active state at its configured capacity', () => {
  const store = createCaptchaStore({ secret: 'test-secret', ttlMs: 100, maxEntries: 1, randomTargetX: () => 140 })
  const first = store.createChallenge()
  const second = store.createChallenge()

  assert.equal(store.verify({ challenge: first.challenge, position: 140 }).ok, false)
  const verified = store.verify({ challenge: second.challenge, position: 140 })
  assert.equal(verified.ok, true)
  const third = store.createChallenge()
  const nextVerified = store.verify({ challenge: third.challenge, position: 140 })
  assert.equal(nextVerified.ok, true)
  assert.equal(store.consumeVerificationToken(verified.verificationToken), false)
  assert.equal(store.consumeVerificationToken(nextVerified.verificationToken), true)
})

test('captcha store requires an explicit signing secret', () => {
  assert.throws(() => createCaptchaStore(), /signing secret is required/)
})

test('captcha rejects malformed and oversized signed values without throwing', () => {
  const store = createCaptchaStore({ secret: 'test-secret' })

  assert.equal(store.verify({ challenge: 'not.a.valid.challenge' }).ok, false)
  assert.equal(store.verify({ challenge: 'x'.repeat(4097) }).ok, false)
  assert.equal(store.consumeVerificationToken('not.a.valid.token'), false)
  assert.equal(store.consumeVerificationToken('x'.repeat(257)), false)
})
