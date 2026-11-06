import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

function normalizeBytes(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return Buffer.from(bytes)
  return null
}

export async function downloadMediaToFile({
  sourceUrl,
  targetPath,
  timeoutMs = 120000,
  storageKey = null,
  storage = null,
  resolveLocalPath = null,
  fetchImpl = globalThis.fetch,
  fileExists = async (filePath) => {
    try {
      const bytes = await readFile(filePath)
      return bytes.length > 0
    } catch {
      return false
    }
  },
} = {}) {
  if (await fileExists(targetPath)) return targetPath

  const normalizedStorageKey = String(storageKey || '').trim()
  if (normalizedStorageKey && storage && typeof storage.getObject === 'function') {
    try {
      const object = await storage.getObject(normalizedStorageKey)
      const bytes = normalizeBytes(object?.bytes)
      if (bytes?.length) {
        await mkdir(path.dirname(targetPath), { recursive: true })
        await writeFile(targetPath, bytes)
        return targetPath
      }
    } catch {
      // A legacy or temporarily unavailable object can still be fetched by URL.
    }
  }

  const localPath =
    typeof resolveLocalPath === 'function' ? resolveLocalPath(sourceUrl) : null
  if (localPath && (await fileExists(localPath))) {
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, await readFile(localPath))
    return targetPath
  }

  const value = String(sourceUrl || '').trim()
  if (!value) throw new Error('missing media URL')
  if (typeof fetchImpl !== 'function') throw new Error('media fetch is unavailable')

  let response
  try {
    response = await fetchImpl(value, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new Error(`media download failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  if (!response.ok) throw new Error(`media download failed with HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length) throw new Error('media download returned an empty file')
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, bytes)
  return targetPath
}
