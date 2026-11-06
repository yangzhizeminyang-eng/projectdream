import mysql from 'mysql2/promise'

import { buildProjectStoryDraft } from '../server/services/project-story-draft.mjs'
import { evaluateSeasonStructure, evaluateStoryBible } from '../server/services/story-quality.mjs'

const CONFIRMATION_TOKEN = 'SAVE_PROJECT_STORY_DRAFT'

function readOption(name) {
  const prefix = `--${name}=`
  const argument = process.argv.find((item) => item.startsWith(prefix))
  return argument ? argument.slice(prefix.length) : null
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function positiveInteger(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function storyBibleValues(bible) {
  return [
    bible.title,
    bible.logline,
    bible.audience,
    bible.emotionalPromise,
    JSON.stringify(bible.worldRules),
    JSON.stringify(bible.timeline),
    JSON.stringify(bible.locations),
    JSON.stringify(bible.characters),
    JSON.stringify(bible.relationships),
    JSON.stringify(bible.props),
    bible.mainPlot,
    JSON.stringify(bible.subplots),
    JSON.stringify(bible.foreshadowing),
    JSON.stringify(bible.lockedFacts),
    JSON.stringify(bible.flexibleFacts),
    JSON.stringify(bible.visualSymbols),
  ]
}

function seasonValues(season) {
  return [
    season.seasonTheme,
    season.coreConflict,
    season.structureType,
    season.episodeCount,
    JSON.stringify(season.episodes),
    JSON.stringify(season.foreshadowingPlan),
    JSON.stringify(season.characterArcs),
  ]
}

async function persistStoryBible(db, projectId, bible, report) {
  const [rows] = await db.execute(
    `SELECT id, version_no, status
     FROM story_bibles
     WHERE project_id = ?
     ORDER BY version_no DESC, id DESC
     LIMIT 1`,
    [projectId],
  )
  const latest = rows[0]
  const values = storyBibleValues(bible)

  if (latest?.status === 'draft') {
    await db.execute(
      `UPDATE story_bibles
       SET title = ?,
           logline = ?,
           audience = ?,
           emotional_promise = ?,
           world_rules_json = ?,
           timeline_json = ?,
           locations_json = ?,
           characters_json = ?,
           relationships_json = ?,
           props_json = ?,
           main_plot = ?,
           subplots_json = ?,
           foreshadowing_json = ?,
           locked_facts_json = ?,
           flexible_facts_json = ?,
           visual_symbols_json = ?,
           quality_report_json = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [...values, JSON.stringify(report), latest.id],
    )
    return { id: Number(latest.id), versionNo: Number(latest.version_no), reusedDraft: true }
  }

  const nextVersion = Number(latest?.version_no || 0) + 1
  const [result] = await db.execute(
    `INSERT INTO story_bibles
     (project_id, version_no, status, title, logline, audience, emotional_promise,
       world_rules_json, timeline_json, locations_json, characters_json, relationships_json,
       props_json, main_plot, subplots_json, foreshadowing_json, locked_facts_json,
       flexible_facts_json, visual_symbols_json, quality_report_json)
     VALUES (?, ?, 'draft', ${Array.from({ length: 17 }, () => '?').join(', ')})`,
    [projectId, nextVersion, ...values, JSON.stringify(report)],
  )
  return { id: Number(result.insertId), versionNo: nextVersion, reusedDraft: false }
}

async function persistSeason(db, projectId, storyBibleId, season, report) {
  const [rows] = await db.execute(
    `SELECT id, version_no, status
     FROM season_structures
     WHERE project_id = ?
     ORDER BY version_no DESC, id DESC
     LIMIT 1`,
    [projectId],
  )
  const latest = rows[0]
  const values = seasonValues(season)

  if (latest?.status === 'draft') {
    await db.execute(
      `UPDATE season_structures
       SET story_bible_id = ?,
           season_theme = ?,
           core_conflict = ?,
           structure_type = ?,
           episode_count = ?,
           episodes_json = ?,
           foreshadowing_plan_json = ?,
           character_arcs_json = ?,
           quality_report_json = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [storyBibleId, ...values, JSON.stringify(report), latest.id],
    )
    return { id: Number(latest.id), versionNo: Number(latest.version_no), reusedDraft: true }
  }

  const nextVersion = Number(latest?.version_no || 0) + 1
  const [result] = await db.execute(
    `INSERT INTO season_structures
     (project_id, story_bible_id, version_no, status, season_theme, core_conflict,
       structure_type, episode_count, episodes_json, foreshadowing_plan_json,
       character_arcs_json, quality_report_json)
     VALUES (?, ?, ?, 'draft', ${Array.from({ length: 8 }, () => '?').join(', ')})`,
    [projectId, storyBibleId, nextVersion, ...values, JSON.stringify(report)],
  )
  return { id: Number(result.insertId), versionNo: nextVersion, reusedDraft: false }
}

async function main() {
  const projectId = positiveInteger(readOption('project-id'), 12)
  const apply = hasFlag('apply')
  const confirmation = readOption('confirm')
  const draft = buildProjectStoryDraft(projectId)
  const bibleReport = evaluateStoryBible(draft.bible)
  const seasonReport = evaluateSeasonStructure(draft.season)

  if (!bibleReport.canLock || !seasonReport.canLock) {
    throw new Error('故事草稿未通过故事圣经或整季市场质量门禁，拒绝写入')
  }

  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  })

  try {
    const [projects] = await db.execute(
      `SELECT id, name, status
       FROM projects
       WHERE id = ?
       LIMIT 1`,
      [projectId],
    )
    if (!projects[0]) throw new Error(`项目 ${projectId} 不存在，拒绝写入故事草稿`)

    const [lockedBibles] = await db.execute(
      `SELECT id, version_no
       FROM story_bibles
       WHERE project_id = ? AND status = 'locked'
       ORDER BY version_no DESC, id DESC
       LIMIT 1`,
      [projectId],
    )
    const [lockedSeasons] = await db.execute(
      `SELECT id, version_no
       FROM season_structures
       WHERE project_id = ? AND status = 'locked'
       ORDER BY version_no DESC, id DESC
       LIMIT 1`,
      [projectId],
    )

    const preview = {
      mode: apply ? 'apply' : 'dry-run',
      projectId,
      projectName: projects[0].name,
      draftVersion: draft.version,
      lockedVersionPreserved: {
        storyBible: lockedBibles[0] || null,
        seasonStructure: lockedSeasons[0] || null,
      },
      storyBibleReport: {
        score: bibleReport.score,
        canLock: bibleReport.canLock,
        blockerCount: bibleReport.blockers.length,
      },
      seasonReport: {
        score: seasonReport.score,
        canLock: seasonReport.canLock,
        marketScore: seasonReport.marketQuality.score,
        blockerCount: seasonReport.blockers.length,
      },
      plannedWrite: {
        storyBibleStatus: 'draft',
        seasonStructureStatus: 'draft',
        episodeCount: draft.season.episodeCount,
      },
    }

    if (!apply) {
      console.log(JSON.stringify(preview, null, 2))
      return
    }

    if (confirmation !== CONFIRMATION_TOKEN) {
      throw new Error(`实际写入必须提供 --confirm=${CONFIRMATION_TOKEN}`)
    }

    await db.beginTransaction()
    try {
      const bible = await persistStoryBible(db, projectId, draft.bible, bibleReport)
      const season = await persistSeason(db, projectId, bible.id, draft.season, seasonReport)
      await db.commit()
      console.log(JSON.stringify({
        ...preview,
        persisted: {
          storyBible: bible,
          seasonStructure: season,
        },
      }, null, 2))
    } catch (error) {
      await db.rollback()
      throw error
    }
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(String(error?.message || error))
  process.exitCode = 1
})
