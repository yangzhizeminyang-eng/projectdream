import path from 'node:path'

import { buildAudioLibraryStorageKey } from './audio-library.mjs'
import { buildGeneratedAudioStorageKey } from './audio.mjs'
import {
  buildCharacterImageStorageKey,
  buildGeneratedFrameStorageKey,
} from './frame.mjs'
import {
  buildCharacterReferenceStorageKey,
  buildExportStorageKey,
  buildGeneratedVideoStorageKey,
  buildLipSyncVideoStorageKey,
} from './media-storage-keys.mjs'
import { normalizeObjectKey } from './object-storage.mjs'
import {
  DEFAULT_REMOTE_MEDIA_HOSTS,
  inspectRemoteMediaSource,
} from './remote-media-recovery.mjs'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const DEFAULT_ROOT_NAMES = ['frame', 'audio', 'audioLibrary', 'video', 'export']
const SAFE_FILE_NAME = /^[a-zA-Z0-9._-]+$/
const EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.wav',
  '.mp3',
  '.ogg',
  '.m4a',
  '.webm',
  '.mp4',
  '.srt',
])

function unresolved(reason) {
  return {
    sourceKind: 'unresolved',
    sourcePath: null,
    extension: null,
    reason,
  }
}

function isWindowsDrivePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || ''))
}

function drivePathApi() {
  return process.platform === 'win32' ? path.win32 : path.posix
}

function normalizeRoot(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return isWindowsDrivePath(raw)
    ? drivePathApi().normalize(raw)
    : path.resolve(raw)
}

function normalizedRoots(roots = {}) {
  return {
    frame: normalizeRoot(roots.frame),
    audio: normalizeRoot(roots.audio),
    audioLibrary: normalizeRoot(roots.audioLibrary),
    video: normalizeRoot(roots.video),
    export: normalizeRoot(roots.export),
  }
}

function safeFilePath(root, fileName) {
  if (!root || !SAFE_FILE_NAME.test(fileName)) return null
  const windowsRoot = isWindowsDrivePath(root)
  const pathApi = drivePathApi()
  const resolvedRoot = windowsRoot ? normalizeRoot(root) : path.resolve(root)
  const resolvedPath = windowsRoot
    ? pathApi.join(resolvedRoot, fileName)
    : path.resolve(resolvedRoot, fileName)
  const relative = windowsRoot
    ? pathApi.relative(resolvedRoot, resolvedPath)
    : path.relative(resolvedRoot, resolvedPath)
  const relativeIsAbsolute = windowsRoot ? pathApi.isAbsolute(relative) : path.isAbsolute(relative)
  if (!relative || relative.startsWith('..') || relativeIsAbsolute) return null
  return resolvedPath
}

function joinRoot(root, ...parts) {
  return isWindowsDrivePath(root)
    ? drivePathApi().join(root, ...parts)
    : path.resolve(root, ...parts)
}

function relativeFromRoot(root, sourcePath) {
  return isWindowsDrivePath(root)
    ? drivePathApi().relative(root, sourcePath)
    : path.relative(root, sourcePath)
}

function sourceWithPath(root, fileName, fallbackExtension) {
  const sourcePath = safeFilePath(root, fileName)
  if (!sourcePath) return unresolved('unsupported-media-url')
  const extension = path.extname(fileName).toLowerCase() || fallbackExtension
  if (!EXTENSIONS.has(extension)) return unresolved('unsupported-file-extension')
  return {
    sourceKind: 'local',
    sourcePath,
    extension,
  }
}

function parseLocalUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim())
    if (!LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
      return { remote: true }
    }
    return {
      remote: false,
      pathname: decodeURIComponent(parsed.pathname),
    }
  } catch {
    return unresolved('unsupported-media-url')
  }
}

export function resolveLegacyMediaSource({ url, roots = {} } = {}) {
  const value = String(url || '').trim()
  if (!value) return unresolved('missing-source-url')

  const parsed = parseLocalUrl(value)
  if (parsed.sourceKind === 'unresolved') return parsed
  if (parsed.remote) return unresolved('remote-source-not-local')

  const resolvedRoots = normalizedRoots(roots)
  let match = parsed.pathname.match(/^\/generated\/frame\/([^/]+)$/)
  if (match) return sourceWithPath(resolvedRoots.frame, match[1], '.jpg')

  match = parsed.pathname.match(/^\/generated\/audio\/([^/]+)$/)
  if (match) return sourceWithPath(resolvedRoots.audio, match[1], '.wav')

  match = parsed.pathname.match(/^\/generated\/audio-library\/([^/]+)$/)
  if (match) return sourceWithPath(resolvedRoots.audioLibrary, match[1], '.wav')

  match = parsed.pathname.match(/^\/generated\/video\/([^/]+)$/)
  if (match) return sourceWithPath(resolvedRoots.video, match[1], '.mp4')

  match = parsed.pathname.match(/^\/generated\/export\/(\d+)(?:\/([^/]+))?$/)
  if (match) {
    const exportId = match[1]
    const fileName = match[2] || `export-${exportId}.mp4`
    const sourcePath = match[2]
      ? joinRoot(resolvedRoots.export, exportId, fileName)
      : joinRoot(resolvedRoots.export, fileName)
    const root = resolvedRoots.export
    const relative = relativeFromRoot(root, sourcePath)
    const relativeIsAbsolute = isWindowsDrivePath(root)
      ? drivePathApi().isAbsolute(relative)
      : path.isAbsolute(relative)
    if (
      !SAFE_FILE_NAME.test(fileName) ||
      !relative ||
      relative.startsWith('..') ||
      relativeIsAbsolute
    ) {
      return unresolved('unsupported-media-url')
    }
    const extension = path.extname(fileName).toLowerCase() || '.mp4'
    if (!EXTENSIONS.has(extension)) return unresolved('unsupported-file-extension')
    return {
      sourceKind: 'local',
      sourcePath,
      extension,
    }
  }

  return unresolved('unsupported-media-url')
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function extensionOrFallback(source, fallback) {
  return String(source?.extension || fallback).toLowerCase()
}

function buildStorageKey(record, extension) {
  const projectId = positiveInteger(record.projectId)
  const id = positiveInteger(record.id)
  if (!projectId || !id) throw new Error('invalid-media-record')

  switch (record.type) {
    case 'image_asset':
      return buildGeneratedFrameStorageKey({
        projectId,
        storyboardId: record.storyboardId,
        versionNo: record.versionNo,
        candidateNo: id,
        extension,
      })
    case 'character_image':
      return buildCharacterImageStorageKey({
        projectId,
        characterId: record.characterId,
        versionNo: record.versionNo,
        candidateNo: id,
        extension,
      })
    case 'character_reference':
      return buildCharacterReferenceStorageKey({
        projectId,
        characterId: record.characterId,
        extension,
      })
    case 'audio_asset':
      return buildGeneratedAudioStorageKey({
        projectId,
        trackType: record.trackType,
        versionNo: record.versionNo,
        candidateNo: id,
        extension,
      })
    case 'audio_library_asset':
      return buildAudioLibraryStorageKey({
        projectId,
        token: `legacy-library-${id}`,
        extension,
      })
    case 'video_asset':
      if (String(record.sourceType || '').toLowerCase() === 'lip_sync') {
        return buildLipSyncVideoStorageKey({
          projectId,
          storyboardId: record.storyboardId,
          versionNo: record.versionNo,
        })
      }
      return buildGeneratedVideoStorageKey({
        projectId,
        storyboardId: record.storyboardId,
        versionNo: record.versionNo,
        candidateNo: id,
      })
    case 'export_record':
      return buildExportStorageKey({
        projectId,
        exportId: id,
        extension,
      })
    default:
      throw new Error('unsupported-media-record-type')
  }
}

function planRecord(record, roots, remoteOptions = {}) {
  const base = {
    type: record.type,
    id: record.id,
    projectId: record.projectId,
    sourceUrl: String(record.url || '').trim() || null,
    storageKey: null,
    sourcePath: null,
    extension: null,
  }

  if (String(record.storageKey || '').trim()) {
    return {
      ...base,
      action: 'skip',
      reason: 'already-has-storage-key',
      storageKey: String(record.storageKey).trim(),
    }
  }

  const source = resolveLegacyMediaSource({ url: record.url, roots })
  if (source.sourceKind !== 'local') {
    if (source.reason !== 'remote-source-not-local') {
      return {
        ...base,
        action: 'unresolved',
        reason: source.reason,
      }
    }
    const remote = inspectRemoteMediaSource({
      url: record.url,
      allowedHosts: remoteOptions.allowedHosts || DEFAULT_REMOTE_MEDIA_HOSTS,
      now: remoteOptions.now,
    })
    if (remote.action === 'download') {
      let storageKey
      try {
        storageKey = buildStorageKey(record, remote.extension)
      } catch (error) {
        return {
          ...base,
          action: 'unresolved',
          reason: error instanceof Error ? error.message : 'invalid-storage-key',
        }
      }
      return {
        ...base,
        action: 'remote-download',
        storageKey,
        extension: remote.extension,
        remoteHost: remote.host,
        expiresAt: remote.expiresAt,
      }
    }
    return {
      ...base,
      action: 'unresolved',
      reason: remote.reason || source.reason,
      remoteHost: remote.host || null,
      extension: remote.extension || null,
      expiresAt: remote.expiresAt || null,
    }
  }

  const extension = extensionOrFallback(source, record.type === 'export_record' ? '.mp4' : '.bin')
  let storageKey = String(record.preferredStorageKey || '').trim() || null
  try {
    if (storageKey) storageKey = normalizeObjectKey(storageKey)
    else storageKey = buildStorageKey(record, extension)
  } catch (error) {
    return {
      ...base,
      action: 'unresolved',
      reason: error instanceof Error ? error.message : 'invalid-storage-key',
      sourcePath: source.sourcePath,
      extension,
    }
  }

  return {
    ...base,
    action: record.preferredStorageKey ? 'link' : 'migrate',
    storageKey,
    sourcePath: source.sourcePath,
    extension,
  }
}

export function buildMediaMigrationPlan({
  records = [],
  roots = {},
  remote = {},
} = {}) {
  if (!Array.isArray(records)) throw new TypeError('media migration records must be an array')
  return records.map((record) => planRecord(record || {}, roots, remote))
}

export function summarizeMediaMigrationPlans(plans = []) {
  if (!Array.isArray(plans)) throw new TypeError('media migration plans must be an array')
  return plans.reduce(
    (summary, plan) => {
      summary.total += 1
      if (plan.action === 'migrate') summary.migrate += 1
      else if (plan.action === 'remote-download') summary.remoteDownload += 1
      else if (plan.action === 'link') summary.link += 1
      else if (plan.action === 'skip') summary.skip += 1
      else if (plan.action === 'unresolved') summary.unresolved += 1
      return summary
    },
    { total: 0, migrate: 0, remoteDownload: 0, link: 0, skip: 0, unresolved: 0 },
  )
}

export function mediaContentTypeForExtension(extension) {
  const normalized = String(extension || '').toLowerCase()
  if (['.jpg', '.jpeg'].includes(normalized)) return 'image/jpeg'
  if (normalized === '.png') return 'image/png'
  if (normalized === '.webp') return 'image/webp'
  if (normalized === '.mp4') return 'video/mp4'
  if (normalized === '.webm') return 'video/webm'
  if (normalized === '.mp3') return 'audio/mpeg'
  if (normalized === '.ogg') return 'audio/ogg'
  if (normalized === '.m4a') return 'audio/mp4'
  if (normalized === '.srt') return 'application/x-subrip; charset=utf-8'
  return 'audio/wav'
}

export const MEDIA_MIGRATION_ROOT_NAMES = DEFAULT_ROOT_NAMES
