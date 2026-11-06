import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/** 漫剧一体化工作台：阶段 1 验收契约测试（沿用现有"静态源码断言"约定） */

async function read(rel) {
  return readFile(new URL(rel, import.meta.url), 'utf8')
}

test('/workspace/studio 是项目创作总览入口，不再重定向到旧分集页', async () => {
  const router = await read('../router/index.ts')
  assert.match(router, /\/workspace\/studio/)
  assert.match(router, /component: \(\) => import\('@\/views\/ProjectStudio\.vue'\)/)
  assert.doesNotMatch(router, /path: '\/workspace\/studio'[\s\S]{0,300}redirect: \(to\) =>/)
})

test('SideNav 主入口使用项目创作总览', async () => {
  const nav = await read('../components/SideNav.vue')
  assert.match(nav, /创作总览/)
  assert.match(nav, /path: '\/workspace\/studio'/)
})

test('Dashboard 项目入口进入项目创作总览', async () => {
  const dash = await read('../views/Dashboard.vue')
  assert.match(dash, /function openStudio/)
  assert.match(dash, /path: '\/workspace\/studio'/)
  assert.match(dash, /创作总览|漫剧工作台/)
})

test('项目创作总览提供创意入口、三阶段路径且不把剪辑放进主流程', async () => {
  const view = await read('../views/ProjectStudio.vue')
  assert.match(view, /输入创意/)
  assert.match(view, /继续剧本生成/)
  assert.match(view, /剧本生成/)
  assert.match(view, /资产管理/)
  assert.match(view, /分镜视频生成/)
  assert.match(view, /\/workspace\/studio\/idea/)
  assert.match(view, /\/workspace\/studio\/script/)
  assert.match(view, /\/workspace\/assets/)
  assert.match(view, /\/workspace\/episodes/)
  assert.doesNotMatch(view, /剪辑与交付|进入剪辑/)
})

test('工作台页不复用全局 mock Inspector（show-inspector=false，自建生产 Inspector）', async () => {
  const view = await read('../views/ProductionStudio.vue')
  assert.match(view, /:show-inspector="false"/)
  assert.match(view, /production\/ProductionInspector\.vue/)
  assert.doesNotMatch(view, /components\/Inspector\.vue/)
})

test('production-studio 适配层复用现有真实接口，而非 mock 数据', async () => {
  const api = await read('../api/production-studio.ts')
  for (const fn of [
    'listProductionRuns',
    'getProductionRun',
    'listScenes',
    'listStoryboards',
    'getProjectProductionReadiness',
    'getProjectFinalEdit',
    'listShotImages',
    'listStoryboardVideos',
    'listProjectAudio',
  ]) {
    assert.match(api, new RegExp(`\\b${fn}\\b`), `应调用真实接口 ${fn}`)
  }
  // 对外能力
  for (const fn of ['pickProductionRun', 'loadStudioSnapshot', 'loadShotDetail', 'buildShotDetail']) {
    assert.match(api, new RegExp(`export (async )?function ${fn}`), `应导出 ${fn}`)
  }
})

test('当前 ProductionRun 选择必须"进行中 > 等待确认 > 规划 > 最近完成 > 最近创建"，失败/取消不参与，同状态取 ID 最大', async () => {
  const api = await read('../api/production-studio.ts')
  // runRank 优先级：running 排在 waiting_approval / planning / completed 之前
  const switchBody = api.slice(api.indexOf('function runRank'), api.indexOf('function pickProductionRun'))
  const s0 = switchBody.indexOf('running')
  const s1 = switchBody.indexOf('waiting_approval')
  const s2 = switchBody.indexOf('planning')
  const s3 = switchBody.indexOf('completed')
  assert.ok(s0 >= 0 && s1 >= 0 && s2 >= 0 && s3 >= 0, 'runRank 需包含四种状态')
  assert.ok(s0 < s1 && s1 < s2 && s2 < s3, '优先级顺序必须为 running < waiting_approval < planning < completed')
  // 失败 / 取消不可参与选择：过滤 rank < 99，且 default 分支必须回到 99
  assert.match(api, /runRank\(r\.status\) < 99/)
  assert.match(api, /return 99/)
  // 同状态取 ID 最大
  assert.match(api, /r\.id > best\.id/)
  // URL 显式 runId 最高优先级
  assert.match(api, /hintRunId/)
  // 先按单集过滤
  assert.match(api, /episodeNo === episodeNo/ || /r\.episodeNo === episodeNo/)
})

test('工具型纯度函数存在且字段命名与设计一致', async () => {
  const api = await read('../api/production-studio.ts')
  for (const fn of ['buildScenesSummary', 'buildShotsSummary', 'buildStageSummary', 'groupStageSummary']) {
    assert.match(api, new RegExp(`export function ${fn}`))
  }
})

test('分集结构暂不可用时，分集卡片可从场景数据降级恢复', async () => {
  const api = await read('../api/production-studio.ts')
  const body = api.slice(
    api.indexOf('export async function loadEpisodeProductionCards'),
    api.indexOf('export interface ProductionContext'),
  )
  assert.match(body, /Promise\.allSettled/)
  assert.match(body, /const episodeRows = episodes\.length/)
  assert.match(body, /new Map\(sceneRows\.map\(\(scene\) => \[scene\.episodeNo \?\? 1, scene\]\)\)/)
  assert.match(body, /title: `第 \$\{scene\.episodeNo \?\? 1\} 集`/)
  assert.doesNotMatch(body, /title: scene\.title \|\| `第 \$\{scene\.episodeNo \?\? 1\} 集`/)
  assert.match(body, /episodeRows\.map\(\(episode\)/)
})

test('单集工作台严格按 episodeNo 过滤场景，片段生产不串集', async () => {
  const api = await read('../api/production-studio.ts')
  assert.match(api, /filterScenesForEpisode/)
  assert.match(api, /const scenesRaw = filterScenesForEpisode\(/)
})

test('片段预演先生成并核对关键帧，视频模型只在明确操作后提交', async () => {
  const view = await read('../views/ProductionStudio.vue')
  assert.match(view, /async function rehearseCurrentClip\(/)
  assert.match(view, /buildClipRehearsalReport\(/)
  assert.match(view, /generateShotImages\(item\.shot\.storyboardId/)
  assert.match(view, /视频任务数 0/)
  assert.match(view, /@click="rehearseCurrentClip"/)
  assert.match(view, /@click="generateCurrentClipVideos"/)
  assert.doesNotMatch(view, /modelName: 'agnes-video-2\.5-flash'/)
  assert.match(view, /当前模型配置/)
  assert.match(view, /candidateCount: 1/)
  assert.match(view, /if \(!clipRehearsalReport\.value\?\.ready\)/)
})

test('分镜制作界面明确展示片段场景锁定和预演与视频生成边界', async () => {
  const view = await read('../views/ProductionStudio.vue')
  assert.match(view, /本片段场景设定在/)
  assert.match(view, /片段内镜头共用此场景资产/)
  assert.match(view, /预演只检查连续性，不创建视频任务/)
  assert.match(view, /单镜头只提交当前分镜/)
  assert.match(view, /整段按镜头分别提交视频任务/)
  assert.match(view, /片段 \{\{ String\(currentClip\.sceneNo\)/)
  assert.match(view, /buildUnifiedStoryboardPrompt/)
  assert.match(view, /prompt: buildUnifiedStoryboardPrompt\(storyboardDraft\.value\)/)
  assert.match(view, /prompt: buildUnifiedStoryboardPrompt\(\{/)
  assert.doesNotMatch(view, /<span>镜头动作<\/span>/)
  assert.doesNotMatch(view, /<span>对白与声音<\/span>/)
  assert.doesNotMatch(view, /<span>起始帧参考<\/span>/)
  assert.doesNotMatch(view, /<span>结束帧参考<\/span>/)
})

test('单镜头生产卡必须输出机器可读的工作流状态和唯一下一步', async () => {
  const api = await read('../api/production-studio.ts')
  assert.match(api, /export interface ShotWorkflowStep/)
  assert.match(api, /export interface ShotBlockingItem/)
  assert.match(api, /export interface ShotNextAction/)
  assert.match(api, /workflowSteps: ShotWorkflowStep\[\]/)
  assert.match(api, /blockingItems: ShotBlockingItem\[\]/)
  assert.match(api, /nextAction: ShotNextAction/)
  assert.match(api, /function deriveShotWorkflow/)
  assert.match(api, /nextActionKey/)
})

test('镜头工作流的下一步必须按画面、主动作、视频、声音、连续性和剪辑顺序收敛', async () => {
  const api = await read('../api/production-studio.ts')
  const body = api.slice(api.indexOf('function deriveShotWorkflow'), api.indexOf('export function buildShotDetail'))
  for (const key of [
    'confirm-frame',
    'define-action',
    'generate-video',
    'prepare-sound',
    'review-continuity',
    'open-edit',
  ]) {
    assert.match(body, new RegExp(key), `工作流必须包含 ${key}`)
  }
  assert.match(body, /唯一下一步|nextAction/)
})

test('工作台必须把当前镜头工作流和下一步作为真实生产卡能力展示', async () => {
  const view = await read('../views/ProductionStudio.vue')
  const card = await read('../components/production/ShotProductionCard.vue')
  assert.match(view, /@action="handleShotAction"/)
  assert.match(card, /这个镜头怎么做/)
  assert.match(card, /workflowSteps/)
  assert.match(card, /nextAction/)
  assert.match(card, /blockingItems/)
})

test('工作台阶段在桌面与移动端共用三个创作阶段分组', async () => {
  const api = await read('../api/production-studio.ts')
  const studio = await read('../views/ProductionStudio.vue')
  assert.match(api, /export const STAGE_GROUPS/)
  assert.match(api, /label: '剧本生成'/)
  assert.match(api, /label: '资产管理'/)
  assert.match(api, /label: '分镜视频生成'/)
  assert.doesNotMatch(api.slice(api.indexOf('export const STAGE_GROUPS'), api.indexOf('/** 将 run 的真实阶段状态')), /剪辑与交付/)
  assert.match(studio, /v-for="\(s, i\) in groupedStages"/)
  assert.doesNotMatch(studio, /v-for="\(s, i\) in snapshot\.stages"/)
})

test('阶段阻塞数量必须来自真实阶段状态，而不是只看 ProductionRun 总状态', async () => {
  const api = await read('../api/production-studio.ts')
  const body = api.slice(api.indexOf('const stages = STAGE_KEYS'), api.indexOf('// “当前阶段”标记'))
  assert.match(body, /real === 'blocked'/)
  assert.match(body, /real === 'rework'/)
  assert.match(body, /blockedCount/)
})

test('镜头候选可在工作台内预览与切换对照，不再点击缩略图就跳出页面', async () => {
  const card = await read('../components/production/ShotProductionCard.vue')
  assert.match(card, /@click="selectCandidate\('video', v\)"/)
  assert.match(card, /@click="selectCandidate\('audio', a\)"/)
  assert.match(card, /<video[^>]*controls/)
  assert.match(card, /<audio[^>]*controls/)
  assert.match(card, /切换对照版本/)
})

test('候选确认必须调用真实确认接口、刷新当前镜头数据并反馈失败', async () => {
  const view = await read('../views/ProductionStudio.vue')
  const card = await read('../components/production/ShotProductionCard.vue')
  assert.match(view, /confirmVideo/)
  assert.match(view, /confirmProjectAudio/)
  assert.match(view, /async function confirmCandidate/)
  assert.match(view, /await loadDetailFor\(storyboardId\)/)
  assert.match(view, /await listProjectAudio\(projectId\)/)
  assert.match(view, /@confirm-candidate="confirmCandidate"/)
  assert.match(card, /confirm-candidate/)
  assert.match(card, /aria-live="polite"/)
  assert.match(card, /pendingCandidateKey/)
})

test('候选卡保留独立的视频和音频模块入口作为生成与返工路径', async () => {
  const card = await read('../components/production/ShotProductionCard.vue')
  assert.match(card, /emit\('action', 'video'\)/)
  assert.match(card, /emit\('action', 'audio'\)/)
})

test('候选复核台支持多选、全选待复核和真实批量归档入口', async () => {
  const view = await read('../views/ProductionStudio.vue')
  const card = await read('../components/production/ShotProductionCard.vue')
  assert.match(card, /候选复核台/)
  assert.match(card, /selectAllPending/)
  assert.match(card, /archive-candidates/)
  assert.match(card, /加入视频候选复核队列/)
  assert.match(card, /加入音频候选复核队列/)
  assert.match(view, /archiveProjectAsset/)
  assert.match(view, /for \(const candidate of candidates\)/)
  assert.match(view, /已归档/)
})

test('候选详情保留生成参数与成本追溯字段，缺失数据时不伪造', async () => {
  const api = await read('../api/production-studio.ts')
  const card = await read('../components/production/ShotProductionCard.vue')
  assert.match(api, /getProjectCostLedger/)
  assert.match(api, /generationJobId/)
  assert.match(api, /estimatedCost/)
  assert.match(api, /costStatus/)
  assert.match(card, /生成任务/)
  assert.match(card, /估算成本/)
  assert.match(card, /动作模式/)
})

test('工作台提供跨镜头候选总览、批量归档和返工队列入口', async () => {
  const view = await read('../views/ProductionStudio.vue')
  const overview = await read('../components/production/CandidateOverview.vue')
  const queue = await read('../lib/rework-queue.ts')
  assert.match(view, /CandidateOverview/)
  assert.match(view, /loadCandidateOverview/)
  assert.match(view, /@archive="archiveOverviewCandidates"/)
  assert.match(view, /@rework="addOverviewRework"/)
  assert.match(view, /startReworkQueue/)
  assert.match(overview, /跨镜头候选总览/)
  assert.match(overview, /加入返工队列/)
  assert.match(queue, /enqueueReworkItems/)
  assert.match(queue, /startNextReworkItem/)
})

test('返工队列进入视频和音频生成页后会声明上下文并在生成成功后回写完成', async () => {
  const video = await read('../views/VideoGenerate.vue')
  const audio = await read('../views/AudioStudio.vue')
  for (const source of [video, audio]) {
    assert.match(source, /reworkCandidateId/)
    assert.match(source, /claimReworkItem/)
    assert.match(source, /completeReworkItem/)
    assert.match(source, /正在处理返工/)
  }
  assert.match(video, /completeReworkItem\(projectId\.value, reworkContext\.value\.candidateId, 'video'\)/)
  assert.match(audio, /completeReworkItem\(projectId\.value, reworkContext\.value\.candidateId, 'audio'\)/)
})

test('底部预览时间线保留进入可编辑剪辑器的真实入口', async () => {
  const view = await read('../views/ProductionStudio.vue')
  const timeline = await read('../components/production/ProductionLightTimeline.vue')
  assert.match(view, /@open-edit="openEdit"/)
  assert.match(timeline, /打开剪辑器/)
  assert.match(timeline, /emit\('openEdit'\)/)
})
