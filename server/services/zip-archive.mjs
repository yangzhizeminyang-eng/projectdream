/**
 * 极简 ZIP 写入器：只用 store（不压缩），零依赖。
 *
 * 为什么不用压缩：交付包里绝大部分是已经压过的 mp4/mp3，再压一遍只是白烧 CPU；
 * 而 store 模式只需要正确的 CRC32 和中央目录，任何解压软件都能打开。
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

export function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

/** DOS 时间戳；固定值让同一个交付包每次生成的字节完全一致，便于比对。 */
const FIXED_DOS_TIME = 0
const FIXED_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

const MAX_ENTRIES = 65000
const MAX_STORE_SIZE = 0xffffffff

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  throw new TypeError('ZIP 条目内容必须是 Buffer、Uint8Array 或字符串')
}

function normalizeEntryPath(name) {
  const text = String(name ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!text || text.includes('../') || text.startsWith('..')) {
    throw new Error(`非法的 ZIP 条目路径: ${name}`)
  }
  return text
}

/**
 * @param {Array<{ path: string, content: Buffer|Uint8Array|string }>} entries
 * @returns {Buffer} 完整的 zip 字节
 */
export function createStoreZip(entries = []) {
  const list = Array.isArray(entries) ? entries : []
  if (list.length > MAX_ENTRIES) {
    throw new Error(`ZIP 条目过多（${list.length} > ${MAX_ENTRIES}）`)
  }

  const chunks = []
  const central = []
  let offset = 0

  for (const entry of list) {
    const name = normalizeEntryPath(entry?.path)
    const content = toBuffer(entry?.content)
    if (content.length > MAX_STORE_SIZE) {
      throw new Error(`ZIP 条目过大: ${name}`)
    }
    const nameBuffer = Buffer.from(name, 'utf8')
    const checksum = crc32(content)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(FIXED_DOS_TIME, 10)
    local.writeUInt16LE(FIXED_DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuffer, content)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(FIXED_DOS_TIME, 12)
    header.writeUInt16LE(FIXED_DOS_DATE, 14)
    header.writeUInt32LE(checksum, 16)
    header.writeUInt32LE(content.length, 20)
    header.writeUInt32LE(content.length, 24)
    header.writeUInt16LE(nameBuffer.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(header, nameBuffer)

    offset += local.length + nameBuffer.length + content.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(list.length, 8)
  end.writeUInt16LE(list.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuffer, end])
}

/** 读取 zip 的条目表，供测试与自检使用（同样只支持 store）。 */
export function readStoreZipEntries(buffer) {
  const source = toBuffer(buffer)
  const eocdSignature = 0x06054b50
  let eocd = -1
  for (let index = source.length - 22; index >= 0; index -= 1) {
    if (source.readUInt32LE(index) === eocdSignature) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP：找不到中央目录结尾')

  const entryCount = source.readUInt16LE(eocd + 10)
  const centralSize = source.readUInt32LE(eocd + 12)
  const centralOffset = source.readUInt32LE(eocd + 16)
  if (centralOffset + centralSize > eocd) throw new Error('不是合法的 ZIP：中央目录越界')

  const entries = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (source.readUInt32LE(cursor) !== 0x02014b50) throw new Error('中央目录条目签名错误')
    const method = source.readUInt16LE(cursor + 10)
    const checksum = source.readUInt32LE(cursor + 16)
    const size = source.readUInt32LE(cursor + 24)
    const nameLength = source.readUInt16LE(cursor + 28)
    const extraLength = source.readUInt16LE(cursor + 30)
    const commentLength = source.readUInt16LE(cursor + 32)
    const localOffset = source.readUInt32LE(cursor + 42)
    const name = source.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    if (source.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('本地头签名错误')
    const localNameLength = source.readUInt16LE(localOffset + 26)
    const localExtraLength = source.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const content = source.slice(dataStart, dataStart + size)

    entries.push({ name, method, size, crc32: checksum, content, computedCrc32: crc32(content) })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  return entries
}
