/**
 * 轻量媒体尺寸探测：只读文件头，不依赖 ffprobe。
 *
 * 为什么需要它：项目声明里的 `aspectRatio` 可能和真实素材不一致——
 * 项目 12 声明 `2.39:1`，但素材实际是 16:9（mp4 1280×720、PNG 1312×736）。
 * 剪映草稿的画布如果跟着声明走，成片就会被塞进错误的画布里（压扁或大黑边）。
 * 所以导出时以**真实素材尺寸**为准。
 *
 * 支持：PNG / JPEG / GIF / WebP / MP4 / MOV。
 * 解析不出来就返回 null，由调用方决定回落策略，不猜。
 */

import { open } from 'node:fs/promises'

const HEAD_BYTES = 256 * 1024

async function readHead(filePath, length = HEAD_BYTES) {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function pngDimensions(buffer) {
  if (buffer.length < 24) return null
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function gifDimensions(buffer) {
  if (buffer.length < 10) return null
  const signature = buffer.toString('latin1', 0, 6)
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
}

function webpDimensions(buffer) {
  if (buffer.length < 30) return null
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') return null
  const chunk = buffer.toString('latin1', 12, 16)
  if (chunk === 'VP8X') {
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16))
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16))
    return { width, height }
  }
  if (chunk === 'VP8 ') {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const segmentLength = buffer.readUInt16BE(offset + 2)
    if (segmentLength < 2) return null
    if (JPEG_SOF_MARKERS.has(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + segmentLength
  }
  return null
}

/**
 * MP4/MOV：tkhd 里的宽高是 16.16 定点数，要除以 65536。
 * 直接当整数读会得到 83886080 这种离谱值（我在真机上踩过）。
 */
function mp4Dimensions(buffer) {
  if (buffer.length < 16) return null
  const brand = buffer.toString('latin1', 4, 8)
  if (brand !== 'ftyp') return null
  // 逐个字节找 'tkhd'；循环上界只保证能读到达标头，真正的边界检查在下面按 version 做。
  const limit = buffer.length - 12
  for (let index = 8; index < limit; index += 1) {
    if (buffer[index] !== 0x74 || buffer[index + 1] !== 0x6b || buffer[index + 2] !== 0x68 || buffer[index + 3] !== 0x64) {
      continue
    }
    const boxStart = index - 4
    const version = buffer[boxStart + 8]
    const widthOffset = version === 1 ? boxStart + 96 : boxStart + 84
    const heightOffset = widthOffset + 4
    if (heightOffset + 4 > buffer.length) return null
    const width = Math.round(buffer.readUInt32BE(widthOffset) / 65536)
    const height = Math.round(buffer.readUInt32BE(heightOffset) / 65536)
    if (width > 0 && height > 0 && width < 20000 && height < 20000) return { width, height }
  }
  return null
}

/** 同步版：从已经读进内存的头部字节里解析，方便单测。 */
export function parseMediaDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null
  return (
    pngDimensions(buffer) ||
    jpegDimensions(buffer) ||
    gifDimensions(buffer) ||
    webpDimensions(buffer) ||
    mp4Dimensions(buffer)
  )
}

/** 从文件头探测尺寸；读不到或格式不认识时返回 null。 */
export async function probeMediaDimensions(filePath) {
  try {
    return parseMediaDimensions(await readHead(filePath))
  } catch {
    return null
  }
}

/** 尺寸取偶数，避免编码器对奇数宽高做裁剪。传入 null/undefined 一律返回 null。 */
export function normalizeCanvasSize(size) {
  const { width, height } = size ?? {}
  const w = Math.trunc(Number(width) || 0)
  const h = Math.trunc(Number(height) || 0)
  if (w <= 0 || h <= 0) return null
  return { width: w % 2 === 0 ? w : w + 1, height: h % 2 === 0 ? h : h + 1 }
}

/** 从尺寸推出可读比例标签，例如 1280×720 → 16:9。 */
export function describeRatio(size) {
  const { width, height } = size ?? {}
  const w = Math.trunc(Number(width) || 0)
  const h = Math.trunc(Number(height) || 0)
  if (w <= 0 || h <= 0) return null
  const known = [
    [16, 9],
    [9, 16],
    [4, 3],
    [3, 4],
    [1, 1],
    [21, 9],
  ]
  const actual = w / h
  for (const [rw, rh] of known) {
    if (Math.abs(actual - rw / rh) < 0.02) return `${rw}:${rh}`
  }
  return `${(Math.round(actual * 100) / 100).toFixed(2)}:1`
}

/**
 * 按比例标签算画布尺寸，支持 `16:9`、`2.39:1` 这类任意 W:H。
 *
 * 项目 12 声明的是 `2.39:1`——预置表里没有，早先会静默回落成 9:16。
 * 这里改为按基准边（默认 1080）实算，算不出来才返回 null 交给上层兜底。
 */
export function canvasFromRatioLabel(label, { basis = 1080, presets = {} } = {}) {
  const key = String(label ?? '').trim()
  if (presets[key]) return { ratio: key, ...presets[key] }
  const match = key.match(/^(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)$/)
  if (!match) return null
  const ratioWidth = Number(match[1])
  const ratioHeight = Number(match[2])
  if (!(ratioWidth > 0) || !(ratioHeight > 0)) return null
  const size =
    ratioWidth >= ratioHeight
      ? normalizeCanvasSize({ height: basis, width: Math.round((basis * ratioWidth) / ratioHeight) })
      : normalizeCanvasSize({ width: basis, height: Math.round((basis * ratioHeight) / ratioWidth) })
  if (!size) return null
  return { ratio: key, ...size }
}
