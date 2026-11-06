<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import { getProject, updateProject, type ProjectDTO } from '@/api/project'

const route = useRoute()
const router = useRouter()
const composerRoot = ref<HTMLElement | null>(null)
const projectId = computed(() => Number(route.query.projectId) || 0)
const project = ref<ProjectDTO | null>(null)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const connectionFailed = ref(false)
const sourceFile = ref<File | null>(null)
const sourceFileName = ref('')
const form = reactive({
  category: '悬疑推理漫剧',
  aspectRatio: '9:16',
  visualStyle: '冷峻科幻，冷蓝金属与红色警示灯',
  episodeCount: 10,
  idea: '',
})

const categories = ['悬疑推理漫剧', '都市情感漫剧', '古风玄幻漫剧', '科幻剧情片', '热血冒险漫剧']
const styles = ['冷峻科幻，冷蓝金属与红色警示灯', '黑色电影，硬光与深阴影', '新中式奇幻，水墨与留白', '暖色胶片，自然柔光与颗粒']
const topics = [
  { label: '悬疑推理', value: categories[0], note: '线索、反转与追更钩子', group: '受众偏好' },
  { label: '都市情感', value: categories[1], note: '关系变化与情绪张力', group: '受众偏好' },
  { label: '古风玄幻', value: categories[2], note: '世界规则与奇观场面', group: '题材背景' },
  { label: '科幻剧情', value: categories[3], note: '设定驱动的戏剧冲突', group: '题材背景' },
  { label: '热血冒险', value: categories[4], note: '目标、成长与连续动作', group: '观感偏好' },
  { label: '轻喜反转', value: '轻喜反转漫剧', note: '高密度笑点与意外收束', group: '观感偏好' },
  { label: '成长逆袭', value: '成长逆袭漫剧', note: '低谷、选择与阶段性胜利', group: '人设标签' },
  { label: '双强关系', value: '双强关系漫剧', note: '势均力敌的合作与对抗', group: '核心关系' },
]
const topicGroups = ['受众偏好', '题材背景', '人设标签', '核心关系', '观感偏好']
const styleOptions = [
  { label: '冷峻科幻', value: styles[0], note: '真人 · 冷蓝金属与红色警示灯', group: '真人', image: '/images/styles/style-cold.webp' },
  { label: '黑色电影', value: styles[1], note: '真人 · 硬光与深阴影', group: '真人', image: '/images/styles/style-noir.webp' },
  { label: '新中式奇幻', value: styles[2], note: '2D · 水墨质感与呼吸留白', group: '2D', image: '/images/styles/style-ink.webp' },
  { label: '暖色胶片', value: styles[3], note: '真人 · 自然柔光与细腻颗粒', group: '真人', image: '/images/styles/style-film.webp' },
  { label: '国风漫剧', value: '国风 2D 漫剧，清晰线稿，东方色彩，高密度叙事构图', note: '2D · 东方悬疑', group: '2D', image: '/images/styles/style-ink.webp' },
  { label: '高清国漫', value: '国漫 3D 高清渲染，细腻材质，真实光影，电影级构图', note: '3D · 高清渲染', group: '3D', image: '/images/styles/style-cg.webp' },
  { label: '写实 CG', value: '半写实精致 CG，真实人物比例，细腻皮肤与服装材质', note: '3D · 半写实', group: '3D', image: '/images/styles/style-cg.webp' },
]
const styleGroups = ['全部', '真人', '2D', '3D']
const activeStyleGroup = ref('全部')
const filteredStyleOptions = computed(() => styleOptions.filter((option) => activeStyleGroup.value === '全部' || option.group === activeStyleGroup.value))
const selectedStyleOption = computed(() => styleOptions.find((option) => option.value === form.visualStyle))
const activeTopicGroup = ref('受众偏好')
const topicSearch = ref('')
const filteredTopicOptions = computed(() => {
  const query = topicSearch.value.trim().toLowerCase()
  return topics.filter((option) => {
    const matchesGroup = option.group === activeTopicGroup.value
    const matchesQuery = !query || `${option.label}${option.value}${option.note}`.toLowerCase().includes(query)
    return matchesGroup && matchesQuery
  })
})
const selectedTopicOption = computed(() => topics.find((option) => option.value === form.category))
const ratioOptions = [
  { value: '9:16', label: '竖屏', note: '移动端连载', className: 'ratio-portrait' },
  { value: '16:9', label: '横屏', note: '宽幅叙事', className: 'ratio-landscape' },
  { value: '21:9', label: '电影', note: '宽银幕叙事', className: 'ratio-cinema' },
  { value: '3:4', label: '竖幅', note: '人物海报', className: 'ratio-poster' },
  { value: '4:3', label: '经典', note: '经典叙事', className: 'ratio-classic' },
  { value: '1:1', label: '方形', note: '社媒封面', className: 'ratio-square' },
]
const selectedRatioOption = computed(() => ratioOptions.find((option) => option.value === form.aspectRatio))
const episodeOptions = [1, 3, 6, 10, 12]
const skillOptions = [
  { label: '故事设定', note: '整理世界、人物与核心冲突' },
  { label: '人物小传', note: '从角色欲望开始搭建关系' },
  { label: '分集大纲', note: '规划每集推进与结尾钩子' },
  { label: '剧本正文', note: '进入场景、动作与对白' },
]
function readEpisodeCount(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? parsed : null
}
const activeMenu = ref<'skill' | 'topic' | 'style' | 'ratio' | 'episodes' | null>(null)
const menuPlacement = ref<'up' | 'down'>('down')
const mentionOpen = ref(false)
const uploadMenuOpen = ref(false)
const canSubmit = computed(() => Boolean(projectId.value && form.idea.trim() && !saving.value && !connectionFailed.value))

function openFilePicker(): void {
  closeMenus()
  const input = document.getElementById('script-source-file')
  input?.click()
}

async function load(): Promise<void> {
  if (!projectId.value) {
    error.value = '缺少项目上下文，请从工作台进入。'
    loading.value = false
    return
  }
  try {
    project.value = await getProject(projectId.value)
    form.category = project.value.category || form.category
    form.aspectRatio = project.value.aspectRatio || form.aspectRatio
    form.visualStyle = project.value.visualStyle || form.visualStyle
    form.idea = project.value.narrativeVision || ''
    const requestedEpisodeCount = readEpisodeCount(route.query.episodeCount)
    if (requestedEpisodeCount) form.episodeCount = requestedEpisodeCount
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '创意页加载失败'
    connectionFailed.value = /连接|服务|后端|fetch|登录状态|重新登录/i.test(error.value)
  } finally {
    loading.value = false
  }
}

async function enterScript(): Promise<void> {
  if (saving.value || !projectId.value || !form.idea.trim()) {
    error.value = '请先写下你的故事创意。'
    return
  }
  saving.value = true
  error.value = ''
  connectionFailed.value = false
  try {
    await updateProject(projectId.value, {
      category: form.category,
      aspectRatio: form.aspectRatio,
      visualStyle: form.visualStyle,
      narrativeVision: form.idea.trim(),
    })
    await router.push({
      path: '/workspace/studio/script',
      query: {
        projectId: String(projectId.value),
        episodeCount: String(form.episodeCount),
      },
    })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存创作参数失败'
    connectionFailed.value = /连接|服务|后端|fetch|登录状态|重新登录/i.test(error.value)
  } finally {
    saving.value = false
  }
}

const menuHeightEstimate: Record<Exclude<typeof activeMenu.value, null>, number> = {
  skill: 360,
  topic: 500,
  style: 500,
  ratio: 430,
  episodes: 410,
}

async function updateMenuPlacement(menu: Exclude<typeof activeMenu.value, null>): Promise<void> {
  await nextTick()
  const trigger = composerRoot.value?.querySelector<HTMLElement>(`[data-menu-trigger="${menu}"]`)
  const panel = composerRoot.value?.querySelector<HTMLElement>('.composer-menu')
  if (!trigger) return
  const triggerRect = trigger.getBoundingClientRect()
  const panelHeight = panel?.getBoundingClientRect().height || menuHeightEstimate[menu]
  const bottomSpace = window.innerHeight - triggerRect.bottom
  const topSpace = triggerRect.top
  menuPlacement.value = bottomSpace < panelHeight + 24 && topSpace > bottomSpace ? 'up' : 'down'
}

function toggleMenu(menu: typeof activeMenu.value): void {
  activeMenu.value = activeMenu.value === menu ? null : menu
  mentionOpen.value = false
  uploadMenuOpen.value = false
  if (activeMenu.value) void updateMenuPlacement(activeMenu.value)
}

function selectMenu(menu: typeof activeMenu.value, value: string): void {
  if (menu === 'skill') {
    if (!form.idea.trim()) form.idea = `${value}：`
  } else if (menu === 'topic') {
    form.category = value
  } else if (menu === 'style') {
    form.visualStyle = value
  } else if (menu === 'ratio') {
    form.aspectRatio = value
  } else if (menu === 'episodes') {
    form.episodeCount = Number(value)
  }
  activeMenu.value = null
}

function isMenuSelected(menu: typeof activeMenu.value, value: string): boolean {
  if (menu === 'topic') return form.category === value
  if (menu === 'style') return form.visualStyle === value
  if (menu === 'ratio') return form.aspectRatio === value
  if (menu === 'episodes') return form.episodeCount === Number(value)
  return false
}

function insertMention(): void {
  mentionOpen.value = !mentionOpen.value
  activeMenu.value = null
  uploadMenuOpen.value = false
}

function toggleUploadMenu(): void {
  uploadMenuOpen.value = !uploadMenuOpen.value
  activeMenu.value = null
  mentionOpen.value = false
}

function closeMenus(): void {
  activeMenu.value = null
  mentionOpen.value = false
  uploadMenuOpen.value = false
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target
  if (target instanceof Node && composerRoot.value?.contains(target)) return
  closeMenus()
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenus()
}

function selectUploadSource(source: 'local' | 'asset'): void {
  uploadMenuOpen.value = false
  if (source === 'local') openFilePicker()
  if (source === 'asset') {
    void router.push({ path: '/workspace/assets', query: { projectId: String(projectId.value) } })
  }
}

function onSourceFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  sourceFile.value = input.files?.[0] || null
  sourceFileName.value = sourceFile.value?.name || ''
  if (sourceFile.value && !form.idea.trim()) {
    void sourceFile.value.text().then((text) => {
      form.idea = text.slice(0, 4000)
    }).catch(() => {
      error.value = '文件读取失败，请直接粘贴剧本内容。'
    })
  }
}

onMounted(() => {
  window.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('keydown', onDocumentKeydown)
  void load()
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('keydown', onDocumentKeydown)
})
</script>

<template>
  <WorkspaceLayout :show-side="false" :show-inspector="false" :no-padding="true">
    <div ref="composerRoot" class="idea-page min-h-full overflow-y-auto">
      <header class="idea-topbar border-b border-outline-variant">
        <button class="icon-button" type="button" aria-label="返回工作台" title="返回工作台" @click="router.push({ path: '/workspace/studio', query: { projectId: String(projectId) } })">
          <span class="material-symbols-outlined">arrow_back</span>
        </button>
        <div class="idea-brand" aria-label="帧心帧意">
          <span class="material-symbols-outlined text-primary">movie_edit</span>
          <span>帧心帧意</span>
        </div>
        <nav class="idea-flow" aria-label="创作阶段">
          <button type="button" class="idea-flow-link" aria-label="上传剧本、图片或视频" title="上传剧本、图片或视频" @click="openFilePicker">
            <span class="material-symbols-outlined">upload_file</span>上传素材
          </button>
          <span class="idea-flow-divider" aria-hidden="true"></span>
          <span class="idea-flow-link is-active" aria-current="page">
            <span class="material-symbols-outlined">edit_document</span>剧本创作
          </span>
          <span class="idea-flow-divider" aria-hidden="true"></span>
          <button type="button" class="idea-flow-link" @click="router.push({ path: '/workspace/assets/canvas', query: { projectId: String(projectId) } })">
            <span class="material-symbols-outlined">account_tree</span>创建画布
          </button>
        </nav>
        <div class="idea-project">{{ project?.name || '创作项目' }}</div>
      </header>

      <main v-if="!loading" class="idea-composer-stage">
        <form class="idea-composer" @submit.prevent="enterScript">
          <div class="idea-composer-body">
            <input
              id="script-source-file"
              class="sr-only"
              type="file"
              accept=".txt,.md,.rtf,.doc,.docx,.png,.jpg,.jpeg,.mp4,text/plain,text/markdown,image/*,video/*"
              @change="onSourceFileChange"
            />
            <label class="composer-upload" for="script-source-file">
              <span class="composer-upload-plus">+</span>
              <strong>{{ sourceFileName || '上传剧本/图/视频' }}</strong>
              <small>格式要求 <span class="material-symbols-outlined">info</span></small>
            </label>
            <textarea
              id="idea"
              v-model="form.idea"
              class="composer-textarea"
              maxlength="12000"
              aria-label="故事梗概或剧本正文"
              placeholder="上传素材或描述故事想法，AI 将拆解人物、结构与情节"
            ></textarea>
          </div>

          <div class="composer-toolbar">
            <div class="composer-action-wrap">
              <button type="button" class="composer-tool-icon" aria-label="添加素材" title="添加素材" :aria-expanded="uploadMenuOpen" @click="toggleUploadMenu">
                <span class="material-symbols-outlined">add</span>
              </button>
              <div v-if="uploadMenuOpen" class="composer-menu composer-menu--upload" role="menu">
                <div class="composer-menu-head"><span>添加创作素材</span><small>把已有内容带进当前故事上下文</small></div>
                <button type="button" class="composer-compact-option" role="menuitem" @click="selectUploadSource('local')">
                  <span class="option-glyph material-symbols-outlined">upload_file</span>
                  <span><strong>本地上传</strong><small>剧本、图片或视频</small></span>
                  <span class="material-symbols-outlined option-arrow">north_east</span>
                </button>
                <button type="button" class="composer-compact-option" role="menuitem" @click="selectUploadSource('asset')">
                  <span class="option-glyph material-symbols-outlined">inventory_2</span>
                  <span><strong>项目资产库</strong><small>调用已有角色与场景</small></span>
                  <span class="material-symbols-outlined option-arrow">north_east</span>
                </button>
                <div class="composer-upload-note">单个文件不超过 200MB · 支持文本、图片与视频</div>
              </div>
            </div>
            <div class="composer-action-wrap">
              <button type="button" class="composer-tool-icon composer-mention-trigger" aria-label="提及项目资产" title="提及项目资产" :aria-expanded="mentionOpen" @click="insertMention">@</button>
              <div v-if="mentionOpen" class="composer-menu composer-menu--mention" role="menu">
                <div class="composer-menu-head"><span>调用项目资产</span><small>选择后会插入到故事上下文</small></div>
                <button type="button" class="composer-compact-option" role="menuitem" @click="form.idea += '@角色 '; mentionOpen = false">
                  <span class="option-glyph material-symbols-outlined">person</span>
                  <span><strong>角色</strong><small>主角、配角与关系</small></span>
                  <span class="material-symbols-outlined option-arrow">chevron_right</span>
                </button>
                <button type="button" class="composer-compact-option" role="menuitem" @click="form.idea += '@场景 '; mentionOpen = false">
                  <span class="option-glyph material-symbols-outlined">landscape</span>
                  <span><strong>场景</strong><small>地点、时代与空间规则</small></span>
                  <span class="material-symbols-outlined option-arrow">chevron_right</span>
                </button>
                <button type="button" class="composer-compact-option" role="menuitem" @click="form.idea += '@道具 '; mentionOpen = false">
                  <span class="option-glyph material-symbols-outlined">category</span>
                  <span><strong>道具</strong><small>关键物件与剧情线索</small></span>
                  <span class="material-symbols-outlined option-arrow">chevron_right</span>
                </button>
              </div>
            </div>

            <div class="composer-menu-wrap">
              <button type="button" class="composer-pill" data-menu-trigger="skill" :aria-expanded="activeMenu === 'skill'" @click="toggleMenu('skill')">
                <span class="material-symbols-outlined">auto_awesome</span>技能<span class="material-symbols-outlined composer-chevron" :class="{ 'is-open': activeMenu === 'skill' }">expand_more</span>
              </button>
              <div v-if="activeMenu === 'skill'" class="composer-menu composer-menu--director" :class="{ 'is-open-up': menuPlacement === 'up' }">
                <div class="composer-menu-head"><span>导演台工具</span><small>选择后会写入当前创作上下文</small></div>
                <button v-for="option in skillOptions" :key="option.label" type="button" class="composer-option" @click="selectMenu('skill', option.label)">
                  <span class="option-glyph material-symbols-outlined">{{ option.label === '剧本正文' ? 'edit_note' : option.label === '人物小传' ? 'person' : option.label === '分集大纲' ? 'view_timeline' : 'auto_stories' }}</span>
                  <span><strong>{{ option.label }}</strong><small>{{ option.note }}</small></span>
                  <span class="option-arrow material-symbols-outlined">north_east</span>
                </button>
                <div class="composer-menu-foot"><span class="status-dot"></span>输出可在下一阶段继续手动修改</div>
              </div>
            </div>

            <div class="composer-menu-wrap">
              <button type="button" class="composer-pill composer-topic-pill" data-menu-trigger="topic" :aria-label="`选题：${selectedTopicOption?.label || '未选择'}`" :aria-expanded="activeMenu === 'topic'" @click="toggleMenu('topic')">
                <span>{{ selectedTopicOption?.label || '选题' }}</span><span class="material-symbols-outlined composer-chevron" :class="{ 'is-open': activeMenu === 'topic' }">expand_more</span>
              </button>
              <div v-if="activeMenu === 'topic'" class="composer-menu composer-menu--topic" :class="{ 'is-open-up': menuPlacement === 'up' }">
                <div class="topic-picker-head">
                  <div class="composer-menu-head"><span>选题方向</span><small>先定故事的冲突语境，再交给 AI 继续拆解</small></div>
                  <label class="topic-search">
                    <span class="material-symbols-outlined" aria-hidden="true">search</span>
                    <input v-model="topicSearch" type="search" placeholder="搜索选题" aria-label="搜索选题" />
                  </label>
                </div>
                <div class="topic-picker">
                  <nav class="topic-groups" aria-label="选题维度">
                    <button v-for="group in topicGroups" :key="group" type="button" :class="{ active: activeTopicGroup === group }" @click="activeTopicGroup = group">
                      <span class="topic-group-dot"></span>{{ group }}
                    </button>
                  </nav>
                  <div class="topic-options">
                    <div v-if="!filteredTopicOptions.length" class="topic-empty">没有找到匹配的选题</div>
                    <button v-for="option in filteredTopicOptions" :key="option.value" type="button" class="topic-option" :class="{ selected: isMenuSelected('topic', option.value || '') }" @click="selectMenu('topic', option.value || '')">
                      <span class="option-glyph topic-glyph">{{ option.label.slice(0, 1) }}</span>
                      <span><strong>{{ option.label }}</strong><small>{{ option.note }}</small></span>
                      <span class="option-check material-symbols-outlined">{{ isMenuSelected('topic', option.value || '') ? 'check' : 'arrow_forward' }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div class="composer-menu-wrap">
              <button type="button" class="composer-pill" data-menu-trigger="style" :aria-label="`风格：${selectedStyleOption?.label || '未选择'}`" :aria-expanded="activeMenu === 'style'" @click="toggleMenu('style')">
                <img v-if="selectedStyleOption" class="composer-pill-swatch" :src="selectedStyleOption.image" :alt="`${selectedStyleOption.label} 风格`" />
                <span>风格</span><span class="material-symbols-outlined composer-chevron" :class="{ 'is-open': activeMenu === 'style' }">expand_more</span>
              </button>
              <div v-if="activeMenu === 'style'" class="composer-menu composer-menu--director" :class="{ 'is-open-up': menuPlacement === 'up' }">
                <div class="composer-menu-head"><span>画面气质</span><small>会同步到后续静帧与视频提示词</small></div>
                <div class="style-picker">
                  <nav class="style-groups" aria-label="风格分类">
                    <button v-for="group in styleGroups" :key="group" type="button" :class="{ active: activeStyleGroup === group }" @click="activeStyleGroup = group">
                      <span class="style-group-dot"></span>{{ group }}
                    </button>
                  </nav>
                  <div class="style-grid">
                    <template v-if="filteredStyleOptions.length">
                      <button v-for="option in filteredStyleOptions" :key="option.value" type="button" class="style-card" :class="{ selected: isMenuSelected('style', option.value || '') }" @click="selectMenu('style', option.value || '')">
                        <img class="style-card-preview" :src="option.image" :alt="`${option.label} 风格参考图`" loading="lazy" />
                        <span class="style-card-copy"><strong>{{ option.label }}</strong><small>{{ option.note }}</small></span>
                        <span v-if="isMenuSelected('style', option.value || '')" class="style-card-check material-symbols-outlined">check</span>
                      </button>
                    </template>
                    <div v-else class="style-empty">暂无可用风格</div>
                  </div>
                </div>
              </div>
            </div>

            <div class="composer-menu-wrap">
              <button type="button" class="composer-pill" data-menu-trigger="ratio" :aria-label="`比例：${selectedRatioOption?.value || '未选择'}`" :aria-expanded="activeMenu === 'ratio'" @click="toggleMenu('ratio')">
                <span>{{ selectedRatioOption?.value || '比例' }}</span><span class="material-symbols-outlined composer-chevron" :class="{ 'is-open': activeMenu === 'ratio' }">expand_more</span>
              </button>
              <div v-if="activeMenu === 'ratio'" class="composer-menu composer-menu--director composer-menu--ratio" :class="{ 'is-open-up': menuPlacement === 'up' }">
                <div class="composer-menu-head"><span>画幅比例</span><small>决定后续镜头构图</small></div>
                <button v-for="option in ratioOptions" :key="option.value" type="button" class="ratio-option" :class="{ selected: isMenuSelected('ratio', option.value) }" @click="selectMenu('ratio', option.value)">
                  <span class="ratio-preview" :class="option.className"></span>
                  <span><strong>{{ option.value }}</strong><small>{{ option.label }} · {{ option.note }}</small></span>
                  <span class="option-check material-symbols-outlined">{{ isMenuSelected('ratio', option.value) ? 'check' : 'arrow_forward' }}</span>
                </button>
              </div>
            </div>

            <div class="composer-menu-wrap">
              <button type="button" class="composer-pill composer-model" data-menu-trigger="episodes" :aria-expanded="activeMenu === 'episodes'" @click="toggleMenu('episodes')">
                <span class="material-symbols-outlined">model_training</span>ScriptBird · 国内剧本 · {{ form.episodeCount }} 集<span class="material-symbols-outlined composer-chevron" :class="{ 'is-open': activeMenu === 'episodes' }">expand_more</span>
              </button>
              <div v-if="activeMenu === 'episodes'" class="composer-menu composer-menu--director composer-menu--episodes composer-menu--down" :class="{ 'is-open-up': menuPlacement === 'up' }">
                <div class="composer-menu-head"><span>连载体量</span><small>先给故事留出呼吸和转折</small></div>
                <div class="episode-scale">
                  <span v-for="option in episodeOptions" :key="option" class="episode-tick" :class="{ selected: isMenuSelected('episodes', String(option)) }">
                    <button type="button" @click="selectMenu('episodes', String(option))">{{ option }}</button>
                    <i></i>
                  </span>
                </div>
                <label class="episode-custom">
                  <span>自定义集数</span>
                  <input v-model.number="form.episodeCount" type="number" min="1" max="50" step="1" inputmode="numeric" aria-label="自定义集数" />
                  <small>1–50 集</small>
                </label>
                <div class="episode-summary"><span>当前方案</span><strong>{{ form.episodeCount }} 集连载</strong><small>每集都会保留可编辑的中间结果</small></div>
              </div>
            </div>

            <span class="composer-fill"></span>
            <span class="composer-count">{{ form.idea.length }}/12000 字</span>
            <button class="composer-submit" type="submit" aria-label="进入剧本生成" title="进入剧本生成" :disabled="!canSubmit">
              <span class="material-symbols-outlined">{{ saving ? 'progress_activity' : 'arrow_upward' }}</span>
            </button>
          </div>
          <p v-if="mentionOpen" class="composer-hint" role="status">@ 可调用角色、场景、道具和后续工具。</p>
          <p v-if="error" class="composer-error" role="alert">{{ error }}</p>
        </form>
      </main>
      <div v-else class="page-loading">正在读取项目创作设置…</div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.idea-page { min-height: 100%; background: #151615; color: #f4eee5; }
.idea-topbar { display:flex; align-items:center; gap:.9rem; min-height:4.25rem; padding:0 2rem; border-bottom:1px solid rgba(173,149,120,.16); background:#111211; }
.icon-button { display:grid; place-items:center; width:2.2rem; height:2.2rem; color:#aba49b; transition:color .18s ease,transform .18s ease; }
.icon-button:hover { color:#ffb77d; transform:translateX(-2px); }
.idea-brand { display:flex; align-items:center; gap:.55rem; min-width:max-content; font-size:.92rem; font-weight:650; letter-spacing:.01em; }
.idea-brand .material-symbols-outlined { color:#ffb77d; }
.idea-flow { display:flex; align-items:center; gap:.35rem; margin:0 auto; padding:.22rem; border:1px solid rgba(198,185,164,.09); border-radius:.85rem; background:#191a19; }
.idea-flow-link { display:inline-flex; min-height:2.05rem; align-items:center; gap:.4rem; padding:0 .75rem; border-radius:.64rem; color:#85827b; font-size:.73rem; white-space:nowrap; transition:background-color .2s ease,color .2s ease,transform .2s ease; }
.idea-flow-link .material-symbols-outlined { font-size:.95rem; }
.idea-flow-link:hover { color:#ede6da; transform:translateY(-1px); }
.idea-flow-link.is-active { background:#343532; color:#f5eee3; box-shadow:inset 0 0 0 1px rgba(255,183,125,.1); }
.idea-flow-divider { width:1px; height:1rem; background:rgba(198,185,164,.14); }
.idea-project { margin-left:auto; color:#837f78; font-size:.75rem; }
.idea-flow-link:focus-visible,.icon-button:focus-visible,.composer-tool-icon:focus-visible,.composer-pill:focus-visible,.composer-option:focus-visible,.composer-compact-option:focus-visible,.ratio-option:focus-visible,.style-groups button:focus-visible,.style-card:focus-visible,.episode-tick button:focus-visible,.topic-groups button:focus-visible,.topic-option:focus-visible,.topic-search input:focus-visible,.composer-submit:focus-visible { outline:2px solid #ffb77d; outline-offset:2px; }
.idea-composer-stage { display:grid; min-height:calc(100dvh - 4.25rem); place-items:start center; padding:clamp(2rem,5vh,4.5rem) clamp(1rem,7vw,7rem) 5rem; }
.idea-composer { width:min(100%,72rem); animation:composer-rise .5s cubic-bezier(.16,1,.3,1) both; }
.idea-composer-body { display:grid; grid-template-columns:15.5rem minmax(0,1fr); gap:2.1rem; min-height:18rem; padding:1.5rem; border:1px solid rgba(117,113,105,.2); border-bottom:0; border-radius:1.35rem 1.35rem 0 0; background:#1d1e1d; }
.composer-upload { display:flex; min-height:12.5rem; flex-direction:column; align-items:center; justify-content:center; gap:.55rem; border:1px dashed #514e49; border-radius:1.2rem; background:#282928; color:#aaa59d; cursor:pointer; text-align:center; transition:border-color .22s ease,background-color .22s ease,transform .22s ease; }
.composer-upload:hover { border-color:#ffb77d; background:#302d29; transform:translateY(-2px); }
.composer-upload strong { max-width:10rem; color:#f4eee5; font-size:.82rem; }
.composer-upload small { display:inline-flex; align-items:center; gap:.25rem; font-size:.72rem; }
.composer-upload small .material-symbols-outlined { font-size:.9rem; }
.composer-upload-plus { display:grid; width:2rem; height:2rem; place-items:center; border:1px solid #5c5a56; border-radius:50%; color:#d1cbc2; font-size:1.45rem; font-weight:300; }
.composer-textarea { width:100%; min-height:15rem; resize:vertical; border:0; outline:0; background:transparent; color:#ebe5dc; font-size:1.05rem; line-height:1.8; }
.composer-textarea::placeholder { color:#6c6c68; }
.composer-toolbar { display:flex; min-height:3.85rem; align-items:center; gap:.2rem; padding:.45rem .65rem; border-radius:0 0 1.35rem 1.35rem; background:#242524; }
.composer-action-wrap { position:relative; }
.composer-tool-icon { display:grid; width:2.3rem; height:2.55rem; place-items:center; border-radius:.7rem; color:#aba49b; font-size:1.25rem; transition:color .18s ease,background-color .18s ease; }
.composer-tool-icon:hover,.composer-tool-icon[aria-pressed='true'] { background:#343532; color:#fff; }
.composer-tool-icon[aria-expanded='true'] { background:#343532; color:#fff; }
.composer-mention-trigger { font-family:Georgia,'Times New Roman',serif; font-size:1.08rem; }
.composer-menu-wrap { position:relative; display:inline-flex; align-items:center; }
.composer-pill { display:inline-flex; min-height:2.55rem; align-items:center; gap:.4rem; padding:0 .75rem; border-radius:.8rem; color:#d0cbc2; font-size:.82rem; line-height:1; white-space:nowrap; transition:background-color .18s ease,color .18s ease; }
.composer-pill:hover,.composer-pill[aria-expanded='true'] { background:#343532; color:#fff; }
.composer-pill .material-symbols-outlined { display:inline-flex; width:1rem; height:1rem; align-items:center; justify-content:center; flex:none; font-size:1rem; line-height:1; }
.composer-pill-swatch { display:block; width:1.05rem; height:1.05rem; flex:none; border:1px solid rgba(245,238,227,.38); border-radius:.28rem; object-fit:cover; box-shadow:inset 0 0 0 1px rgba(20,22,20,.3); }
.composer-chevron { transform-origin:center; transition:transform .2s cubic-bezier(.16,1,.3,1); }
.composer-chevron.is-open { transform: rotate(180deg); }
.composer-model { max-width:16rem; overflow:hidden; text-overflow:ellipsis; }
.composer-menu { position:absolute; top:calc(100% + .75rem); bottom:auto; left:0; z-index:5; display:grid; width:min(21rem,calc(100vw - 2rem)); max-height:min(26rem,calc(100dvh - 3rem)); overflow-y:auto; padding:.65rem; border:1px solid #4a4943; border-radius:1rem; background:#222321; box-shadow:0 1.1rem 2.6rem rgba(0,0,0,.42); animation:menu-pop-down .2s cubic-bezier(.16,1,.3,1) both; transform-origin:top left; overscroll-behavior:contain; scrollbar-color:#5a584f transparent; scrollbar-width:thin; }
.composer-menu.is-open-up { top:auto; bottom:calc(100% + .75rem); animation-name:menu-pop-up; transform-origin:bottom left; }
.composer-menu::before { position:absolute; top:-.32rem; right:auto; bottom:auto; left:1.2rem; width:.58rem; height:.58rem; border-top:1px solid #4a4943; border-right:0; border-bottom:0; border-left:1px solid #4a4943; background:#222321; content:""; transform:rotate(45deg); }
.composer-menu.is-open-up::before { top:auto; bottom:-.32rem; border-top:0; border-right:1px solid #4a4943; border-bottom:1px solid #4a4943; border-left:0; transform:rotate(45deg); }
.composer-menu-head { display:grid; gap:.25rem; padding:.5rem .65rem .7rem; border-bottom:1px solid rgba(198,185,164,.1); }
.composer-menu-head > span { color:#f1eade; font-size:.79rem; font-weight:700; }
.composer-menu-head small,.composer-option small,.ratio-option small { color:#99958c; font-size:.68rem; line-height:1.45; }
.composer-option { display:grid; grid-template-columns:2.1rem minmax(0,1fr) 1.2rem; align-items:center; gap:.65rem; min-height:3.55rem; margin-top:.25rem; padding:.45rem .55rem; border:1px solid transparent; border-radius:.72rem; color:#d7d1c7; text-align:left; transition:background-color .18s ease,border-color .18s ease,transform .18s ease; }
.composer-option:hover { border-color:rgba(255,183,125,.18); background:#2d2d29; transform:translateX(2px); }
.composer-option > span:nth-child(2),.ratio-option > span:nth-child(2) { display:grid; gap:.18rem; min-width:0; }
.composer-option strong,.ratio-option strong { color:#e7e0d6; font-size:.76rem; font-weight:650; }
.option-glyph { display:grid; width:1.9rem; height:1.9rem; place-items:center; border:1px solid #494740; border-radius:.58rem; color:#ffbd8b; font-size:1rem; }
.topic-glyph { font-family:'Noto Serif SC',serif; font-size:.88rem; }
.option-arrow,.option-check { color:#77766f; font-size:.95rem; }
.composer-option.selected { border-color:rgba(255,183,125,.26); background:rgba(255,183,125,.075); }
.composer-option.selected .option-check { color:#ffb77d; }
.composer-topic-pill { max-width:9rem; overflow:hidden; }
.composer-topic-pill > span:first-child { overflow:hidden; text-overflow:ellipsis; }
.composer-menu--topic { width:min(34rem,calc(100vw - 2rem)); max-height:min(29rem,calc(100dvh - 9rem)); overflow:hidden; padding:.7rem; }
.topic-picker-head { display:grid; grid-template-columns:minmax(0,1fr) 11rem; align-items:end; gap:.7rem; padding-bottom:.65rem; border-bottom:1px solid rgba(198,185,164,.1); }
.topic-picker-head .composer-menu-head { min-width:0; padding:.35rem .35rem 0; border-bottom:0; }
.topic-search { display:flex; min-height:2.15rem; align-items:center; gap:.4rem; padding:0 .6rem; border:1px solid #454640; border-radius:.65rem; background:#292a28; color:#99958c; transition:border-color .18s ease,background-color .18s ease; }
.topic-search:focus-within { border-color:rgba(255,183,125,.65); background:#302f2b; }
.topic-search .material-symbols-outlined { flex:none; font-size:1rem; }
.topic-search input { width:100%; min-width:0; border:0; outline:0; background:transparent; color:#e7e0d6; font-size:.72rem; }
.topic-search input::placeholder { color:#77766f; }
.topic-picker { display:grid; grid-template-columns:7.2rem minmax(0,1fr); gap:.75rem; min-height:15rem; padding-top:.65rem; }
.topic-groups { display:flex; flex-direction:column; gap:.18rem; padding-right:.65rem; border-right:1px solid rgba(198,185,164,.1); }
.topic-groups button { display:flex; min-height:2.1rem; align-items:center; gap:.45rem; border-radius:.55rem; color:#918d85; font-size:.69rem; text-align:left; transition:color .16s ease,background-color .16s ease,transform .16s ease; }
.topic-groups button:hover,.topic-groups button.active { background:#2c2d2a; color:#f1eade; transform:translateX(1px); }
.topic-group-dot { width:.32rem; height:.32rem; flex:none; border-radius:50%; background:#5e5e58; }
.topic-groups button.active .topic-group-dot { background:#ffb77d; box-shadow:0 0 0 .2rem rgba(255,183,125,.1); }
.topic-options { display:grid; align-content:start; gap:.4rem; min-width:0; max-height:21rem; overflow-y:auto; padding-right:.1rem; scrollbar-color:#5a584f transparent; scrollbar-width:thin; }
.topic-option { display:grid; grid-template-columns:2.1rem minmax(0,1fr) 1.2rem; align-items:center; gap:.65rem; min-height:3.5rem; padding:.45rem .55rem; border:1px solid transparent; border-radius:.72rem; color:#d7d1c7; text-align:left; transition:background-color .18s ease,border-color .18s ease,transform .18s ease; }
.topic-option:hover { border-color:rgba(255,183,125,.18); background:#2d2d29; transform:translateX(2px); }
.topic-option > span:nth-child(2) { display:grid; gap:.18rem; min-width:0; }
.topic-option strong { overflow:hidden; color:#e7e0d6; font-size:.76rem; font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
.topic-option small { color:#99958c; font-size:.68rem; line-height:1.45; }
.topic-option.selected { border-color:rgba(255,183,125,.26); background:rgba(255,183,125,.075); }
.topic-option.selected .option-check { color:#ffb77d; }
.topic-empty { display:grid; min-height:8rem; place-items:center; color:#8d8981; font-size:.74rem; }
.style-picker { display:grid; grid-template-columns:5rem minmax(0,1fr); gap:.65rem; min-height:15rem; padding-top:.65rem; }
.style-groups { display:flex; flex-direction:column; gap:.2rem; padding-right:.55rem; border-right:1px solid rgba(198,185,164,.1); }
.style-groups button { display:flex; min-height:2.2rem; align-items:center; gap:.45rem; border-radius:.55rem; color:#918d85; font-size:.7rem; text-align:left; transition:color .16s ease,background-color .16s ease; }
.style-groups button:hover,.style-groups button.active { background:#2c2d2a; color:#f1eade; }
.style-group-dot { width:.32rem; height:.32rem; border-radius:50%; background:#5e5e58; }
.style-groups button.active .style-group-dot { background:#ffb77d; box-shadow:0 0 0 .2rem rgba(255,183,125,.1); }
.style-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-content:start; gap:.45rem; max-height:min(22rem,calc(100dvh - 12rem)); overflow-y:auto; padding:.1rem .2rem .25rem 0; scrollbar-color:#5a584f transparent; scrollbar-width:thin; }
.style-card { position:relative; display:flex; min-width:0; flex-direction:column; overflow:hidden; border:1px solid #41413c; border-radius:.72rem; background:#292a28; color:#d7d1c7; text-align:left; transition:border-color .18s ease,background-color .18s ease,transform .18s ease; }
.style-card:hover { transform:translateY(-2px); border-color:#777167; }
.style-card.selected { border-color:#ffb77d; background:#302d28; }
.style-card-preview { display:block; width:100%; aspect-ratio:1.8; border:0; border-bottom:1px solid rgba(255,255,255,.08); background:#31322f; object-fit:cover; }
.style-card-copy { display:grid; gap:.2rem; min-height:3.15rem; padding:.48rem .52rem .55rem; }
.style-card-copy strong { overflow:hidden; color:#e7e0d6; font-size:.7rem; text-overflow:ellipsis; white-space:nowrap; }
.style-card-copy small { overflow:hidden; color:#99958c; font-size:.61rem; text-overflow:ellipsis; white-space:nowrap; }
.style-card-check { position:absolute; top:.38rem; right:.38rem; display:grid; width:1.25rem; height:1.25rem; place-items:center; border-radius:50%; background:#ffb77d; color:#21170f; font-size:.85rem; }
.style-empty { grid-column:1/-1; display:grid; min-height:8rem; place-items:center; color:#99958c; font-size:.72rem; }
.composer-menu--ratio { width:18rem; }
.composer-menu--upload,.composer-menu--mention { width:20rem; transform-origin:top left; }
.composer-menu--mention { left:-.3rem; width:19rem; }
.composer-compact-option { display:grid; grid-template-columns:2.1rem minmax(0,1fr) 1.2rem; align-items:center; gap:.65rem; width:100%; min-height:3.25rem; margin-top:.25rem; padding:.4rem .55rem; border:1px solid transparent; border-radius:.72rem; color:#d7d1c7; text-align:left; transition:background-color .18s ease,border-color .18s ease,transform .18s ease; }
.composer-compact-option:hover { border-color:rgba(255,183,125,.18); background:#2d2d29; transform:translateX(2px); }
.composer-compact-option > span:nth-child(2) { display:grid; gap:.18rem; min-width:0; }
.composer-compact-option strong { color:#e7e0d6; font-size:.76rem; font-weight:650; }
.composer-compact-option small { color:#99958c; font-size:.68rem; line-height:1.45; }
.composer-upload-note { margin:.55rem .35rem .2rem; padding-top:.55rem; border-top:1px solid rgba(198,185,164,.1); color:#77766f; font-size:.65rem; }
.ratio-option { display:grid; grid-template-columns:3.3rem minmax(0,1fr) 1.2rem; align-items:center; gap:.7rem; min-height:3.8rem; margin-top:.25rem; padding:.45rem .6rem; border:1px solid transparent; border-radius:.7rem; text-align:left; transition:background-color .18s ease,border-color .18s ease; }
.ratio-option:hover,.ratio-option.selected { border-color:rgba(255,183,125,.2); background:#2d2d29; }
.ratio-preview { justify-self:center; border:1px solid #9a8872; background:linear-gradient(145deg,rgba(255,183,125,.3),rgba(102,123,117,.2)); box-shadow:inset 0 0 0 3px rgba(20,22,20,.75); }
.ratio-portrait { width:1.05rem; height:1.85rem; }
.ratio-landscape { width:2.35rem; height:1.35rem; }
.ratio-cinema { width:2.7rem; height:1.15rem; }
.ratio-poster { width:1.35rem; height:1.8rem; }
.ratio-classic { width:2.1rem; height:1.6rem; }
.ratio-square { width:1.6rem; height:1.6rem; }
.composer-menu--episodes { width:19rem; }
.composer-menu--down {
  left: auto;
  right: 0;
  width: min(19rem, calc(100vw - 2rem));
  max-width: calc(100vw - 2rem);
  transform-origin: top right;
}
.composer-menu--down::before {
  top: -.32rem;
  right: 1.25rem;
  bottom: auto;
  left: auto;
  border-top: 1px solid #4a4943;
  border-right: 0;
  border-bottom: 0;
  border-left: 1px solid #4a4943;
}
.episode-scale { display:grid; grid-template-columns:repeat(5,1fr); gap:.35rem; padding:.8rem .55rem .65rem; }
.episode-tick { display:grid; justify-items:center; gap:.3rem; }
.episode-tick button { width:100%; min-height:1.9rem; border-radius:.55rem; color:#aaa69d; font-size:.72rem; transition:background-color .18s ease,color .18s ease; }
.episode-tick i { width:1px; height:.55rem; background:#55534d; }
.episode-tick.selected button,.episode-tick button:hover { background:#ffb77d; color:#21170f; font-weight:700; }
.episode-tick.selected i { background:#ffb77d; }
.episode-custom { display:grid; grid-template-columns:minmax(0,1fr) 5rem auto; align-items:center; gap:.45rem; margin:.1rem .45rem .55rem; padding:.55rem .65rem; border:1px solid rgba(198,185,164,.12); border-radius:.65rem; background:#272825; color:#aaa69d; font-size:.68rem; }
.episode-custom input { width:100%; min-height:1.9rem; padding:0 .5rem; border:1px solid #55534d; border-radius:.48rem; background:#1e201e; color:#f0e5d6; font:inherit; text-align:center; }
.episode-custom input:focus { border-color:#ffb77d; outline:2px solid rgba(255,183,125,.18); outline-offset:1px; }
.episode-custom small { color:#77766f; font-size:.62rem; white-space:nowrap; }
.episode-summary { display:grid; grid-template-columns:1fr auto; gap:.2rem .5rem; margin:.15rem .45rem .35rem; padding:.65rem .7rem; border-radius:.65rem; background:#2b2c29; }
.episode-summary > span { color:#97938a; font-size:.67rem; }
.episode-summary strong { color:#f0e5d6; font-size:.73rem; }
.episode-summary small { grid-column:1/-1; color:#89857d; font-size:.65rem; }
.composer-fill { flex:1; }
.composer-count { display:inline-flex; align-items:center; gap:.2rem; margin-right:.45rem; color:#918f88; font-size:.78rem; white-space:nowrap; }
.composer-count .material-symbols-outlined { font-size:1rem; }
.composer-submit { display:grid; width:2.5rem; height:2.5rem; place-items:center; border-radius:50%; background:#363835; color:#a19e96; transition:background-color .2s ease,color .2s ease,transform .2s ease; }
.composer-submit:not(:disabled) { background:#ffb77d; color:#271a10; }
.composer-submit:not(:disabled):hover { background:#ffc496; transform:translateY(-2px); }
.composer-submit:disabled { cursor:not-allowed; opacity:.7; }
.composer-hint,.composer-error { margin-top:.8rem; color:#aaa49b; font-size:.78rem; }
.composer-error { color:#ff9b8c; }
.page-loading { display:grid; min-height:70vh; place-items:center; color:#8c8982; }
@keyframes composer-rise { from { opacity:0; transform:translateY(1rem); } to { opacity:1; transform:translateY(0); } }
@keyframes menu-pop-down { from { opacity:0; transform:translateY(-.35rem) scale(.98); } to { opacity:1; transform:translateY(0) scale(1); } }
@keyframes menu-pop-up { from { opacity:0; transform:translateY(.35rem) scale(.98); } to { opacity:1; transform:translateY(0) scale(1); } }
@media (max-width:800px) { .idea-topbar{padding:0 1rem}.idea-brand{display:none}.idea-flow{margin:0 auto}.idea-flow-link{padding:0 .55rem}.idea-flow-link:not(.is-active) .material-symbols-outlined{display:none}.idea-project{display:none}.idea-composer-stage{padding:2rem 1rem 4rem}.idea-composer-body{grid-template-columns:1fr;gap:1rem;padding:1rem}.composer-upload{min-height:8rem}.composer-toolbar{flex-wrap:wrap;padding:.55rem}.composer-fill{display:none}.composer-count{margin-left:auto}.composer-model{max-width:12rem}.composer-menu{max-width:calc(100vw - 2rem)}.composer-menu--upload,.composer-menu--mention{left:0;width:min(20rem,calc(100vw - 2rem));max-width:calc(100vw - 2rem)}.composer-menu--topic{width:min(34rem,calc(100vw - 2rem));max-width:calc(100vw - 2rem)}.topic-picker-head{grid-template-columns:1fr}.topic-picker{grid-template-columns:6.4rem minmax(0,1fr)}.topic-options{max-height:16rem}.style-picker{grid-template-columns:1fr}.style-groups{flex-direction:row;overflow-x:auto;padding:0 0 .45rem;border-right:0;border-bottom:1px solid rgba(198,185,164,.1)}.style-groups button{min-width:max-content;padding:.25rem .45rem}.style-grid{max-height:18rem}.episode-custom{grid-template-columns:minmax(0,1fr) 4.5rem}.episode-custom small{grid-column:2}.composer-menu--down{right:0;left:auto;width:min(19rem,calc(100vw - 2rem));max-width:calc(100vw - 2rem)} }
@media (prefers-reduced-motion:reduce) { .idea-composer,.composer-menu,.composer-chevron{animation:none;transition:none} }
</style>
