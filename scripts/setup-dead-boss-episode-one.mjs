// FastAPI-Only 迁移第六阶段：剧集初始化脚本默认上游由 Node API 切换为 FastAPI（默认 8000，环境变量可覆盖）。
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import mysql from 'mysql2/promise'

import { buildCharacterProductionSnapshot } from '../server/services/character-consistency.mjs'
import { buildSceneContinuityContracts } from '../server/services/shot-continuity-contract.mjs'
import { buildStoryboardAssetReference } from '../server/services/asset-view-contract.mjs'
import { createObjectStorageFromEnv } from '../server/services/object-storage.mjs'
import {
  DEAD_BOSS_ASPECT_RATIO,
  DEAD_BOSS_CHARACTERS,
  DEAD_BOSS_PRODUCTION_BATCH,
  DEAD_BOSS_PROJECT_NAME,
  DEAD_BOSS_SCENES,
  DEAD_BOSS_SHOTS,
  validateDeadBossEpisodePlan,
} from './dead-boss-episode-one-plan.mjs'

const API_ORIGIN = process.env.PROJECTDREAM_API_ORIGIN || 'http://127.0.0.1:8000'
const API_BASE = `${API_ORIGIN}/api`
const OUTPUT_ROOT = 'D:\\AI短剧\\第一集'
const REFERENCE_OUTPUT_ROOT = path.join(OUTPUT_ROOT, '人物参考')
const CHARACTER_SOURCE_ROOT = 'C:\\Users\\杨志泽民\\Desktop\\漫剧人物'
const CONFIRMATION_TOKEN = 'CREATE_DEAD_BOSS_EPISODE_ONE'

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function argValue(name, fallback = '') {
  const prefix = `--${name}=`
  const item = process.argv.find((value) => value.startsWith(prefix))
  return item ? item.slice(prefix.length) : fallback
}

function fail(message) {
  throw new Error(message)
}

async function dbConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  })
}

function json(value) {
  return JSON.stringify(value)
}

async function getToken(db, projectId = 12) {
  const [rows] = await db.execute(
    `SELECT token
     FROM sessions
     WHERE user_id = (SELECT user_id FROM projects WHERE id = ? LIMIT 1)
       AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [projectId],
  )
  if (!rows[0]?.token) fail('没有找到当前用户的有效登录会话')
  return rows[0].token
}

async function apiRequest(token, pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.code) {
    fail(`${options.method || 'GET'} ${pathname} 失败：${body.message || `HTTP ${response.status}`}`)
  }
  return body.data
}

async function resolveCharacterFiles() {
  const fileNames = await readdir(CHARACTER_SOURCE_ROOT)
  return DEAD_BOSS_CHARACTERS.map((character) => {
    const fileName = fileNames.find((item) => character.sourceMatcher(item))
    if (!fileName) fail(`人物参考图缺失：${character.name}`)
    return {
      ...character,
      sourceFileName: fileName,
      sourcePath: path.join(CHARACTER_SOURCE_ROOT, fileName),
    }
  })
}

async function copyReferenceFiles(characters) {
  await mkdir(REFERENCE_OUTPUT_ROOT, { recursive: true })
  const results = []
  for (const character of characters) {
    const extension = path.extname(character.sourceFileName).toLowerCase() || '.png'
    const outputFileName = `${character.key}${extension}`
    const outputPath = path.join(REFERENCE_OUTPUT_ROOT, outputFileName)
    await copyFile(character.sourcePath, outputPath)
    results.push({
      ...character,
      outputPath,
      extension,
    })
  }
  return results
}

async function uploadReferenceFiles(characters, projectId) {
  const storage = createObjectStorageFromEnv()
  const results = []
  for (const character of characters) {
    const extension = character.extension || path.extname(character.sourceFileName).toLowerCase() || '.png'
    const bytes = await readFile(character.sourcePath)
    const storageKey = `projects/${projectId}/characters/${character.key}/reference/v1${extension}`
    const stored = await storage.putObject({
      key: storageKey,
      bytes,
      contentType: extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'image/png',
    })
    results.push({
      ...character,
      storageKey: stored.key,
      storageUrl: stored.url,
    })
  }
  return results
}

function storyBibleValue(characters) {
  return {
    title: DEAD_BOSS_PROJECT_NAME,
    logline:
      '被迫签署离职协议的合规专员，收到来自已死亡三天老板的邮件；老板留下的证据指向她父亲五年前的事故，而邮件却来自她自己的电脑。',
    audience: '喜欢都市职场悬疑、女性逆袭、短集高钩子叙事的移动端观众。',
    emotionalPromise: '每集用一个可视化证据推进真相，让观众在压迫、怀疑和反击中持续追更。',
    worldRules: [
      '公司内部的邮件、电脑、U盘和监控记录都可能被篡改，但必须通过可见证据推进。',
      '赵启明已死亡三天；他只能通过预录视频、语音或邮件信息出现。',
      '第一集不揭露完整幕后真相，只完成“别签字”和发件设备反转。',
    ],
    timeline: [
      '故事发生在赵启明死亡三天后的深夜。',
      '唐宁父亲五年前因事故去世，唐宁一直认为是普通意外。',
      '第一集发生在同一晚、同一间公司办公室内。',
    ],
    locations: ['公司合规办公室', '办公室玻璃门', '唐宁办公桌与电脑'],
    characters: characters.map((character) => ({
      name: character.name,
      role: character.roleTag,
      goal:
        character.key === 'tang-ning'
          ? '确认邮件来源并找到能证明自己没有泄密的证据。'
          : character.key === 'zhao-heng'
            ? '迫使唐宁签字并控制她接触赵启明留下的证据。'
            : '在死后留下足够线索，让唐宁避开签字并追查父亲事故。',
      fear:
        character.key === 'tang-ning'
          ? '自己被当成替罪羊，也害怕父亲的事故另有真相。'
          : character.key === 'zhao-heng'
            ? '证据链被唐宁拼起来，自己的控制失效。'
            : '线索落入赵衡手中，真相无法继续。',
      secret:
        character.key === 'tang-ning'
          ? '她的电脑可能被别人远程控制。'
          : character.key === 'zhao-heng'
            ? '他知道邮件来自唐宁电脑，却没有解释原因。'
            : '他预先录制了分段证据，但死亡时间早于计划。',
      growthArc:
        character.key === 'tang-ning'
          ? '从被迫签字的被动员工，转为主动追查真相的调查者。'
          : character.key === 'zhao-heng'
            ? '从温和管理者逐渐暴露为控制证据和空间的人。'
            : '从死者线索源转为推动唐宁行动的隐形盟友。',
      visualDescription: character.appearance,
    })),
    relationships: [
      '唐宁与赵启明曾存在老板与合规专员的工作关系，赵启明知道她父亲的事故。',
      '赵衡是唐宁的直属管理压力来源，表面代表公司流程，实际阻止证据外泄。',
      '赵衡与赵启明之间存在未公开的权力和证据冲突。',
    ],
    props: ['离职及保密协议', '黑色签字笔', '手机', '第三层抽屉', '黑色U盘', '电脑', '玻璃门锁'],
    mainPlot:
      '唐宁在签字前收到赵启明邮件，按语音找到U盘，听见父亲事故不是意外，最终发现邮件由自己的电脑发出。',
    subplots: ['赵启明留下的证据是否被赵衡提前篡改。'],
    foreshadowing: ['黑色U盘', '赵启明死亡三天', '发件设备为唐宁电脑', '父亲事故不是意外。'],
    lockedFacts: [
      '唐宁固定浅蓝衬衫与米色西装。',
      '赵衡固定深灰西装与黑框眼镜。',
      '赵启明本集只出现肩膀和手，不露脸。',
      '全部对白和屏幕后期文字均使用简体中文。',
    ],
    flexibleFacts: ['办公室具体装饰可以在不改变道具位置的前提下调整。'],
    visualSymbols: ['手机亮屏', '黑色U盘', '电脑黑屏', '玻璃门锁'],
  }
}

function seasonValue() {
  return {
    seasonTheme: '在被公司流程围困时，追查一封来自死者的邮件。',
    coreConflict: '唐宁必须在被迫签字前找到赵启明留下的证据，而赵衡会利用权限、空间和话术阻止她。',
    structureType: '都市职场悬疑短剧：证据出现 -> 追查升级 -> 身份反转',
    episodeCount: 1,
    episodes: [
      {
        episodeNo: 1,
        title: '别签字',
        logline: '死去三天的老板发来“别签字”，邮件却显示来自唐宁自己的电脑。',
        openingHook: '签字笔即将落下时，手机亮起“赵启明：别签字”。',
        goal: '唐宁找到能解释邮件和父亲事故的证据。',
        coreConflict: '赵衡用离职协议和办公室权限逼唐宁停止寻找。',
        irreversibleChange: '唐宁听见父亲事故不是意外，并被锁在办公室内。',
        endingHook: '邮件发件设备显示为唐宁电脑。',
        protagonistChoice: '唐宁选择打开第三层抽屉并读取U盘，而不是立即签字。',
        reversal: '死者邮件不是从赵启明设备发出，而是从唐宁电脑发出。',
        visualSetPieces: ['手机亮屏', '抽屉底板下的黑色U盘', '只露肩膀和手的遗言视频', '玻璃门反锁', '发件设备反转'],
      },
    ],
    foreshadowingPlan: ['黑色U盘', '赵启明死亡三天', '父亲事故不是意外', '发件设备为唐宁电脑'],
    characterArcs: ['唐宁从被迫签字转为主动调查。', '赵衡从温和流程管理者转为危险控制者。'],
  }
}

function outlineValue(projectId, storyBible) {
  return {
    projectId,
    versionNo: 1,
    title: DEAD_BOSS_PROJECT_NAME,
    logline: storyBible.logline,
    premise: storyBible.mainPlot,
    summary: storyBible.mainPlot,
    act1Text: DEAD_BOSS_SCENES[0].content,
    act2Text: DEAD_BOSS_SCENES[1].content,
    act3Text: '第一集以“发件设备：唐宁电脑”结束，完整真相留到后续集数。',
    visualStyle: '写实都市悬疑漫剧，竖屏9:16，冷白办公室、电脑蓝光、低饱和与少量警示红。',
    content: JSON.stringify({
      title: DEAD_BOSS_PROJECT_NAME,
      episodeNo: 1,
      source: 'user-provided-original-script',
      sceneCount: 2,
      shotCount: DEAD_BOSS_SHOTS.length,
    }),
  }
}

function sceneScript(scene, projectId, outlineId) {
  return [
    projectId,
    outlineId,
    scene.sceneNo,
    scene.title,
    scene.summary,
    scene.content,
    scene.mood,
    scene.location,
    scene.timeOfDay,
    scene.estimatedDuration,
    scene.sceneNo - 1,
    'storyboard_ready',
  ]
}

async function seedDatabase({ characters, apply }) {
  const db = await dbConnection()
  try {
    const [ownerRows] = await db.execute(
      `SELECT user_id FROM projects WHERE id = 12 LIMIT 1`,
    )
    const ownerId = Number(ownerRows[0]?.user_id || 1)
    let [projectRows] = await db.execute(
      `SELECT * FROM projects WHERE name = ? AND user_id = ? ORDER BY id DESC LIMIT 1`,
      [DEAD_BOSS_PROJECT_NAME, ownerId],
    )

    if (!apply) {
      return {
        mode: 'dry-run',
        projectName: DEAD_BOSS_PROJECT_NAME,
        ownerId,
        existingProject: projectRows[0] ? { id: Number(projectRows[0].id) } : null,
        plannedShots: DEAD_BOSS_SHOTS.length,
        plannedCharacters: characters.map((item) => item.name),
      }
    }

    await db.beginTransaction()
    try {
      let projectId
      if (projectRows[0]) {
        projectId = Number(projectRows[0].id)
        await db.execute(
          `UPDATE projects
           SET category = ?, target_duration = ?, narrative_vision = ?, visual_style = ?,
               aspect_ratio = ?, status = 'storyboarding', updated_at = NOW()
           WHERE id = ?`,
          [
            '都市职场悬疑漫剧',
            60,
            '女性合规专员追查死者邮件，逐步揭开父亲事故真相。',
            '写实都市悬疑漫剧，冷白办公室、电脑蓝光、少量警示红、竖屏9:16。',
            DEAD_BOSS_ASPECT_RATIO,
            projectId,
          ],
        )
      } else {
        const [result] = await db.execute(
          `INSERT INTO projects
           (user_id, name, category, target_duration, narrative_vision, visual_style, aspect_ratio, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'storyboarding')`,
          [
            ownerId,
            DEAD_BOSS_PROJECT_NAME,
            '都市职场悬疑漫剧',
            60,
            '女性合规专员追查死者邮件，逐步揭开父亲事故真相。',
            '写实都市悬疑漫剧，冷白办公室、电脑蓝光、少量警示红、竖屏9:16。',
            DEAD_BOSS_ASPECT_RATIO,
          ],
        )
        projectId = Number(result.insertId)
      }

      const storyBible = storyBibleValue(characters)
      const [bibleRows] = await db.execute(
        `SELECT id FROM story_bibles WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
        [projectId],
      )
      let storyBibleId
      if (bibleRows[0]) {
        storyBibleId = Number(bibleRows[0].id)
        await db.execute(
          `UPDATE story_bibles
           SET status = 'locked', title = ?, logline = ?, audience = ?, emotional_promise = ?,
               world_rules_json = ?, timeline_json = ?, locations_json = ?, characters_json = ?,
               relationships_json = ?, props_json = ?, main_plot = ?, subplots_json = ?,
               foreshadowing_json = ?, locked_facts_json = ?, flexible_facts_json = ?,
               visual_symbols_json = ?, locked_at = COALESCE(locked_at, NOW()), updated_at = NOW()
           WHERE id = ?`,
          [
            storyBible.title,
            storyBible.logline,
            storyBible.audience,
            storyBible.emotionalPromise,
            json(storyBible.worldRules),
            json(storyBible.timeline),
            json(storyBible.locations),
            json(storyBible.characters),
            json(storyBible.relationships),
            json(storyBible.props),
            storyBible.mainPlot,
            json(storyBible.subplots),
            json(storyBible.foreshadowing),
            json(storyBible.lockedFacts),
            json(storyBible.flexibleFacts),
            json(storyBible.visualSymbols),
            storyBibleId,
          ],
        )
      } else {
        const [result] = await db.execute(
          `INSERT INTO story_bibles
           (project_id, version_no, status, title, logline, audience, emotional_promise,
            world_rules_json, timeline_json, locations_json, characters_json, relationships_json,
            props_json, main_plot, subplots_json, foreshadowing_json, locked_facts_json,
            flexible_facts_json, visual_symbols_json, locked_at)
           VALUES (?, 1, 'locked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            projectId,
            storyBible.title,
            storyBible.logline,
            storyBible.audience,
            storyBible.emotionalPromise,
            json(storyBible.worldRules),
            json(storyBible.timeline),
            json(storyBible.locations),
            json(storyBible.characters),
            json(storyBible.relationships),
            json(storyBible.props),
            storyBible.mainPlot,
            json(storyBible.subplots),
            json(storyBible.foreshadowing),
            json(storyBible.lockedFacts),
            json(storyBible.flexibleFacts),
            json(storyBible.visualSymbols),
          ],
        )
        storyBibleId = Number(result.insertId)
      }

      const season = seasonValue()
      const [seasonRows] = await db.execute(
        `SELECT id FROM season_structures WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
        [projectId],
      )
      let seasonId
      if (seasonRows[0]) {
        seasonId = Number(seasonRows[0].id)
        await db.execute(
          `UPDATE season_structures
           SET story_bible_id = ?, status = 'locked', season_theme = ?, core_conflict = ?,
               structure_type = ?, episode_count = ?, episodes_json = ?,
               foreshadowing_plan_json = ?, character_arcs_json = ?,
               locked_at = COALESCE(locked_at, NOW()), updated_at = NOW()
           WHERE id = ?`,
          [
            storyBibleId,
            season.seasonTheme,
            season.coreConflict,
            season.structureType,
            season.episodeCount,
            json(season.episodes),
            json(season.foreshadowingPlan),
            json(season.characterArcs),
            seasonId,
          ],
        )
      } else {
        const [result] = await db.execute(
          `INSERT INTO season_structures
           (project_id, story_bible_id, version_no, status, season_theme, core_conflict,
            structure_type, episode_count, episodes_json, foreshadowing_plan_json,
            character_arcs_json, locked_at)
           VALUES (?, ?, 1, 'locked', ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            projectId,
            storyBibleId,
            season.seasonTheme,
            season.coreConflict,
            season.structureType,
            season.episodeCount,
            json(season.episodes),
            json(season.foreshadowingPlan),
            json(season.characterArcs),
          ],
        )
        seasonId = Number(result.insertId)
      }

      const outlineData = outlineValue(projectId, storyBible)
      const [outlineRows] = await db.execute(
        `SELECT id FROM story_outlines WHERE project_id = ? ORDER BY version_no DESC, id DESC LIMIT 1`,
        [projectId],
      )
      let outlineId
      if (outlineRows[0]) {
        outlineId = Number(outlineRows[0].id)
        await db.execute(
          `UPDATE story_outlines
           SET title = ?, logline = ?, premise = ?, summary = ?, act1_text = ?, act2_text = ?,
               act3_text = ?, visual_style = ?, content = ?
           WHERE id = ?`,
          [
            outlineData.title,
            outlineData.logline,
            outlineData.premise,
            outlineData.summary,
            outlineData.act1Text,
            outlineData.act2Text,
            outlineData.act3Text,
            outlineData.visualStyle,
            outlineData.content,
            outlineId,
          ],
        )
      } else {
        const [result] = await db.execute(
          `INSERT INTO story_outlines
           (project_id, version_no, title, logline, premise, summary, act1_text, act2_text,
            act3_text, visual_style, content)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            outlineData.projectId,
            outlineData.title,
            outlineData.logline,
            outlineData.premise,
            outlineData.summary,
            outlineData.act1Text,
            outlineData.act2Text,
            outlineData.act3Text,
            outlineData.visualStyle,
            outlineData.content,
          ],
        )
        outlineId = Number(result.insertId)
      }

      const characterIds = new Map()
      for (const character of characters) {
        const [existingRows] = await db.execute(
          `SELECT * FROM characters WHERE project_id = ? AND name = ? LIMIT 1`,
          [projectId, character.name],
        )
        const values = [
          character.roleTag,
          character.personality,
          character.appearance,
          character.costume,
          character.voiceSetting,
          character.ageGroup,
          character.gender,
          character.voiceStyle,
          character.voiceProfileKey,
          character.storageUrl || null,
          character.storageKey || null,
        ]
        let characterId
        if (existingRows[0]) {
          characterId = Number(existingRows[0].id)
          await db.execute(
            `UPDATE characters
             SET role_tag = ?, personality = ?, appearance = ?, costume = ?, voice_setting = ?,
                 age_group = ?, gender = ?, voice_style = ?, voice_profile_key = ?,
                 voice_locked = 1, appearance_locked = 1, costume_locked = 1,
                 reference_image_url = ?, reference_image_storage_key = ?, status = 'finalized',
                 updated_at = NOW()
             WHERE id = ?`,
            [...values, characterId],
          )
        } else {
          const [result] = await db.execute(
            `INSERT INTO characters
             (project_id, name, role_tag, personality, appearance, costume, voice_setting,
              age_group, gender, voice_style, voice_profile_key, voice_locked,
              appearance_locked, costume_locked, reference_image_url, reference_image_storage_key, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?, 'finalized')`,
            [projectId, character.name, ...values],
          )
          characterId = Number(result.insertId)
        }
        const [freshRows] = await db.execute(`SELECT * FROM characters WHERE id = ? LIMIT 1`, [characterId])
        const snapshot = buildCharacterProductionSnapshot(freshRows[0], {
          versionNo: 1,
          changeReason: '第一集人物参考图与固定声线初始化',
        })
        const [versionRows] = await db.execute(
          `SELECT id FROM character_versions WHERE character_id = ? AND version_no = 1 LIMIT 1`,
          [characterId],
        )
        if (versionRows[0]) {
          await db.execute(
            `UPDATE character_versions
             SET status = 'active', snapshot_json = ?, constraint_text = ?, production_ready = 1,
                 change_reason = ?
             WHERE id = ?`,
            [json(snapshot), snapshot.constraintText, snapshot.changeReason, versionRows[0].id],
          )
        } else {
          await db.execute(
            `INSERT INTO character_versions
             (character_id, version_no, status, snapshot_json, constraint_text, production_ready, change_reason)
             VALUES (?, 1, 'active', ?, ?, 1, ?)`,
            [characterId, json(snapshot), snapshot.constraintText, snapshot.changeReason],
          )
        }
        characterIds.set(character.key, characterId)
      }

      const sceneIds = new Map()
      for (const scene of DEAD_BOSS_SCENES) {
        const [existingRows] = await db.execute(
          `SELECT id FROM script_scenes WHERE project_id = ? AND scene_no = ? LIMIT 1`,
          [projectId, scene.sceneNo],
        )
        let sceneId
        const values = sceneScript(scene, projectId, outlineId)
        if (existingRows[0]) {
          sceneId = Number(existingRows[0].id)
          await db.execute(
            `UPDATE script_scenes
             SET outline_id = ?, title = ?, summary = ?, content = ?, mood = ?, location = ?,
                 time_of_day = ?, estimated_duration = ?, sort_order = ?, status = 'storyboard_ready'
             WHERE id = ?`,
            [values[1], values[3], values[4], values[5], values[6], values[7], values[8], values[9], values[10], sceneId],
          )
        } else {
          const [result] = await db.execute(
            `INSERT INTO script_scenes
             (project_id, outline_id, scene_no, title, summary, content, mood, location,
              time_of_day, estimated_duration, sort_order, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            values,
          )
          sceneId = Number(result.insertId)
        }
        sceneIds.set(scene.sceneNo, sceneId)
      }

      const storyboardIds = new Map()
      for (const item of DEAD_BOSS_SHOTS) {
        const sceneId = sceneIds.get(item.sceneNo)
        const characterId = characterIds.get(item.characterKey)
        const [existingRows] = await db.execute(
          `SELECT id FROM storyboards WHERE scene_id = ? AND shot_no = ? LIMIT 1`,
          [sceneId, item.shotNo],
        )
        const sceneAngle = item.shotNo === '01' || item.shotNo === '02'
          ? { key: 'center', index: 5 }
          : item.shotNo === '03' || item.shotNo === '04'
            ? { key: 'right', index: 6 }
            : item.shotNo === '05' || item.shotNo === '06'
              ? { key: 'front-right', index: 3 }
              : item.shotNo === '07' || item.shotNo === '08'
                ? { key: 'left', index: 4 }
                : { key: 'back-right', index: 9 }
        const assetReference = buildStoryboardAssetReference({
          characterId,
          characterVersionNo: 1,
          characterViewSetVersion: 1,
          characterViewKeys: ['front', 'side', 'back'],
          sceneAssetId: null,
          scenePanoramaVersion: null,
          sceneViewSetVersion: null,
          sceneViewKey: sceneAngle.key,
          sceneViewIndex: sceneAngle.index,
          promptVersion: 'dead-boss-episode-one-v1',
          agentVersion: 'douyin-episode-production-v1',
        })
        const values = [
          sceneId,
          item.shotNo,
          item.shotType,
          item.cameraAngle,
          item.composition,
          item.durationSeconds,
          characterId,
          item.characterName,
          item.actionText,
          item.dialogueText,
          item.visualPrompt,
          item.shotPurpose,
          item.actingBeat,
          item.audioDirection,
          'preserve',
          item.reactionShot ? 1 : 0,
          Number(item.shotNo) - 1,
          item.startVisualPrompt,
          item.endVisualPrompt,
        ]
        let storyboardId
        if (existingRows[0]) {
          storyboardId = Number(existingRows[0].id)
          await db.execute(
            `UPDATE storyboards
             SET shot_type = ?, camera_angle = ?, composition = ?, duration_seconds = ?,
                 character_id = ?, character_name = ?, action_text = ?, dialogue_text = ?,
                 visual_prompt = ?, shot_purpose = ?, acting_beat = ?, audio_direction = ?,
                 speech_duration_policy = ?, reaction_shot = ?, sort_order = ?,
                 start_visual_prompt = ?, end_visual_prompt = ?, asset_reference_json = ?, status = 'pending'
             WHERE id = ?`,
            values.slice(2).concat(json(assetReference), storyboardId),
          )
        } else {
          const [result] = await db.execute(
            `INSERT INTO storyboards
             (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds,
              character_id, character_name, action_text, dialogue_text, visual_prompt,
              shot_purpose, acting_beat, audio_direction, speech_duration_policy,
             reaction_shot, sort_order, start_visual_prompt, end_visual_prompt, asset_reference_json, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [...values, json(assetReference)],
          )
          storyboardId = Number(result.insertId)
        }
        storyboardIds.set(item.key, storyboardId)
      }

      for (const scene of DEAD_BOSS_SCENES) {
        const [sceneShotRows] = await db.execute(
          `SELECT * FROM storyboards WHERE scene_id = ? ORDER BY sort_order ASC, id ASC`,
          [sceneIds.get(scene.sceneNo)],
        )
        const contracts = buildSceneContinuityContracts(sceneShotRows)
        for (const contract of contracts) {
          const item = DEAD_BOSS_SHOTS.find((shot) => Number(shot.shotNo) === Number(contract.shotNo))
          const merged = {
            ...contract,
            ...(item?.continuityOverrides || {}),
            storyboardId: Number(contract.storyboardId),
            sceneId: Number(contract.sceneId),
            shotNo: contract.shotNo,
          }
          await db.execute(
            `UPDATE storyboards SET continuity_contract_json = ?, updated_at = NOW() WHERE id = ?`,
            [json(merged), contract.storyboardId],
          )
        }
      }

      await db.commit()
      projectRows = [{ id: projectId }]
      return {
        mode: 'apply',
        projectId,
        storyBibleId,
        seasonId,
        outlineId,
        characterIds: Object.fromEntries(characterIds),
        sceneIds: Object.fromEntries(sceneIds),
        storyboardIds: Object.fromEntries(storyboardIds),
        productionBatch: DEAD_BOSS_PRODUCTION_BATCH,
      }
    } catch (error) {
      await db.rollback()
      throw error
    }
  } finally {
    await db.end()
  }
}

async function createProductionRun(setup, token) {
  const response = await apiRequest(token, `/projects/${setup.projectId}/production-runs`, {
    method: 'POST',
    body: JSON.stringify({
      episodeNo: 1,
      platform: '抖音',
      name: `${DEAD_BOSS_PROJECT_NAME} · 第1集黄金样片`,
      pilotSceneCount: 2,
      pilotMode: 'two-scenes-golden-sample',
      budget: 300,
      candidatePolicy: {
        imageCandidatesPerShot: 2,
        videoCandidatesPerShot: 2,
        audioCandidatesPerLine: 2,
        autoConfirm: false,
        productionBatch: DEAD_BOSS_PRODUCTION_BATCH,
      },
      successMetrics: {
        hookWithinSeconds: 3,
        targetDurationSeconds: 60,
        allDialogueChinese: true,
        characterConsistencyRequired: true,
        voiceConsistencyRequired: true,
        humanReviewRequired: true,
      },
      idempotencyKey: `dead-boss:project:${setup.projectId}:episode:1:v2`,
    }),
  })
  return response
}

async function configureVerticalSettings(token) {
  return apiRequest(token, '/model-settings', {
    method: 'PUT',
    body: JSON.stringify({
      settings: [
        { key: 'FRAME_IMAGE_RATIO', value: DEAD_BOSS_ASPECT_RATIO },
        { key: 'FRAME_IMAGE_SIZE', value: '2K' },
        { key: 'FRAME_WATERMARK_ENABLED', value: 'false' },
        { key: 'VIDEO_SIZE', value: '1080x1920' },
        { key: 'VIDEO_WIDTH', value: '1080' },
        { key: 'VIDEO_HEIGHT', value: '1920' },
        { key: 'VIDEO_FRAME_RATE', value: '24' },
        { key: 'AUDIO_LANGUAGE_TYPE', value: 'Chinese' },
      ],
    }),
  })
}

async function writeManifest({ setup, characters, productionRun }) {
  await mkdir(OUTPUT_ROOT, { recursive: true })
  const manifest = {
    project: DEAD_BOSS_PROJECT_NAME,
    projectId: setup.projectId,
    episodeNo: 1,
    title: '别签字',
    productionBatch: DEAD_BOSS_PRODUCTION_BATCH,
    aspectRatio: DEAD_BOSS_ASPECT_RATIO,
    source: 'user-provided-original-script',
    outputRoot: OUTPUT_ROOT,
    references: characters.map((item) => ({
      name: item.name,
      sourcePath: item.sourcePath,
      copiedPath: item.outputPath,
      storageKey: item.storageKey,
    })),
    shotCount: DEAD_BOSS_SHOTS.length,
    scenes: DEAD_BOSS_SCENES,
    productionRunId: productionRun?.run?.id || productionRun?.id || null,
    generatedAt: new Date().toISOString(),
    reviewRule: '候选必须人工筛选，未确认候选不得进入终剪；旧媒体不删除。',
  }
  const manifestPath = path.join(OUTPUT_ROOT, 'production-manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  return manifestPath
}

async function main() {
  const apply = hasFlag('apply')
  if (apply && argValue('confirm') !== CONFIRMATION_TOKEN) {
    fail(`实际写入必须提供 --confirm=${CONFIRMATION_TOKEN}`)
  }
  const validation = validateDeadBossEpisodePlan()
  if (!validation.valid) fail(validation.errors.join('；'))

  const characters = await resolveCharacterFiles()
  const db = await dbConnection()
  const token = await getToken(db)
  await db.end()

  if (!apply) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      projectName: DEAD_BOSS_PROJECT_NAME,
      characters: characters.map((item) => ({ name: item.name, sourcePath: item.sourcePath })),
      scenes: DEAD_BOSS_SCENES.map((scene) => ({ sceneNo: scene.sceneNo, title: scene.title })),
      shotCount: DEAD_BOSS_SHOTS.length,
      outputRoot: OUTPUT_ROOT,
    }, null, 2))
    return
  }

  const copiedCharacters = await copyReferenceFiles(characters)
  const setup = await seedDatabase({ characters: copiedCharacters, apply: true })
  const projectCharacters = await uploadReferenceFiles(copiedCharacters, setup.projectId)
  const setupWithReferences = await seedDatabase({ characters: projectCharacters, apply: true })
  const productionRun = await createProductionRun(setupWithReferences, token)
  await configureVerticalSettings(token)
  const manifestPath = await writeManifest({
    setup: setupWithReferences,
    characters: projectCharacters,
    productionRun,
  })

  console.log(JSON.stringify({
    ...setupWithReferences,
    productionRunId: productionRun?.run?.id || productionRun?.id || null,
    outputRoot: OUTPUT_ROOT,
    manifestPath,
    next: [
      `node --env-file=.env.local --env-file-if-exists=.env.production scripts/run-dead-boss-episode-one-pilot.mjs --project-id=${setupWithReferences.projectId} --run-id=${productionRun?.run?.id || productionRun?.id || 0} --phase=images`,
      '候选生成后先人工筛选静帧，再进入视频和声音候选阶段。',
    ],
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
