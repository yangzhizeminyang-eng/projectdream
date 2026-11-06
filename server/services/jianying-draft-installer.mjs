/**
 * 把生成的明文草稿装进剪映的草稿库，并登记进 root_meta_info.json。
 *
 * 安全规则（这个模块会写用户的剪映目录，必须守住）：
 * 1. **只删自己建的东西**：草稿目录里必须有 `.projectdream-draft.json` 标记，
 *    卸载时才允许删除；没有标记的同名目录一律不碰，改用带序号的新名字。
 * 2. **索引先备份**：第一次安装前把 root_meta_info.json 原样备份成
 *    `root_meta_info.json.projectdream-backup`（只在不存在时创建，保留最原始那份）。
 * 3. **别人的条目一个都不动**：更新索引时只做「删掉我们自己的旧条目 + 追加新条目」。
 *
 * 真机事实（剪映 8.9.0.13361）：剪映启动时会自己重写 root_meta_info.json 并给所有草稿
 * 重新分配 draft_id，所以安装时**必须让剪映处于关闭状态**，否则它退出时会覆盖索引。
 * 这一层不做进程检测，由调用方负责（见 server/index.mjs 的运行中检查）。
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const DRAFT_MARKER_FILE = '.projectdream-draft.json'
export const INDEX_FILE = 'root_meta_info.json'
export const INDEX_BACKUP_SUFFIX = '.projectdream-backup'
export const DRAFT_FOLDER_PREFIX = '帧心帧意_'

export function resolveJianyingDraftRoot({ localAppData = process.env.LOCALAPPDATA, override = null } = {}) {
  const explicit = String(override ?? '').trim()
  if (explicit) return path.resolve(explicit)
  const base = String(localAppData ?? '').trim() || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft')
}

async function pathKind(target) {
  try {
    const info = await stat(target)
    if (info.isDirectory()) return 'dir'
    if (info.isFile()) return 'file'
    return 'other'
  } catch {
    return 'missing'
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

/** 挑一个没被占用的草稿目录名；同名目录不是我们的就加序号。 */
export function pickAvailableDraftFolderName(desiredName, existingFolders = [], ownedFolders = []) {
  const base = String(desiredName ?? '').trim() || '帧心帧意草稿'
  const taken = new Set(existingFolders.filter((name) => !ownedFolders.includes(name)))
  if (!taken.has(base)) return base
  for (let index = 2; index <= 99; index += 1) {
    const candidate = `${base} (${index})`
    if (!taken.has(candidate)) return candidate
  }
  return `${base} (${Date.now()})`
}

export async function readProjectDreamDraftMarkers(draftRoot) {
  const owned = []
  let entries = []
  try {
    entries = await readdir(draftRoot, { withFileTypes: true })
  } catch {
    return owned
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const markerPath = path.join(draftRoot, entry.name, DRAFT_MARKER_FILE)
    if ((await pathKind(markerPath)) !== 'file') continue
    try {
      owned.push({ folder: entry.name, marker: await readJson(markerPath) })
    } catch {
      owned.push({ folder: entry.name, marker: null })
    }
  }
  return owned
}

function buildIndexEntry({ folderName, draftRoot, draftId, draftName, durationMicros, nowMs }) {
  const folderPath = path.join(draftRoot, folderName).replace(/\\/g, '/')
  return {
    draft_cover: '',
    draft_fold_path: folderPath,
    draft_id: draftId,
    draft_name: draftName,
    draft_root_path: draftRoot.replace(/\\/g, '/'),
    tm_draft_create: nowMs * 1000,
    tm_draft_modified: nowMs * 1000,
    tm_duration: durationMicros,
  }
}

/**
 * 安装一份草稿。返回安装报告，供 API 回给前端。
 */
export async function installJianyingDraft({
  draftRoot,
  desiredName,
  draftContent,
  draftMetaInfo = null,
  draftSettings = '',
  marker = {},
  draftId = randomUUID(),
  nowMs = Date.now(),
} = {}) {
  if (!draftRoot) throw new Error('缺少剪映草稿根目录')
  if (!draftContent) throw new Error('缺少 draft_content.json 内容')
  if ((await pathKind(draftRoot)) !== 'dir') {
    throw new Error(`找不到剪映草稿目录：${draftRoot}`)
  }

  const indexPath = path.join(draftRoot, INDEX_FILE)
  const backupPath = `${indexPath}${INDEX_BACKUP_SUFFIX}`
  if ((await pathKind(indexPath)) !== 'file') {
    throw new Error(`找不到剪映草稿索引：${indexPath}`)
  }

  const rawIndex = await readFile(indexPath, 'utf8')
  let index
  try {
    index = JSON.parse(rawIndex)
  } catch (error) {
    throw new Error(`剪映草稿索引无法解析，已中止以免覆盖：${error instanceof Error ? error.message : 'unknown'}`)
  }

  let createdBackup = false
  let indexBackupPath = null
  if ((await pathKind(backupPath)) !== 'file') {
    await writeFile(backupPath, rawIndex, 'utf8')
    createdBackup = true
  }
  indexBackupPath = backupPath

  const owned = await readProjectDreamDraftMarkers(draftRoot)
  const ownedFolders = owned.map((item) => item.folder)
  const entries = await readdir(draftRoot, { withFileTypes: true })
  const existingFolders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)

  // 同名且是我们自己的 → 原地替换，避免每导出一次就多一个 (2)(3)
  const reusable = ownedFolders.includes(desiredName)
  const folderName = reusable
    ? desiredName
    : pickAvailableDraftFolderName(desiredName, existingFolders, ownedFolders)
  const draftDir = path.join(draftRoot, folderName)

  if (reusable) {
    await rm(draftDir, { recursive: true, force: true })
  }
  await mkdir(draftDir, { recursive: true })

  const durationMicros = Number(draftContent.duration) || 0
  const draftName = String(desiredName)
  const metaInfo = {
    ...(draftMetaInfo || {}),
    draft_fold_path: draftDir.replace(/\\/g, '/'),
    draft_id: draftId,
    draft_name: draftName,
    draft_root_path: draftRoot.replace(/\\/g, '/'),
    tm_draft_create: nowMs * 1000,
    tm_draft_modified: nowMs * 1000,
    tm_duration: durationMicros,
  }

  await writeFile(path.join(draftDir, 'draft_content.json'), JSON.stringify(draftContent, null, 2), 'utf8')
  await writeFile(path.join(draftDir, 'draft_meta_info.json'), JSON.stringify(metaInfo, null, 2), 'utf8')
  if (draftSettings) {
    await writeFile(path.join(draftDir, 'draft_settings'), draftSettings, 'utf8')
  }
  await writeFile(
    path.join(draftDir, DRAFT_MARKER_FILE),
    JSON.stringify({ ...marker, draftId, folderName, installedAt: new Date(nowMs).toISOString() }, null, 2),
    'utf8',
  )

  const nextIndex = { ...index }
  const isOurs = (item) => {
    if (!item || typeof item !== 'object') return false
    if (item.draft_id === draftId) return true
    const folderPath = String(item.draft_fold_path || '').replace(/\\/g, '/')
    return ownedFolders.some((name) => folderPath.endsWith(`/${name}`))
  }
  if (!Array.isArray(nextIndex.all_draft_store)) nextIndex.all_draft_store = []
  nextIndex.all_draft_store = nextIndex.all_draft_store.filter((item) => !isOurs(item))
  nextIndex.all_draft_store.push(
    buildIndexEntry({ folderName, draftRoot, draftId, draftName, durationMicros, nowMs }),
  )
  if (Array.isArray(nextIndex.draft_ids)) {
    nextIndex.draft_ids = nextIndex.draft_ids.filter((id) => id !== draftId)
    nextIndex.draft_ids.push(draftId)
  }

  // 先写临时文件再改名，避免剪映/杀软读到写了一半的索引
  const tempIndexPath = `${indexPath}.projectdream-tmp`
  await writeFile(tempIndexPath, JSON.stringify(nextIndex, null, 2), 'utf8')
  await rename(tempIndexPath, indexPath)

  return {
    draftDir,
    folderName,
    draftName,
    draftId,
    indexBackupPath,
    createdBackup,
    replacedExisting: reusable,
    indexEntryCount: nextIndex.all_draft_store.length,
  }
}

/**
 * 卸载我们装的草稿：只删带标记的目录，并还原索引备份。
 */
export async function uninstallJianyingDraft({ draftRoot, folderName } = {}) {
  if (!draftRoot) throw new Error('缺少剪映草稿根目录')
  const draftDir = path.join(draftRoot, String(folderName ?? ''))
  const markerPath = path.join(draftDir, DRAFT_MARKER_FILE)
  if ((await pathKind(markerPath)) !== 'file') {
    throw new Error(`拒绝删除：${folderName} 不是帧心帧意生成的草稿（缺少标记文件）`)
  }

  await rm(draftDir, { recursive: true, force: true })

  const indexPath = path.join(draftRoot, INDEX_FILE)
  const backupPath = `${indexPath}${INDEX_BACKUP_SUFFIX}`
  if ((await pathKind(backupPath)) === 'file' && (await pathKind(indexPath)) === 'file') {
    await writeFile(indexPath, await readFile(backupPath, 'utf8'), 'utf8')
    await rm(backupPath, { force: true })
    return { removed: true, restoredIndex: true, draftDir }
  }
  return { removed: true, restoredIndex: false, draftDir }
}
