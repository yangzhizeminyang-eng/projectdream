import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const studio = await readFile(new URL('./StoryboardVideoStudio.vue', import.meta.url), 'utf8')
const workbench = await readFile(new URL('./EpisodeWorkbench.vue', import.meta.url), 'utf8')
const router = await readFile(new URL('../router/index.ts', import.meta.url), 'utf8')
const productionStudio = await readFile(new URL('./ProductionStudio.vue', import.meta.url), 'utf8')
const navigation = await readFile(new URL('../lib/navigation.ts', import.meta.url), 'utf8')

test('分镜视频生成使用独立创作路由', () => {
  assert.match(router, /path: '\/workspace\/episodes\/studio'/)
  assert.match(router, /StoryboardVideoStudio\.vue/)
  assert.match(workbench, /path: '\/workspace\/episodes\/studio'/)
  assert.match(router, /path: '\/workspace\/storyboard\/editor'[\s\S]{0,180}redirect:.*storyboard-video-studio/)
})

test('项目分镜入口和工作台返回路径统一指向当前分集分镜工作流', () => {
  assert.match(productionStudio, /storyboard: '\/workspace\/episodes'/)
  assert.match(navigation, /route\.path === '\/workspace\/episodes\/studio'[\s\S]{0,180}workspace\/episodes/)
})

test('资产画布和旧分镜列表进入当前的视频创作工作台', async () => {
  const canvas = await readFile(new URL('./AssetCanvas.vue', import.meta.url), 'utf8')
  const storyboardList = await readFile(new URL('./StoryboardList.vue', import.meta.url), 'utf8')

  assert.match(canvas, /workspace\/episodes/)
  assert.match(storyboardList, /path: '\/workspace\/episodes\/studio'/)
  assert.match(storyboardList, /episodeNo/)
  assert.doesNotMatch(storyboardList, /path: '\/workspace\/storyboard\/editor'/)
})

test('旧分镜编辑页不再公开静帧生成入口', async () => {
  const editor = await readFile(new URL('./StoryboardEditor.vue', import.meta.url), 'utf8')

  assert.doesNotMatch(editor, /画面生成/)
  assert.doesNotMatch(editor, /openFrameGenerate/)
})

test('独立创作页只承载资产、分镜、预览和时间线闭环', () => {
  assert.match(studio, /本集资产/)
  assert.match(studio, /分镜脚本/)
  assert.match(studio, /视频预览/)
  assert.match(studio, /剧情片段/)
  assert.match(studio, /立即生成视频/)
  assert.match(studio, /保存并用于本镜/)
  assert.doesNotMatch(studio, /进入剪辑/)
  assert.doesNotMatch(studio, /ShotProductionCard/)
  assert.doesNotMatch(studio, /候选总览/)
})

test('创作页最多展示一条待采用视频，只有用户采用后才替换当前主视频', () => {
  assert.match(studio, /videoCandidates/)
  assert.match(studio, /pendingVideo/)
  assert.match(studio, /detail\.value\?\.currentVideo/)
  assert.match(studio, /当前视频/)
  assert.match(studio, /confirmVideo/)
  assert.match(studio, /采用此视频/)
  assert.match(studio, /单条视频已生成.*等待你采用/)
  assert.doesNotMatch(studio, /v-for="candidate in detail\.value\?\.videoCandidates/)
  assert.match(studio, /活跃帧/)
})

test('分镜视频创作页每次生成一个待采用结果，不满意时可重新生成替换待采用结果', () => {
  assert.match(studio, /candidateCount: 1/)
  assert.doesNotMatch(studio, /candidateCount: 2/)
  assert.match(studio, /previewVideo \? '不满意，重新生成' : '立即生成视频'/)
  assert.match(studio, /autoConfirm: false/)
  assert.match(studio, /采用此视频/)
  assert.match(studio, /后续重新生成不会覆盖它/)
})

test('创作页完成进度同时识别已确认视频，不把候选误报为零生成', () => {
  assert.match(studio, /videoCandidatesByStoryboard/)
  assert.match(studio, /status === 'confirmed'/)
  assert.doesNotMatch(studio, /currentShots\.value\.filter\(\(shot\) => shot\.videoUrl\)/)
})

test('分镜工作台按项目、集、片段、镜头展示，且片段中的镜头不会混排', () => {
  assert.match(studio, /buildEpisodeClips\(episodeScenes\.value, currentShots\.value\)/)
  assert.match(studio, /aria-label="选择本集片段"/)
  assert.match(studio, /v-for="clip in episodeClips"/)
  assert.match(studio, /v-for="shot in visibleShots"/)
  assert.match(studio, /片段内镜头共用场景上下文/)
  assert.match(studio, /timeline-clip/)
  assert.match(studio, /requestedStoryboardId = queryNumber\(route\.query\.storyboardId\)/)
  assert.match(studio, /currentShots\.value\.find\(\(shot\) => shot\.storyboardId === requestedStoryboardId\)/)
})

test('分镜创作页使用真实资产 mention 和角色音色编辑链路', () => {
  assert.match(studio, /getAssetCanvas/)
  assert.match(studio, /listCharacterImages/)
  assert.match(studio, /mention-popover/)
  assert.match(studio, /本集资产/)
  assert.match(studio, /小工具/)
  assert.match(studio, /添加时间/)
  assert.match(studio, /首尾帧参考/)
  assert.match(studio, /referencedAssets/)
  assert.match(studio, /prompt-references/)
  assert.match(studio, /saveCharacterReferenceAudio/)
  assert.match(studio, /bindCharacterVoice/)
  assert.match(studio, /previewCharacterVoice/)
  assert.match(studio, /待生成/)
  assert.doesNotMatch(studio, /老周/)
  assert.doesNotMatch(studio, /at > 0 && !\/\\s\/\.test/)
})
