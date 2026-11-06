import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DRAFT_MARKER_FILE,
  INDEX_BACKUP_SUFFIX,
  INDEX_FILE,
  installJianyingDraft,
  pickAvailableDraftFolderName,
  resolveJianyingDraftRoot,
  uninstallJianyingDraft,
} from './jianying-draft-installer.mjs'

const FOREIGN_DRAFTS = ['3月28日', '4月21日', '9月28日']

async function makeDraftRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jy-draft-root-'))
  for (const name of FOREIGN_DRAFTS) {
    await mkdir(path.join(root, name), { recursive: true })
    await writeFile(path.join(root, name, 'draft_content.json'), 'ENCRYPTED', 'utf8')
  }
  await writeFile(
    path.join(root, INDEX_FILE),
    JSON.stringify(
      {
        all_draft_store: FOREIGN_DRAFTS.map((name, index) => ({
          draft_cover: '',
          draft_fold_path: path.join(root, name).replace(/\\/g, '/'),
          draft_id: `foreign-${index}`,
          draft_name: name,
          draft_root_path: root.replace(/\\/g, '/'),
          tm_draft_create: 1,
          tm_draft_modified: 1,
          tm_duration: 1000,
        })),
        draft_ids: FOREIGN_DRAFTS.map((_, index) => `foreign-${index}`),
        root_path: root.replace(/\\/g, '/'),
      },
      null,
      2,
    ),
    'utf8',
  )
  return root
}

function draftContentFixture() {
  return { duration: 6_000_000, canvas_config: { width: 1080, height: 1920 }, tracks: [{ type: 'video', segments: [] }] }
}

async function install(root, overrides = {}) {
  return installJianyingDraft({
    draftRoot: root,
    desiredName: '帧心帧意_零点回声 E01',
    draftContent: draftContentFixture(),
    draftMetaInfo: { draft_type: 0 },
    draftSettings: '[General]\n',
    marker: { projectId: 12, episodeNo: 1 },
    draftId: 'projectdream-fixed-id',
    nowMs: 1_760_000_000_000,
    ...overrides,
  })
}

async function readIndex(root) {
  return JSON.parse(await readFile(path.join(root, INDEX_FILE), 'utf8'))
}

test('installer writes a plaintext draft and registers it without touching other drafts', async (t) => {
  const root = await makeDraftRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  const report = await install(root)
  assert.equal(report.folderName, '帧心帧意_零点回声 E01')
  assert.equal(report.createdBackup, true)
  assert.equal(report.replacedExisting, false)

  // 关键：写进去的是明文 JSON，剪映读的就是它
  const raw = await readFile(path.join(report.draftDir, 'draft_content.json'), 'utf8')
  assert.equal(raw.trimStart().startsWith('{'), true)
  assert.equal(JSON.parse(raw).duration, 6_000_000)

  const index = await readIndex(root)
  assert.equal(index.all_draft_store.length, FOREIGN_DRAFTS.length + 1)
  // 别人的条目原样保留
  for (const [position, name] of FOREIGN_DRAFTS.entries()) {
    assert.equal(index.all_draft_store[position].draft_name, name)
    assert.equal(index.all_draft_store[position].draft_id, `foreign-${position}`)
  }
  const ours = index.all_draft_store.at(-1)
  assert.equal(ours.draft_id, 'projectdream-fixed-id')
  assert.equal(ours.tm_duration, 6_000_000)
})

test('installer keeps the pristine index backup and reuses its own folder on re-export', async (t) => {
  const root = await makeDraftRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  const first = await install(root)
  const backupAfterFirst = await readFile(first.indexBackupPath, 'utf8')

  const second = await install(root, { nowMs: 1_760_000_100_000, draftContent: { duration: 9_000_000 } })
  assert.equal(second.createdBackup, false, '备份只创建一次，保留最原始那份')
  assert.equal(second.replacedExisting, true, '再次导出原地替换，不生成 (2)(3)')
  assert.equal(second.folderName, first.folderName)
  assert.equal(await readFile(second.indexBackupPath, 'utf8'), backupAfterFirst)

  const index = await readIndex(root)
  assert.equal(index.all_draft_store.length, FOREIGN_DRAFTS.length + 1, '我们的旧条目被替换而不是累积')
  assert.equal(index.all_draft_store.at(-1).tm_duration, 9_000_000)

  const folders = await readdir(root)
  assert.equal(folders.filter((name) => name.includes('帧心帧意_') && !name.includes('backup')).length, 1)
})

test('installer never overwrites a foreign draft that happens to share the name', async (t) => {
  const root = await makeDraftRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  const shared = '帧心帧意_零点回声 E01'
  await mkdir(path.join(root, shared), { recursive: true })
  await writeFile(path.join(root, shared, 'draft_content.json'), 'NOT-OURS', 'utf8')

  const report = await install(root)
  assert.equal(report.folderName, `${shared} (2)`)
  assert.equal(await readFile(path.join(root, shared, 'draft_content.json'), 'utf8'), 'NOT-OURS')
  assert.equal(report.replacedExisting, false)
})

test('uninstall removes only the marked folder and restores the index', async (t) => {
  const root = await makeDraftRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const originalIndex = await readFile(path.join(root, INDEX_FILE), 'utf8')

  const report = await install(root)
  const result = await uninstallJianyingDraft({ draftRoot: root, folderName: report.folderName })
  assert.equal(result.removed, true)
  assert.equal(result.restoredIndex, true)
  assert.equal(await readFile(path.join(root, INDEX_FILE), 'utf8'), originalIndex, '索引还原到安装前')

  const folders = await readdir(root)
  assert.deepEqual(folders.filter((name) => name.includes('帧心帧意_')), [])
  for (const name of FOREIGN_DRAFTS) assert.ok(folders.includes(name), `${name} 必须还在`)
})

test('uninstall refuses any folder that is not ours', async (t) => {
  const root = await makeDraftRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  await assert.rejects(
    () => uninstallJianyingDraft({ draftRoot: root, folderName: '9月28日' }),
    /拒绝删除/,
  )
  assert.equal(await readFile(path.join(root, '9月28日', 'draft_content.json'), 'utf8'), 'ENCRYPTED')
})

test('installer refuses to guess when the capcut index is missing or corrupt', async (t) => {
  const root = await makeDraftRoot()
  t.after(() => rm(root, { recursive: true, force: true }))

  await assert.rejects(() => install(root, { draftRoot: path.join(root, 'not-here') }), /找不到剪映草稿目录/)
  await assert.rejects(() => install(path.join(root, 'not-here')), /找不到剪映草稿目录/)

  await writeFile(path.join(root, INDEX_FILE), '{ this is not json', 'utf8')
  await assert.rejects(() => install(root), /无法解析/)
  assert.equal(await readFile(path.join(root, INDEX_FILE), 'utf8'), '{ this is not json', '坏索引不被覆盖')
})

test('installer clears its temporary index file', async (t) => {
  const root = await makeDraftRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  await install(root)
  const leftovers = (await readdir(root)).filter((name) => name.includes('projectdream-tmp'))
  assert.deepEqual(leftovers, [])
})

test('draft folder naming and root resolution are predictable', () => {
  assert.equal(pickAvailableDraftFolderName('A', [], []), 'A')
  assert.equal(pickAvailableDraftFolderName('A', ['A'], []), 'A (2)')
  assert.equal(pickAvailableDraftFolderName('A', ['A', 'A (2)'], []), 'A (3)')
  // 我们自己占用的名字可以复用
  assert.equal(pickAvailableDraftFolderName('A', ['A'], ['A']), 'A')
  assert.equal(
    resolveJianyingDraftRoot({ localAppData: 'C:\\Users\\x\\AppData\\Local' }),
    path.join('C:\\Users\\x\\AppData\\Local', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'),
  )
  assert.equal(resolveJianyingDraftRoot({ override: 'D:\\custom' }), path.resolve('D:\\custom'))
})

test('installed draft carries the marker used to gate deletion', async (t) => {
  const root = await makeDraftRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const report = await install(root)
  const marker = JSON.parse(await readFile(path.join(report.draftDir, DRAFT_MARKER_FILE), 'utf8'))
  assert.equal(marker.projectId, 12)
  assert.equal(marker.draftId, 'projectdream-fixed-id')
  assert.equal(marker.folderName, report.folderName)
  assert.ok(marker.installedAt)
})

test('backup file name stays discoverable for restore', async (t) => {
  const root = await makeDraftRoot()
  t.after(() => rm(root, { recursive: true, force: true }))
  const report = await install(root)
  assert.equal(report.indexBackupPath, path.join(root, `${INDEX_FILE}${INDEX_BACKUP_SUFFIX}`))
  assert.ok((await readdir(root)).includes(`${INDEX_FILE}${INDEX_BACKUP_SUFFIX}`))
})
