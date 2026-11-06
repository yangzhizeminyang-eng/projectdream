<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  getAssetCanvas,
  getProject,
  type AssetCanvasDTO,
  type AssetNodeType,
  type ProjectDTO,
} from '@/api/project'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'
import { groupAssetNodeImages, selectAssetPreviewImage } from '@/lib/asset-image-groups'

type PageState = 'missing-project' | 'loading' | 'empty' | 'error' | 'ready'
type SortKey = 'newest' | 'oldest' | 'name'
type ParsedTypeFilter = 'all' | AssetNodeType

const route = useRoute()
const router = useRouter()

const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  return fromQuery > 0 ? fromQuery : getWorkspaceContext()?.projectId || 0
})

const pageState = ref<PageState>('loading')
const project = ref<ProjectDTO | null>(null)
const parsedCanvas = ref<AssetCanvasDTO | null>(null)
const errorMsg = ref('')
const searchKeyword = ref('')
const sortKey = ref<SortKey>('newest')
const parsedType = ref<ParsedTypeFilter>('all')

const parsedNodes = computed(() => {
  const nodes = parsedCanvas.value?.nodes || []
  const keyword = searchKeyword.value.trim().toLowerCase()
  const byType = parsedType.value === 'all'
    ? nodes
    : nodes.filter((node) => node.nodeType === parsedType.value)
  const searched = keyword
    ? byType.filter((node) =>
        [node.label, node.appearanceLabel, parsedTypeLabel(node.nodeType)]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(keyword),
      )
    : byType

  return [...searched].sort((a, b) => {
    if (sortKey.value === 'name') return a.label.localeCompare(b.label, 'zh-CN')
    return 0
  })
})

const parsedGroups = computed(() => {
  const nodeMap = new Map(parsedNodes.value.map((node) => [node.id, node]))
  return (parsedCanvas.value?.groups || [])
    .map((group) => ({
      ...group,
      nodes: group.nodeIds
        .map((nodeId) => nodeMap.get(nodeId))
        .filter((node): node is AssetCanvasDTO['nodes'][number] => Boolean(node)),
    }))
    .filter((group) => group.nodes.length)
})

const parsedTabs = computed(() => {
  const byType = parsedCanvas.value?.summary.byType
  return [
    { key: 'all' as const, label: '全部', icon: 'dashboard', count: parsedCanvas.value?.summary.total || 0 },
    { key: 'character' as const, label: '角色', icon: 'person', count: byType?.character || 0 },
    { key: 'scene' as const, label: '场景', icon: 'landscape', count: byType?.scene || 0 },
    { key: 'prop' as const, label: '道具', icon: 'category', count: byType?.prop || 0 },
    { key: 'material' as const, label: '素材', icon: 'texture', count: byType?.material || 0 },
  ]
})

const activeTab = computed(() => parsedTabs.value.find((tab) => tab.key === parsedType.value) || parsedTabs.value[0]!)
const totalNodes = computed(() => parsedCanvas.value?.summary.total || 0)
const pendingCount = computed(() => parsedCanvas.value?.summary.pendingCount || 0)
const readyCount = computed(() => parsedCanvas.value?.summary.readyCount || 0)

function parsedTypeLabel(type: AssetNodeType): string {
  return ({ character: '角色', scene: '场景', prop: '道具', material: '素材' })[type]
}

function parsedTypeIcon(type: AssetNodeType): string {
  return ({ character: 'person', scene: 'landscape', prop: 'category', material: 'texture' })[type]
}

function parsedNodeStateLabel(state: string): string {
  return state === 'confirmed' ? '已锁定' : state === 'ready' ? '有候选图' : '待补充'
}

function nodePreviewImage(node: AssetCanvasDTO['nodes'][number]) {
  return selectAssetPreviewImage(
    groupAssetNodeImages(node.images, node.nodeType),
    node.nodeType,
  ) || node.confirmedImage || node.images[0] || null
}

function cycleSort(): void {
  sortKey.value = sortKey.value === 'newest' ? 'oldest' : sortKey.value === 'oldest' ? 'name' : 'newest'
}

function sortLabel(): string {
  return sortKey.value === 'newest' ? '最新' : sortKey.value === 'oldest' ? '最早' : '名称'
}

function goDashboard(): void {
  router.push('/dashboard')
}

function pipelineQuery(): Record<string, string> {
  const value = route.query.pipelineRunId
  return value ? { pipelineRunId: String(value) } : {}
}

function goStudio(): void {
  if (!projectId.value) return goDashboard()
  router.push({
    path: '/workspace/studio',
    query: {
      projectId: String(projectId.value),
      view: 'overview',
      ...pipelineQuery(),
    },
  })
}

function openParsedNode(node: AssetCanvasDTO['nodes'][number]): void {
  if (!projectId.value) return
  router.push({
    path: '/workspace/assets/canvas',
    query: {
      projectId: String(projectId.value),
      nodeId: String(node.id),
      type: node.nodeType,
      ...pipelineQuery(),
    },
  })
}

function openScript(): void {
  if (!projectId.value) return goDashboard()
  router.push({
    path: '/workspace/studio/script',
    query: {
      projectId: String(projectId.value),
      ...pipelineQuery(),
    },
  })
}

async function loadAssets(): Promise<void> {
  if (!projectId.value) {
    pageState.value = 'missing-project'
    return
  }

  pageState.value = 'loading'
  errorMsg.value = ''
  try {
    setWorkspaceContext({ projectId: projectId.value })
    const [projectData, canvasData] = await Promise.all([
      getProject(projectId.value),
      getAssetCanvas(projectId.value),
    ])
    project.value = projectData
    parsedCanvas.value = canvasData
    pageState.value = canvasData.nodes.length ? 'ready' : 'empty'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '资产分类加载失败'
    pageState.value = 'error'
  }
}

watch(() => route.query.projectId, () => void loadAssets())
onMounted(() => void loadAssets())
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true" :self-managed-scroll="true">
    <section v-if="pageState === 'missing-project'" class="asset-state-screen">
      <div class="asset-state-card">
        <span class="material-symbols-outlined">folder_open</span>
        <h1>先选择一个项目</h1>
        <p>资产分类会跟随项目剧本生成。请从项目总览进入资产中心。</p>
        <button type="button" class="asset-primary-button" @click="goDashboard">返回项目总览</button>
      </div>
    </section>

    <section v-else-if="pageState === 'loading'" class="asset-state-screen">
      <div class="asset-loading-mark" aria-hidden="true"><span></span><span></span><span></span></div>
      <p>正在整理剧本资产…</p>
    </section>

    <section v-else-if="pageState === 'error'" class="asset-state-screen">
      <div class="asset-state-card">
        <span class="material-symbols-outlined">error_outline</span>
        <h1>资产分类没有加载完成</h1>
        <p>{{ errorMsg }}</p>
        <button type="button" class="asset-primary-button" @click="loadAssets">重新加载</button>
      </div>
    </section>

    <section v-else-if="pageState === 'empty'" class="asset-state-screen">
      <div class="asset-state-card asset-empty-card">
        <span class="material-symbols-outlined">account_tree</span>
        <h1>还没有剧本资产</h1>
        <p>完成剧本解析后，角色、场景、道具和素材会自动归入这里。</p>
        <button type="button" class="asset-primary-button" @click="openScript">进入剧本解析</button>
      </div>
    </section>

    <div v-else class="asset-library-shell">
      <aside class="asset-sidebar">
        <div class="asset-sidebar-inner">
          <header class="asset-brand">
            <span class="asset-project-label">{{ project?.name || `项目 ${projectId}` }}</span>
            <h1>资产中心</h1>
            <p>剧本解析出的角色、场景、道具与素材，都从这里进入无限画布。</p>
          </header>

          <section class="asset-category-section">
            <div class="asset-section-heading">
              <span>剧本资产</span>
              <strong>{{ totalNodes }}</strong>
            </div>
            <div class="asset-category-list">
              <button
                v-for="tab in parsedTabs"
                :key="tab.key"
                type="button"
                class="asset-category-button"
                :class="{ 'is-active': parsedType === tab.key }"
                @click="parsedType = tab.key"
              >
                <span class="asset-category-name">
                  <span class="material-symbols-outlined">{{ tab.icon }}</span>
                  {{ tab.label }}
                </span>
                <strong>{{ tab.count }}</strong>
              </button>
            </div>
          </section>

          <section class="asset-sidebar-summary">
            <div><span>待补充</span><strong>{{ pendingCount }}</strong></div>
            <div><span>有候选图</span><strong>{{ readyCount }}</strong></div>
          </section>
        </div>
      </aside>

      <main class="asset-main">
        <div class="asset-main-inner">
          <header class="asset-toolbar">
            <div class="asset-toolbar-title">
              <span class="material-symbols-outlined">account_tree</span>
              <div>
                <span>剧本资产库</span>
                <strong>{{ activeTab.label }}</strong>
              </div>
            </div>
            <div class="asset-toolbar-actions">
              <label class="asset-search">
                <span class="material-symbols-outlined">search</span>
                <input v-model="searchKeyword" type="search" placeholder="搜索当前分类" />
              </label>
              <button type="button" class="asset-sort-button" @click="cycleSort">
                排序：{{ sortLabel() }}
              </button>
              <button type="button" class="asset-return-button" @click="goStudio">
                <span class="material-symbols-outlined">arrow_back</span>
                工作台
              </button>
            </div>
          </header>

          <section class="asset-intro">
            <div>
              <p class="asset-intro-kicker">SCRIPT EXTRACTION</p>
              <h2>{{ activeTab.label }}</h2>
              <p>选择一个资产，直接进入无限画布。后续 Agent 会在画布内按剧情时空继续整理。</p>
            </div>
            <div class="asset-count-badge"><strong>{{ parsedNodes.length }}</strong><span>当前显示</span></div>
          </section>

          <section v-if="parsedGroups.length" class="asset-group-list">
            <article v-for="group in parsedGroups" :key="group.key" class="asset-group-section">
              <header class="asset-group-heading">
                <div>
                  <p class="asset-group-kicker">
                    <span class="material-symbols-outlined">{{ parsedTypeIcon(group.nodeType) }}</span>
                    {{ group.typeLabel }}组
                  </p>
                  <h3>{{ group.label }}</h3>
                </div>
                <div class="asset-group-summary">
                  <strong>{{ group.nodes.length }}</strong>
                  <span>{{ group.nodeType === 'character' ? '个状态' : group.nodeType === 'scene' ? '个视角' : '个节点' }}</span>
                </div>
              </header>

              <TransitionGroup name="asset-grid" tag="div" class="asset-card-grid">
                <button
                  v-for="node in group.nodes"
                  :key="node.id"
                  type="button"
                  class="asset-node-card"
                  @click="openParsedNode(node)"
                >
                  <div class="asset-node-preview">
                    <img
                      v-if="nodePreviewImage(node)?.imageUrl"
                      :src="nodePreviewImage(node)?.imageUrl"
                      :alt="node.label"
                    />
                    <span v-else class="material-symbols-outlined asset-node-placeholder">{{ parsedTypeIcon(node.nodeType) }}</span>
                  </div>
                  <div class="asset-node-copy">
                    <div class="asset-node-labels">
                      <span class="asset-node-type">
                        <span class="material-symbols-outlined">{{ parsedTypeIcon(node.nodeType) }}</span>
                        {{ parsedTypeLabel(node.nodeType) }}
                      </span>
                      <span class="asset-node-state">{{ parsedNodeStateLabel(node.state) }}</span>
                    </div>
                    <div class="asset-node-heading">
                      <div>
                        <h3>{{ node.label || `未命名${parsedTypeLabel(node.nodeType)}` }}</h3>
                        <p>{{ node.appearanceLabel || '等待 Agent 继续补充资产设定' }}</p>
                      </div>
                      <span class="material-symbols-outlined">arrow_forward</span>
                    </div>
                    <div class="asset-node-meta">
                      <span>{{ node.images.length ? `${node.images.length} 张候选图` : '尚未生成图像' }}</span>
                      <span>打开画布</span>
                    </div>
                  </div>
                </button>
              </TransitionGroup>
            </article>
          </section>

          <section v-else class="asset-filter-empty">
            <span class="material-symbols-outlined">search_off</span>
            <h3>当前分类没有匹配资产</h3>
            <p>换一个分类，或清空搜索关键词继续查看。</p>
            <button type="button" class="asset-secondary-button" @click="searchKeyword = ''; parsedType = 'all'">
              查看全部资产
            </button>
          </section>
        </div>
      </main>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.asset-library-shell {
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr);
  min-height: 100%;
  overflow: hidden;
  background: #0b0d0c;
  color: #f1ede6;
}

.asset-sidebar {
  border-right: 1px solid rgba(171, 138, 94, 0.28);
  background: linear-gradient(180deg, rgba(255, 183, 125, 0.045), transparent 28%), #101210;
}

.asset-sidebar-inner {
  position: sticky;
  top: 0;
  padding: 28px 24px;
}

.asset-brand {
  border-bottom: 1px solid rgba(171, 138, 94, 0.28);
  padding-bottom: 26px;
}

.asset-project-label,
.asset-section-heading,
.asset-intro-kicker {
  color: #f1a96f;
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.asset-brand h1 {
  margin: 14px 0 0;
  font-size: 30px;
  line-height: 1.1;
  letter-spacing: -0.02em;
}

.asset-brand p {
  margin: 16px 0 0;
  color: #a6aaa3;
  font-size: 13px;
  line-height: 1.8;
}

.asset-category-section {
  padding-top: 28px;
}

.asset-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.asset-section-heading strong {
  color: #e7e0d7;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}

.asset-category-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
}

.asset-category-button {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid rgba(171, 138, 94, 0.3);
  padding: 0 12px;
  color: #a6aaa3;
  font-size: 12px;
  text-align: left;
  transition: border-color 180ms ease, background-color 180ms ease, color 180ms ease, transform 180ms ease;
}

.asset-category-button:hover,
.asset-category-button.is-active {
  border-color: rgba(241, 169, 111, 0.75);
  background: rgba(241, 169, 111, 0.09);
  color: #ffd0a8;
  transform: translateY(-1px);
}

.asset-category-name {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.asset-category-name .material-symbols-outlined {
  font-size: 16px;
}

.asset-category-button strong {
  color: inherit;
  font-family: ui-monospace, monospace;
  font-size: 12px;
}

.asset-sidebar-summary {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  margin-top: 28px;
  border-top: 1px solid rgba(171, 138, 94, 0.22);
  padding-top: 22px;
}

.asset-sidebar-summary span,
.asset-sidebar-summary strong {
  display: block;
}

.asset-sidebar-summary span {
  color: #89908a;
  font-size: 11px;
}

.asset-sidebar-summary strong {
  margin-top: 7px;
  color: #eee8df;
  font-family: ui-monospace, monospace;
  font-size: 22px;
}

.asset-main {
  min-width: 0;
  overflow: auto;
}

.asset-main-inner {
  width: min(1480px, 100%);
  margin: 0 auto;
  padding: 20px 28px 56px;
}

.asset-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  border: 1px solid rgba(171, 138, 94, 0.28);
  background: rgba(20, 23, 20, 0.96);
  padding: 12px;
}

.asset-toolbar-title,
.asset-toolbar-actions,
.asset-search {
  display: flex;
  align-items: center;
}

.asset-toolbar-title {
  gap: 10px;
  color: #f4c29c;
}

.asset-toolbar-title > .material-symbols-outlined {
  font-size: 22px;
}

.asset-toolbar-title div {
  display: grid;
  gap: 3px;
}

.asset-toolbar-title span {
  color: #9ba39c;
  font-size: 11px;
}

.asset-toolbar-title strong {
  color: #f2eee6;
  font-size: 14px;
  font-weight: 700;
}

.asset-toolbar-actions {
  min-width: 0;
  justify-content: flex-end;
  gap: 8px;
}

.asset-search {
  min-width: min(360px, 34vw);
  height: 42px;
  gap: 8px;
  border: 1px solid rgba(171, 138, 94, 0.3);
  padding: 0 12px;
  background: rgba(7, 9, 8, 0.54);
}

.asset-search span {
  color: #9ba39c;
  font-size: 19px;
}

.asset-search input {
  width: 100%;
  min-width: 0;
  outline: none;
  background: transparent;
  color: #f2eee6;
  font-size: 13px;
}

.asset-search input::placeholder {
  color: #7e857f;
}

.asset-sort-button,
.asset-return-button,
.asset-primary-button,
.asset-secondary-button {
  min-height: 42px;
  border: 1px solid rgba(171, 138, 94, 0.36);
  padding: 0 14px;
  font-size: 12px;
  transition: border-color 180ms ease, background-color 180ms ease, color 180ms ease, transform 180ms ease;
}

.asset-sort-button,
.asset-secondary-button {
  color: #d7d0c7;
}

.asset-sort-button:hover,
.asset-secondary-button:hover {
  border-color: rgba(241, 169, 111, 0.72);
  background: rgba(241, 169, 111, 0.08);
  color: #ffd0a8;
}

.asset-return-button,
.asset-primary-button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border-color: transparent;
  background: #e98208;
  color: #160d04;
  font-weight: 750;
}

.asset-return-button:hover,
.asset-primary-button:hover {
  background: #f39a26;
  transform: translateY(-1px);
}

.asset-return-button .material-symbols-outlined {
  font-size: 16px;
}

.asset-intro {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin: 42px 0 20px;
}

.asset-intro h2 {
  margin: 8px 0 0;
  color: #f2eee6;
  font-size: 28px;
  line-height: 1.1;
}

.asset-intro p:last-child {
  max-width: 62ch;
  margin: 10px 0 0;
  color: #9fa59f;
  font-size: 13px;
  line-height: 1.7;
}

.asset-count-badge {
  display: grid;
  min-width: 92px;
  justify-items: end;
  gap: 3px;
}

.asset-count-badge strong {
  color: #f4c29c;
  font-family: ui-monospace, monospace;
  font-size: 28px;
}

.asset-count-badge span {
  color: #8d968e;
  font-size: 11px;
}

.asset-group-list {
  display: grid;
  gap: 36px;
}

.asset-group-section {
  border-top: 1px solid rgba(171, 138, 94, 0.3);
  padding-top: 18px;
}

.asset-group-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 14px;
}

.asset-group-kicker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #f1a96f;
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.asset-group-kicker .material-symbols-outlined {
  font-size: 16px;
}

.asset-group-heading h3 {
  margin-top: 7px;
  color: #f2eee6;
  font-size: 20px;
}

.asset-group-summary {
  display: grid;
  justify-items: end;
  gap: 3px;
  color: #8d968e;
  font-size: 11px;
}

.asset-group-summary strong {
  color: #f4c29c;
  font-family: ui-monospace, monospace;
  font-size: 24px;
}

.asset-card-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.asset-node-card {
  overflow: hidden;
  border: 1px solid rgba(171, 138, 94, 0.3);
  background: #161916;
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: border-color 220ms ease, box-shadow 220ms ease, transform 220ms ease;
}

.asset-node-card:hover,
.asset-node-card:focus-visible {
  border-color: rgba(241, 169, 111, 0.78);
  box-shadow: 0 16px 34px rgba(0, 0, 0, 0.28);
  outline: none;
  transform: translateY(-3px);
}

.asset-node-preview {
  position: relative;
  display: grid;
  aspect-ratio: 16 / 9;
  min-height: 0;
  place-items: center;
  overflow: hidden;
  background: #f4f3f0;
}

.asset-node-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.asset-node-placeholder {
  color: #aa8d6b;
  font-size: 58px;
}

.asset-node-type,
.asset-node-state {
  display: inline-flex;
  min-height: 26px;
  align-items: center;
  gap: 5px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  padding: 0 8px;
  background: rgba(8, 10, 9, 0.76);
  color: #f5c7a2;
  font-size: 10px;
}

.asset-node-type {
  border-color: rgba(241, 169, 111, 0.34);
}

.asset-node-state {
  margin-left: auto;
  color: #d8dfd8;
}

.asset-node-type .material-symbols-outlined {
  font-size: 14px;
}

.asset-node-copy {
  padding: 16px;
}

.asset-node-labels {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.asset-node-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.asset-node-heading h3 {
  overflow: hidden;
  color: #f2eee6;
  font-size: 18px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-node-heading p {
  overflow: hidden;
  margin-top: 6px;
  color: #9fa59f;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-node-heading > .material-symbols-outlined {
  flex: 0 0 auto;
  color: #9d8c78;
  transition: color 180ms ease, transform 180ms ease;
}

.asset-node-card:hover .asset-node-heading > .material-symbols-outlined {
  color: #f1a96f;
  transform: translateX(3px);
}

.asset-node-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 18px;
  border-top: 1px solid rgba(171, 138, 94, 0.23);
  padding-top: 12px;
  color: #8f9890;
  font-size: 11px;
}

.asset-node-meta span:last-child {
  color: #f1a96f;
}

.asset-filter-empty,
.asset-state-screen {
  display: grid;
  place-items: center;
  align-content: center;
  min-height: 420px;
  color: #9fa59f;
  text-align: center;
}

.asset-filter-empty {
  border: 1px dashed rgba(171, 138, 94, 0.42);
  padding: 56px 20px;
}

.asset-filter-empty .material-symbols-outlined,
.asset-state-card > .material-symbols-outlined,
.asset-loading-mark {
  color: #d49a6b;
  font-size: 42px;
}

.asset-filter-empty h3,
.asset-state-card h1 {
  margin-top: 14px;
  color: #f2eee6;
  font-size: 20px;
}

.asset-filter-empty p,
.asset-state-card p {
  max-width: 42ch;
  margin-top: 8px;
  color: #9fa59f;
  font-size: 13px;
  line-height: 1.7;
}

.asset-filter-empty button,
.asset-state-card button {
  margin-top: 22px;
}

.asset-state-screen {
  min-height: 100%;
  background: #0b0d0c;
}

.asset-state-card {
  display: grid;
  justify-items: center;
  max-width: 460px;
  padding: 36px;
  border: 1px solid rgba(171, 138, 94, 0.3);
  background: #121512;
}

.asset-loading-mark {
  display: flex;
  gap: 7px;
}

.asset-loading-mark span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: asset-pulse 900ms ease-in-out infinite alternate;
}

.asset-loading-mark span:nth-child(2) { animation-delay: 120ms; }
.asset-loading-mark span:nth-child(3) { animation-delay: 240ms; }

.asset-state-screen > p {
  margin-top: 14px;
  color: #9fa59f;
  font-size: 13px;
}

.asset-grid-enter-active,
.asset-grid-leave-active {
  transition: opacity 240ms ease, transform 240ms ease;
}

.asset-grid-enter-from,
.asset-grid-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

@keyframes asset-pulse {
  from { opacity: 0.35; transform: translateY(0); }
  to { opacity: 1; transform: translateY(-4px); }
}

@media (max-width: 1100px) {
  .asset-library-shell { grid-template-columns: 220px minmax(0, 1fr); }
  .asset-main-inner { padding-inline: 20px; }
  .asset-toolbar { align-items: flex-start; flex-direction: column; }
  .asset-toolbar-actions { width: 100%; justify-content: stretch; }
  .asset-search { min-width: 0; flex: 1; }
}

@media (max-width: 760px) {
  .asset-library-shell {
    display: block;
    overflow: visible;
  }
  .asset-sidebar {
    border-right: 0;
    border-bottom: 1px solid rgba(171, 138, 94, 0.28);
  }
  .asset-sidebar-inner { position: static; padding: 20px 16px; }
  .asset-brand { padding-bottom: 20px; }
  .asset-brand h1 { font-size: 26px; }
  .asset-category-list { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .asset-category-button { min-height: 42px; justify-content: center; padding: 0 7px; }
  .asset-category-name { gap: 0; }
  .asset-category-name .material-symbols-outlined { display: none; }
  .asset-category-button strong { display: none; }
  .asset-sidebar-summary { display: none; }
  .asset-main-inner { padding: 14px 14px 36px; }
  .asset-toolbar-actions { flex-wrap: wrap; }
  .asset-search { flex-basis: 100%; order: -1; }
  .asset-intro { align-items: flex-start; margin-top: 28px; }
  .asset-intro h2 { font-size: 24px; }
  .asset-group-heading { align-items: flex-start; }
  .asset-card-grid { grid-template-columns: 1fr; }
  .asset-node-preview { min-height: 200px; }
}

@media (prefers-reduced-motion: reduce) {
  .asset-category-button,
  .asset-node-card,
  .asset-node-preview img,
  .asset-node-heading > .material-symbols-outlined,
  .asset-grid-enter-active,
  .asset-grid-leave-active,
  .asset-loading-mark span {
    transition: none;
    animation: none;
  }
}
</style>
