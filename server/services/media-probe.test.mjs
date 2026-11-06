import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  canvasFromRatioLabel,
  describeRatio,
  normalizeCanvasSize,
  parseMediaDimensions,
  probeMediaDimensions,
} from './media-probe.mjs'

/** 造一个最小合法 PNG 头：签名 + IHDR 长度/类型 + 宽高 */
function pngBuffer(width, height) {
  const buffer = Buffer.alloc(33)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function gifBuffer(width, height) {
  const buffer = Buffer.alloc(16)
  buffer.write('GIF89a', 0, 'latin1')
  buffer.writeUInt16LE(width, 6)
  buffer.writeUInt16LE(height, 8)
  return buffer
}

function webpVp8xBuffer(width, height) {
  const buffer = Buffer.alloc(32)
  buffer.write('RIFF', 0, 'latin1')
  buffer.write('WEBP', 8, 'latin1')
  buffer.write('VP8X', 12, 'latin1')
  const w = width - 1
  const h = height - 1
  buffer[24] = w & 0xff
  buffer[25] = (w >> 8) & 0xff
  buffer[26] = (w >> 16) & 0xff
  buffer[27] = h & 0xff
  buffer[28] = (h >> 8) & 0xff
  buffer[29] = (h >> 16) & 0xff
  return buffer
}

function jpegBuffer(width, height) {
  const buffer = Buffer.alloc(20)
  buffer[0] = 0xff
  buffer[1] = 0xd8
  // APP0：标记 2 字节 + 长度 2 字节（长度含自身，所以最短是 2）
  buffer[2] = 0xff
  buffer[3] = 0xe0
  buffer.writeUInt16BE(2, 4)
  // SOF0 紧跟其后：标记 2 + 长度 2 + 精度 1 + 高 2 + 宽 2
  buffer[6] = 0xff
  buffer[7] = 0xc0
  buffer.writeUInt16BE(11, 8)
  buffer[10] = 8
  buffer.writeUInt16BE(height, 11)
  buffer.writeUInt16BE(width, 13)
  return buffer
}

/** 造一个带 tkhd 的 mp4：宽高必须是 16.16 定点数 */
function mp4Buffer(width, height, version = 0) {
  const boxStart = 8
  const size = version === 1 ? 104 : 92
  const buffer = Buffer.alloc(boxStart + size)
  buffer.write('ftyp', 4, 'latin1')
  buffer.writeUInt32BE(size, boxStart)
  buffer.write('tkhd', boxStart + 4, 'latin1')
  buffer[boxStart + 8] = version
  const widthOffset = version === 1 ? boxStart + 96 : boxStart + 84
  buffer.writeUInt32BE(width * 65536, widthOffset)
  buffer.writeUInt32BE(height * 65536, widthOffset + 4)
  return buffer
}

test('media probe reads real pixel sizes from each container header', () => {
  assert.deepEqual(parseMediaDimensions(pngBuffer(1312, 736)), { width: 1312, height: 736 })
  assert.deepEqual(parseMediaDimensions(jpegBuffer(1080, 1920)), { width: 1080, height: 1920 })
  assert.deepEqual(parseMediaDimensions(gifBuffer(320, 240)), { width: 320, height: 240 })
  assert.deepEqual(parseMediaDimensions(webpVp8xBuffer(800, 600)), { width: 800, height: 600 })
  assert.deepEqual(parseMediaDimensions(mp4Buffer(1280, 720)), { width: 1280, height: 720 })
  assert.deepEqual(parseMediaDimensions(mp4Buffer(1080, 1920, 1)), { width: 1080, height: 1920 })
})

test('media probe decodes mp4 fixed-point sizes instead of raw integers', () => {
  // 踩过的坑：tkhd 宽高是 16.16 定点数，直接当整数读会得到 83886080。
  const parsed = parseMediaDimensions(mp4Buffer(1280, 720))
  assert.equal(parsed.width, 1280)
  assert.equal(parsed.height, 720)
  assert.notEqual(parsed.width, 83886080)
})

test('media probe returns null instead of guessing on unknown input', () => {
  assert.equal(parseMediaDimensions(Buffer.from('not a media file at all')), null)
  assert.equal(parseMediaDimensions(Buffer.alloc(0)), null)
  assert.equal(parseMediaDimensions(null), null)
  // RIFF 但不是 WEBP
  const notWebp = Buffer.alloc(32)
  notWebp.write('RIFF', 0, 'latin1')
  notWebp.write('WAVE', 8, 'latin1')
  assert.equal(parseMediaDimensions(notWebp), null)
})

test('media probe reads a real png file from disk and copes with a missing file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-probe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const file = path.join(dir, 'frame.png')
  await writeFile(file, pngBuffer(1312, 736))
  assert.deepEqual(await probeMediaDimensions(file), { width: 1312, height: 736 })
  assert.equal(await probeMediaDimensions(path.join(dir, 'nope.png')), null)
})

test('canvas size is normalized to even numbers', () => {
  assert.deepEqual(normalizeCanvasSize({ width: 1313, height: 737 }), { width: 1314, height: 738 })
  assert.deepEqual(normalizeCanvasSize({ width: 1280, height: 720 }), { width: 1280, height: 720 })
  assert.equal(normalizeCanvasSize({ width: 0, height: 720 }), null)
})

test('ratio label describes real media and falls back to decimals', () => {
  assert.equal(describeRatio({ width: 1280, height: 720 }), '16:9')
  assert.equal(describeRatio({ width: 1080, height: 1920 }), '9:16')
  assert.equal(describeRatio({ width: 1080, height: 1080 }), '1:1')
  assert.equal(describeRatio({ width: 2390, height: 1000 }), '2.39:1')
})

test('canvas is computed from any W:H label instead of silently falling back', () => {
  // 项目 12 声明的 2.39:1 不在预置表里，早先会静默变成 9:16
  assert.deepEqual(canvasFromRatioLabel('2.39:1'), { ratio: '2.39:1', width: 2582, height: 1080 })
  // 预置优先，尺寸走标准值
  assert.deepEqual(
    canvasFromRatioLabel('16:9', { presets: { '16:9': { width: 1920, height: 1080 } } }),
    { ratio: '16:9', width: 1920, height: 1080 },
  )
  // 竖屏按宽为基准边
  assert.deepEqual(canvasFromRatioLabel('9:16'), { ratio: '9:16', width: 1080, height: 1920 })
  // 认不出来就返回 null，让调用方显式兜底
  assert.equal(canvasFromRatioLabel('自适应'), null)
  assert.equal(canvasFromRatioLabel(null), null)
  assert.equal(canvasFromRatioLabel('0:9'), null)
})
