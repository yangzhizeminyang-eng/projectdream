<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import { getProject, getSeasonStructure, getStoryBible, getCreativeWorkflowGates, listScenes, type CreativeWorkflowGatesDTO, type ProjectDTO } from '@/api/project'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => Number(route.query.projectId) || getWorkspaceContext()?.projectId || 0)
const project = ref<ProjectDTO | null>(null)
const hasBible = ref(false)
const hasSeason = ref(false)
const sceneCount = ref(0)
const workflowGates = ref<CreativeWorkflowGatesDTO | null>(null)
const loading = ref(true)
const error = ref('')

const idea = computed(() => project.value?.narrativeVision?.trim() || '')
const projectName = computed(() => project.value?.name?.trim() || `未命名项目 ${projectId.value}`)
const hasScriptPath = computed(() => hasBible.value || hasSeason.value || sceneCount.value > 0)

const steps = computed(() => [
  {
    key: 'script',
    number: '01',
    icon: 'edit_document',
    title: '剧本生成',
    description: idea.value ? '继续完善故事设定、分集大纲和剧本正文' : '先输入创意，让 Agent 开始搭建故事',
    status: hasScriptPath.value ? '进行中' : '待开始',
    action: idea.value ? '继续剧本生成' : '输入创意',
    path: idea.value
      ? { path: '/workspace/studio/script', query: { projectId: String(projectId.value) } }
      : { path: '/workspace/studio/idea', query: { projectId: String(projectId.value) } },
  },
  {
    key: 'assets',
    number: '02',
    icon: 'inventory_2',
    title: '资产管理',
    description: '解析剧本中的角色、场景和道具，进入资产画布继续锁定',
    status: workflowGates.value?.assets.allowed ? '可进入' : sceneCount.value ? '已锁定' : '待开始',
    action: workflowGates.value?.assets.allowed ? '进入资产管理' : workflowGates.value?.assets.reason || '完成剧本并解析后开放',
    disabled: !workflowGates.value?.assets.allowed,
    path: { path: '/workspace/assets', query: { projectId: String(projectId.value) } },
  },
  {
    key: 'storyboard',
    number: '03',
    icon: 'movie',
    title: '分镜视频生成',
    description: '按集检查分镜提示词、资产引用、音色和视频生成',
    status: workflowGates.value?.storyboard.allowed ? '可进入' : sceneCount.value ? '已锁定' : '待开始',
    action: workflowGates.value?.storyboard.allowed ? '进入分镜视频生成' : workflowGates.value?.storyboard.reason || '确认全部必需资产后开放',
    disabled: !workflowGates.value?.storyboard.allowed,
    path: { path: '/workspace/episodes', query: { projectId: String(projectId.value) } },
  },
])

function go(path: { path: string; query?: Record<string, string> }): void {
  router.push(path)
}

function startIdea(): void {
  go({ path: '/workspace/studio/idea', query: { projectId: String(projectId.value) } })
}

async function load(): Promise<void> {
  if (!projectId.value) {
    error.value = '缺少项目参数，请从项目列表进入。'
    loading.value = false
    return
  }
  setWorkspaceContext({ projectId: projectId.value })
  try {
    const [projectData, bible, season, scenes, gates] = await Promise.all([
      getProject(projectId.value),
      getStoryBible(projectId.value).catch(() => null),
      getSeasonStructure(projectId.value).catch(() => null),
      listScenes(projectId.value).catch(() => []),
      getCreativeWorkflowGates(projectId.value).catch(() => null),
    ])
    project.value = projectData
    hasBible.value = Boolean(bible)
    hasSeason.value = Boolean(season)
    sceneCount.value = scenes.length
    workflowGates.value = gates
    if (route.query.gateCheckFailed === '1') {
      error.value = '暂时无法核验项目流程状态，后续阶段已锁定。请刷新后重试。'
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '创作总览加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <main class="project-studio">
      <header class="project-studio__topbar">
        <div>
          <span class="project-studio__eyebrow">PROJECTDREAM / STUDIO</span>
          <h1>{{ projectName }}</h1>
          <p>从一句创意开始，按三步推进一集漫剧</p>
        </div>
        <button type="button" class="project-studio__new-idea" @click="startIdea">
          <span class="material-symbols-outlined">add</span>
          {{ idea ? '修改创意' : '输入创意' }}
        </button>
      </header>

      <div v-if="loading" class="project-studio__state" role="status">
        <span class="material-symbols-outlined is-spin">progress_activity</span>
        正在读取项目制作状态…
      </div>
      <div v-else-if="error" class="project-studio__state is-error" role="alert">
        <span class="material-symbols-outlined">error</span>
        {{ error }}
        <button type="button" @click="load">重新加载</button>
      </div>
      <template v-else>
        <section v-if="!idea" class="project-studio__idea">
          <div class="project-studio__idea-mark"><span class="material-symbols-outlined">auto_awesome</span></div>
          <div>
            <span class="project-studio__eyebrow">FIRST SCENE</span>
            <h2>先写下这部漫剧的第一句话</h2>
            <p>不需要先准备完整剧本。输入一个想法，后续 Agent 会把它整理成故事设定、分集大纲和可编辑剧本。</p>
          </div>
          <button type="button" class="project-studio__idea-action" @click="startIdea">
            开始输入创意
            <span class="material-symbols-outlined">arrow_forward</span>
          </button>
        </section>

        <section v-else class="project-studio__brief">
          <span class="project-studio__eyebrow">CURRENT IDEA</span>
          <p>{{ idea }}</p>
          <button type="button" @click="startIdea">编辑创意 <span class="material-symbols-outlined">edit</span></button>
        </section>

        <section class="project-studio__steps" aria-label="制作路径">
          <article v-for="step in steps" :key="step.key" class="project-studio__step" :data-step="step.number" :class="{ 'is-ready': step.status === '可进入' || step.status === '进行中', [`is-${step.status === '待开始' ? 'pending' : step.status === '进行中' ? 'active' : 'ready'}`]: true }">
            <div class="project-studio__step-head">
              <span class="project-studio__step-number">{{ step.number }}</span>
              <span class="material-symbols-outlined">{{ step.icon }}</span>
              <span class="project-studio__step-status">{{ step.status }}</span>
            </div>
            <h2>{{ step.title }}</h2>
            <p>{{ step.description }}</p>
            <button type="button" class="project-studio__step-action" :disabled="step.disabled" :title="step.disabled ? step.action : undefined" @click="go(step.path)">
              {{ step.action }}
              <span class="material-symbols-outlined">{{ step.disabled ? 'lock' : 'arrow_forward' }}</span>
            </button>
          </article>
        </section>
      </template>
    </main>
  </WorkspaceLayout>
</template>

<style scoped>
.project-studio {
  --ink: #f3e8dc;
  --muted: #a69d92;
  --line: rgba(243, 222, 199, .14);
  --accent: #f2a36c;
  min-height: 100%;
  padding: 1rem clamp(.9rem, 3vw, 3rem) 3rem;
  background: #0c0f0d;
  color: var(--ink);
}
.project-studio__topbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--line); padding: .5rem 0 1.2rem; }
.project-studio__eyebrow { color: #c18f6f; font: .58rem ui-monospace, monospace; letter-spacing: .15em; }
.project-studio h1 { margin-top: .35rem; font: 600 1.6rem 'Noto Serif SC', serif; }
.project-studio__topbar p, .project-studio__idea p, .project-studio__step p, .project-studio__brief p { color: var(--muted); font-size: .74rem; line-height: 1.7; }
.project-studio__topbar p { margin-top: .3rem; }
.project-studio__new-idea, .project-studio__idea-action, .project-studio__step-action { display: inline-flex; align-items: center; justify-content: center; gap: .4rem; border: 1px solid var(--accent); color: var(--accent); padding: .65rem .85rem; font-size: .7rem; transition: transform .2s ease, background-color .2s ease; }
.project-studio__new-idea:hover, .project-studio__idea-action:hover, .project-studio__step-action:hover { background: rgba(242, 163, 108, .1); transform: translateY(-1px); }
.project-studio__idea { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 1rem; margin-top: 1.2rem; border: 1px solid rgba(242, 163, 108, .34); background: linear-gradient(100deg, rgba(242, 163, 108, .1), rgba(242, 163, 108, .025)); padding: 1.2rem; }
.project-studio__idea-mark { display: grid; width: 3rem; height: 3rem; place-items: center; border: 1px solid rgba(242, 163, 108, .5); color: var(--accent); }
.project-studio__idea h2 { margin-top: .35rem; font: 600 1.05rem 'Noto Serif SC', serif; }
.project-studio__idea-action { white-space: nowrap; }
.project-studio__brief { position: relative; margin-top: 1.2rem; border: 1px solid rgba(242, 163, 108, .24); border-left: 2px solid var(--accent); background: radial-gradient(ellipse at 0 0, rgba(242, 163, 108, .09), transparent 60%), rgba(255,255,255,.025); padding: 1.3rem 1.4rem; }
.project-studio__brief p { max-width: 60rem; margin-top: .65rem; color: #f0e6da; font: 500 1.15rem/1.9 'Noto Serif SC', serif; }
.project-studio__brief button { display: inline-flex; align-items: center; gap: .25rem; margin-top: .65rem; color: var(--accent); font-size: .68rem; }
.project-studio__steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .7rem; margin-top: 1rem; }
.project-studio__step { position: relative; display: flex; min-height: 15rem; flex-direction: column; overflow: hidden; border: 1px solid var(--line); background: linear-gradient(145deg, rgba(255,255,255,.025), transparent 55%), #121612; padding: 1rem; transition: border-color .2s ease, transform .2s ease, background-color .2s ease; }
.project-studio__step::after { position: absolute; right: -.8rem; bottom: -.9rem; color: rgba(242,163,108,.055); content: attr(data-step); font: 700 7rem/1 ui-monospace, monospace; pointer-events: none; }
.project-studio__step:hover, .project-studio__step.is-ready:hover { border-color: rgba(242, 163, 108, .5); background: #171b16; transform: translateY(-2px); }
.project-studio__step.is-ready { border-color: rgba(242, 163, 108, .28); }
.project-studio__step-head { display: flex; align-items: center; gap: .55rem; color: var(--accent); }
.project-studio__step-number { font: .65rem ui-monospace, monospace; color: #c18f6f; }
.project-studio__step-head .material-symbols-outlined { font-size: 1.15rem; }
.project-studio__step-status { margin-left: auto; border: 1px solid rgba(168,214,178,.25); padding: .2rem .42rem; color: #a8d6b2; font-size: .6rem; white-space: nowrap; }
.project-studio__step.is-pending .project-studio__step-status { border-color: rgba(166,157,146,.18); color: #8e8a82; }
.project-studio__step.is-active .project-studio__step-status { border-color: rgba(242,163,108,.36); color: var(--accent); }
.project-studio__step h2 { margin-top: 1.35rem; font: 600 1.05rem 'Noto Serif SC', serif; }
.project-studio__step p { margin-top: .45rem; }
.project-studio__step-action { margin-top: auto; align-self: flex-start; border-color: var(--line); color: #ded2c5; }
.project-studio__step-action:disabled { cursor: not-allowed; opacity: .58; }
.project-studio__step.is-ready .project-studio__step-action { border-color: rgba(242, 163, 108, .5); color: var(--accent); }
.project-studio__state { display: flex; min-height: 28rem; align-items: center; justify-content: center; gap: .5rem; color: var(--muted); }
.project-studio__state.is-error { color: #efa79a; }
.project-studio__state button { border-bottom: 1px solid currentColor; }
.is-spin { animation: spin 1s linear infinite; }
@media (max-width: 760px) {
  .project-studio__topbar { align-items: flex-start; flex-direction: column; }
  .project-studio__new-idea { align-self: stretch; }
  .project-studio__idea { grid-template-columns: auto minmax(0, 1fr); }
  .project-studio__idea-action { grid-column: 1 / -1; width: 100%; }
  .project-studio__steps { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .project-studio__new-idea, .project-studio__idea-action, .project-studio__step-action, .project-studio__step { transition: none; }
}
</style>
