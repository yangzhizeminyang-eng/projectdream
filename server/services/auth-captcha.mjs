import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 10_000
const MAX_ATTEMPTS = 5
const TRACK_WIDTH = 320
const IMAGE_HEIGHT = 120
const PIECE_SIZE = 56
const PIECE_TOP = 32
const PALETTES = [
  ['#244c4b', '#c97c5d', '#d7b676', '#a7b89a'],
  ['#36566a', '#d47c58', '#e0c06f', '#93b7a4'],
  ['#594d3e', '#71968a', '#cf8462', '#d8bb82'],
]

function text(value) {
  return String(value ?? '').trim()
}

function sign(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function matchesSignature(value, signature, secret) {
  const expected = Buffer.from(sign(value, secret))
  const actual = Buffer.from(signature)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

function dataUri(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function buildPuzzlePath(x, y) {
  return `M ${x + 8} ${y + 8} H ${x + 20} C ${x + 16} ${y} ${x + 40} ${y} ${x + 36} ${y + 8} H ${x + 48} V ${y + 20} C ${x + 56} ${y + 16} ${x + 56} ${y + 40} ${x + 48} ${y + 36} V ${y + 48} H ${x + 36} C ${x + 40} ${y + 56} ${x + 16} ${y + 56} ${x + 20} ${y + 48} H ${x + 8} V ${y + 36} C ${x} ${y + 40} ${x} ${y + 16} ${x + 8} ${y + 20} Z`
}

function buildChallengeImages(targetX, paletteIndex) {
  const [base, accent, highlight, secondary] = PALETTES[paletteIndex % PALETTES.length]
  const gapPath = buildPuzzlePath(targetX, PIECE_TOP)
  const piecePath = buildPuzzlePath(0, 0)
  const background = `<svg xmlns="http://www.w3.org/2000/svg" width="${TRACK_WIDTH}" height="${IMAGE_HEIGHT}" viewBox="0 0 ${TRACK_WIDTH} ${IMAGE_HEIGHT}"><defs><linearGradient id="wash" x2="1" y2="1"><stop stop-color="${base}"/><stop offset="1" stop-color="${secondary}"/></linearGradient><pattern id="grain" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M0 17.5H18M17.5 0V18" stroke="#fff" stroke-opacity=".09"/></pattern></defs><rect width="320" height="120" fill="url(#wash)"/><path d="M0 82L70 42l42 21 60-38 49 28 56-35 43 23v79H0Z" fill="${accent}" fill-opacity=".74"/><path d="M0 101l59-26 45 16 58-35 50 27 45-24 63 25v36H0Z" fill="${highlight}" fill-opacity=".68"/><rect width="320" height="120" fill="url(#grain)"/><path d="M18 20h45v5H18zm0 12h30v4H18zm234 3h48v5h-48zm-15 12h63v4h-63z" fill="#fff" fill-opacity=".38"/><path d="${gapPath}" fill="#102629" fill-opacity=".62" stroke="#eff6dc" stroke-width="2" stroke-dasharray="4 3"/></svg>`
  const piece = `<svg xmlns="http://www.w3.org/2000/svg" width="${PIECE_SIZE}" height="${PIECE_SIZE}" viewBox="0 0 ${PIECE_SIZE} ${PIECE_SIZE}"><defs><linearGradient id="tile" x2="1" y2="1"><stop stop-color="${base}"/><stop offset=".58" stop-color="${accent}"/><stop offset="1" stop-color="${highlight}"/></linearGradient><pattern id="grain" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M0 11.5H12M11.5 0V12" stroke="#fff" stroke-opacity=".25"/></pattern><clipPath id="shape"><path d="${piecePath}"/></clipPath></defs><g clip-path="url(#shape)"><rect width="56" height="56" fill="url(#tile)"/><rect width="56" height="56" fill="url(#grain)"/><path d="M4 39 22 17l16 13 16-20v50H4Z" fill="${secondary}" fill-opacity=".8"/></g><path d="${piecePath}" fill="none" stroke="#f5f0d8" stroke-width="2"/></svg>`
  return { backgroundImage: dataUri(background), pieceImage: dataUri(piece) }
}

export function createCaptchaStore({
  secret,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  randomTargetX = () => randomInt(88, TRACK_WIDTH - PIECE_SIZE - 8),
  randomPalette = () => randomInt(0, PALETTES.length),
} = {}) {
  const signingSecret = text(secret)
  if (!signingSecret) throw new Error('captcha signing secret is required')
  const entryLimit = Math.max(1, Math.floor(Number(maxEntries) || DEFAULT_MAX_ENTRIES))
  const challenges = new Map()
  const consumed = new Map()

  function pruneExpired() {
    const timestamp = now()
    for (const [id, record] of challenges) {
      if (record.expiresAt <= timestamp) challenges.delete(id)
    }
    for (const [id, expiresAt] of consumed) {
      if (expiresAt <= timestamp) consumed.delete(id)
    }
  }

  function setBounded(map, id, value) {
    if (map.size >= entryLimit) map.delete(map.keys().next().value)
    map.set(id, value)
  }

  function createChallenge({ ip = '', phone = '' } = {}) {
    pruneExpired()
    const id = randomBytes(12).toString('hex')
    const targetX = Math.max(1, Math.min(TRACK_WIDTH - PIECE_SIZE - 1, Number(randomTargetX()) || 0))
    const paletteIndex = Math.max(0, Math.min(PALETTES.length - 1, Math.floor(Number(randomPalette()) || 0)))
    const payload = { id, issuedAt: now(), expiresAt: now() + ttlMs }
    const encoded = encode(payload)
    const images = buildChallengeImages(targetX, paletteIndex)
    setBounded(challenges, id, {
      ...payload,
      ip: text(ip),
      phone: text(phone),
      attempts: 0,
      targetX,
    })
    return {
      challengeId: id,
      challenge: `${encoded}.${sign(encoded, signingSecret)}`,
      ...images,
      trackWidth: TRACK_WIDTH,
      imageHeight: IMAGE_HEIGHT,
      pieceSize: PIECE_SIZE,
      pieceTop: PIECE_TOP,
      expiresAt: payload.expiresAt,
    }
  }

  function verify({ challenge = '', position = 0, ip = '', phone = '' } = {}) {
    pruneExpired()
    const rawChallenge = text(challenge)
    if (rawChallenge.length > 4096) return { ok: false, message: '滑块挑战签名无效' }
    const challengeParts = rawChallenge.split('.')
    const [encoded, signature] = challengeParts
    if (challengeParts.length !== 2 || !encoded || !signature || !matchesSignature(encoded, signature, signingSecret)) {
      return { ok: false, message: '滑块挑战签名无效' }
    }
    let payload
    try { payload = decode(encoded) } catch { return { ok: false, message: '滑块挑战格式无效' } }
    const record = challenges.get(payload.id)
    if (!record || consumed.has(payload.id)) return { ok: false, message: '滑块挑战已使用或不存在' }
    if (now() >= record.expiresAt) {
      challenges.delete(payload.id)
      return { ok: false, message: '滑块挑战已过期，请重新验证' }
    }
    if (record.ip && text(ip) && record.ip !== text(ip)) return { ok: false, message: '滑块挑战来源不一致' }
    if (record.phone && text(phone) && record.phone !== text(phone)) return { ok: false, message: '滑块挑战手机号不一致' }
    record.attempts += 1
    if (record.attempts > MAX_ATTEMPTS) {
      challenges.delete(payload.id)
      return { ok: false, message: '滑块挑战尝试次数过多' }
    }
    if (Math.abs(Number(position) - record.targetX) > 8) return { ok: false, message: '请将滑块拖到高亮位置' }
    setBounded(consumed, payload.id, now() + ttlMs)
    challenges.delete(payload.id)
    return { ok: true, verificationToken: `${payload.id}.${sign(`${payload.id}:verified`, signingSecret)}` }
  }

  function consumeVerificationToken(token) {
    pruneExpired()
    const rawToken = text(token)
    if (rawToken.length > 256) return false
    const tokenParts = rawToken.split('.')
    const [id, signature] = tokenParts
    if (tokenParts.length !== 2 || !id || !matchesSignature(`${id}:verified`, signature, signingSecret) || !consumed.has(id)) return false
    consumed.delete(id)
    return true
  }

  return { createChallenge, verify, consumeVerificationToken }
}
