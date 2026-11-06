<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  getModelSettings,
  updateModelSettings,
  type ModelSettingFieldDTO,
  type ModelSettingGroupDTO,
  type ModelSettingsDTO,
} from '@/api/project'

type PageState = 'loading' | 'ready' | 'error'

const pageState = ref<PageState>('loading')
const groups = ref<ModelSettingGroupDTO[]>([])
const fields = ref<ModelSettingFieldDTO[]>([])
const effective = ref<ModelSettingsDTO['effective'] | null>(null)
const activeGroup = ref('text')
const draft = ref<Record<string, string>>({})
const saving = ref(false)
const errorMsg = ref('')
const infoMsg = ref('')

const activeGroupMeta = computed(
  () => groups.value.find((item) => item.key === activeGroup.value) || groups.value[0] || null,
)
const activeFields = computed(() => fields.value.filter((item) => item.group === activeGroup.value))
const changedCount = computed(() =>
  fields.value.filter((field) => {
    if (field.type === 'secret') return Boolean(draft.value[field.key]?.trim())
    return String(draft.value[field.key] ?? '') !== String(field.value ?? '')
  }).length,
)

// 设置页把后端返回的字段分组展示，但 draft 是页面本地编辑副本。
// 用户点击保存前不会立即改动后端环境变量或数据库。
function groupSummary(groupKey: string): string {
  if (!effective.value) return '-'
  if (groupKey === 'text') return `${providerLabel(effective.value.text.provider)} / ${effective.value.text.defaultModel}`
  if (groupKey === 'frame') return `${providerLabel(effective.value.frame.provider)} / ${effective.value.frame.defaultModel}`
  if (groupKey === 'video') return `${providerLabel(effective.value.video.provider)} / ${effective.value.video.defaultModel}`
  if (groupKey === 'audio') return `${providerLabel(effective.value.audio.provider)} / ${effective.value.audio.defaultModel}`
  return '-'
}

function groupKeyLabel(groupKey?: string): string {
  if (groupKey === 'text') return '文本模型'
  if (groupKey === 'frame') return '图片模型'
  if (groupKey === 'video') return '视频模型'
  if (groupKey === 'audio') return '音频模型'
  return '模型设置'
}

function resetDraft(payload: ModelSettingsDTO): void {
  // 用后端最新配置重建页面状态，同时清空旧草稿差异。
  groups.value = payload.groups
  fields.value = payload.fields
  effective.value = payload.effective
  activeGroup.value = activeGroup.value || payload.groups[0]?.key || 'text'
  draft.value = Object.fromEntries(payload.fields.map((field) => [field.key, field.value || '']))
}

async function loadSettings(): Promise<void> {
  // 读取模型设置和当前生效配置。
  pageState.value = 'loading'
  errorMsg.value = ''
  try {
    resetDraft(await getModelSettings())
    pageState.value = 'ready'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '模型设置加载失败'
    pageState.value = 'error'
  }
}

async function saveSettings(): Promise<void> {
  // 把每个表单字段转换成后端需要的 key/value 数组。
  // secret 类型允许留空，后端会保留原有密钥，避免误覆盖。
  if (saving.value) return
  saving.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const payload = fields.value.map((field) => ({
      key: field.key,
      value: field.type === 'boolean' ? draft.value[field.key] === 'true' : draft.value[field.key] || '',
    }))
    resetDraft(await updateModelSettings(payload))
    infoMsg.value = '模型设置已保存，后续生成会使用新配置'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '模型设置保存失败'
  } finally {
    saving.value = false
  }
}

function sourceLabel(field: ModelSettingFieldDTO): string {
  if (field.type === 'secret') return field.secretConfigured ? '已配置密钥' : '未配置密钥'
  return field.persisted ? '设置中心' : '环境默认'
}

function fieldHint(field: ModelSettingFieldDTO): string {
  if (field.type === 'secret') return '留空会保留当前密钥'
  if (field.key.includes('FALLBACK')) return '多个备用模型用英文逗号分隔'
  if (field.key.endsWith('_BASE_URL')) return '接口地址末尾不需要斜杠'
  return '保存后对后续生成生效'
}

function setBooleanDraft(key: string, event: Event): void {
  draft.value[key] = (event.target as HTMLInputElement | null)?.checked ? 'true' : 'false'
}

function providerLabel(value?: string): string {
  const labels: Record<string, string> = {
    'openai-compatible': '兼容 OpenAI 接口',
    mock: '模拟服务',
    volcengine: '豆包 Seedream（火山方舟）',
    bigmodel: '智谱大模型',
    zhipu: '智谱大模型',
    minimax: 'MiniMax 服务',
    toapi: 'ToAPI 服务',
    agnes: 'Agnes 服务',
    'trae-url': 'Trae 图片服务',
    dashscope: 'DashScope 服务',
    seedance: 'Seedance 服务',
  }
  return labels[String(value || '').trim()] || String(value || '-')
}

onMounted(() => {
  void loadSettings()
})
</script>

<template>
  <WorkspaceLayout :show-side="false" :show-inspector="false" :no-padding="true">
    <main class="settings-page">
      <section v-if="pageState === 'loading'" class="state-block">正在读取模型设置...</section>

      <section v-else-if="pageState === 'error'" class="state-block">
        <h1>模型设置加载失败</h1>
        <p>{{ errorMsg }}</p>
        <button class="primary-btn" type="button" @click="loadSettings">重新加载</button>
      </section>

      <section v-else class="settings-shell">
        <header class="page-head">
          <div>
            <p class="eyebrow">模型控制</p>
            <h1>模型设置</h1>
            <p>集中切换文本、图片、视频和音频模型。保存后对后续生成立即生效。</p>
          </div>
          <div class="head-actions">
            <span class="change-pill">{{ changedCount }} 项待保存</span>
            <button class="ghost-btn" type="button" @click="loadSettings">重新读取</button>
            <button class="primary-btn" type="button" :disabled="saving" @click="saveSettings">
              {{ saving ? '保存中...' : '保存设置' }}
            </button>
          </div>
        </header>

        <div v-if="errorMsg" class="message error">{{ errorMsg }}</div>
        <div v-if="infoMsg" class="message success">{{ infoMsg }}</div>

        <div class="summary-grid">
          <article class="summary-item">
            <span>文本</span>
            <strong>{{ effective?.text.defaultModel || '-' }}</strong>
            <small>{{ providerLabel(effective?.text.provider) }}</small>
          </article>
          <article class="summary-item">
            <span>图片</span>
            <strong>{{ effective?.frame.defaultModel || '-' }}</strong>
            <small>{{ effective?.frame.imageRatio || '-' }} / {{ providerLabel(effective?.frame.provider) }}</small>
          </article>
          <article class="summary-item">
            <span>视频</span>
            <strong>{{ effective?.video.defaultModel || '-' }}</strong>
            <small>口型 {{ effective?.video.lipSyncModel || '-' }}</small>
          </article>
          <article class="summary-item">
            <span>音频</span>
            <strong>{{ effective?.audio.defaultModel || '-' }}</strong>
            <small>{{ effective?.audio.defaultVoice || '-' }}</small>
          </article>
        </div>

        <div class="settings-grid">
          <aside class="group-nav">
            <button
              v-for="group in groups"
              :key="group.key"
              class="group-button"
              :class="{ active: group.key === activeGroup }"
              type="button"
              @click="activeGroup = group.key"
            >
              <span class="material-symbols-outlined">
                {{
                  group.key === 'text'
                    ? 'article'
                    : group.key === 'frame'
                      ? 'image'
                      : group.key === 'video'
                        ? 'movie'
                        : 'graphic_eq'
                }}
              </span>
              <span>
                <strong>{{ group.label }}</strong>
                <small>{{ groupSummary(group.key) }}</small>
              </span>
            </button>
          </aside>

          <section class="settings-panel">
            <div class="panel-head">
              <div>
                <p class="eyebrow">{{ groupKeyLabel(activeGroupMeta?.key) }}</p>
                <h2>{{ activeGroupMeta?.label }}</h2>
              </div>
              <span>{{ activeFields.length }} 项</span>
            </div>

            <div class="field-grid">
              <div v-for="field in activeFields" :key="field.key" class="setting-field">
                <span class="field-top">
                  <strong>{{ field.label }}</strong>
                  <small>{{ sourceLabel(field) }}</small>
                </span>

                <select v-if="field.type === 'select'" v-model="draft[field.key]">
                  <option v-for="option in field.options || []" :key="option" :value="option">
                    {{ providerLabel(option) }}
                  </option>
                </select>

                <input
                  v-else-if="field.type === 'number'"
                  v-model="draft[field.key]"
                  min="1"
                  type="number"
                />

                <label v-else-if="field.type === 'boolean'" class="toggle-line">
                  <input
                    type="checkbox"
                    :checked="draft[field.key] === 'true'"
                    @change="setBooleanDraft(field.key, $event)"
                  />
                  <span>{{ draft[field.key] === 'true' ? '开启' : '关闭' }}</span>
                </label>

                <input
                  v-else
                  v-model="draft[field.key]"
                  :type="field.type === 'secret' ? 'password' : 'text'"
                  :placeholder="field.type === 'secret' && field.secretConfigured ? '已配置，留空不变' : ''"
                />

                <small class="field-hint">{{ fieldHint(field) }}</small>
              </div>
            </div>
          </section>
        </div>
      </section>
    </main>
  </WorkspaceLayout>
</template>

<style scoped>
.settings-page {
  min-height: 100vh;
  background: #0d0f0d;
  color: #f4ede5;
  padding: 24px;
}

.state-block {
  display: grid;
  min-height: calc(100vh - 48px);
  place-content: center;
  gap: 16px;
  color: #dbc2b0;
}

.settings-shell {
  display: grid;
  gap: 20px;
}

.page-head,
.settings-grid,
.summary-grid {
  width: min(1180px, 100%);
  margin: 0 auto;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  border-bottom: 1px solid #554336;
  padding-bottom: 18px;
}

.page-head h1,
.panel-head h2 {
  margin: 0;
  font-family: 'Playfair Display', serif;
}

.page-head h1 {
  font-size: 34px;
  line-height: 1.15;
}

.page-head p {
  margin: 6px 0 0;
  max-width: 620px;
  color: #dbc2b0;
}

.eyebrow {
  margin: 0;
  color: #ffb77d;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.head-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.change-pill,
.summary-item,
.settings-panel,
.group-nav {
  border: 1px solid #554336;
  background: #1a1c1a;
}

.change-pill {
  display: inline-flex;
  align-items: center;
  min-height: 38px;
  padding: 0 12px;
  color: #ffb77d;
  font-size: 12px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.summary-item {
  display: grid;
  gap: 4px;
  padding: 14px;
}

.summary-item span,
.summary-item small {
  color: #dbc2b0;
  font-size: 12px;
}

.summary-item strong {
  overflow-wrap: anywhere;
  color: #f4ede5;
  font-size: 15px;
}

.settings-grid {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 16px;
}

.group-nav {
  align-self: start;
  padding: 8px;
}

.group-button {
  display: grid;
  width: 100%;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  border-left: 2px solid transparent;
  padding: 12px;
  text-align: left;
  color: #dbc2b0;
  transition: 0.18s ease;
}

.group-button:hover,
.group-button.active {
  border-left-color: #ffb77d;
  background: #292a28;
  color: #ffb77d;
}

.group-button strong,
.group-button small {
  display: block;
}

.group-button small {
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #a38c7c;
  font-size: 11px;
}

.settings-panel {
  min-width: 0;
  padding: 18px;
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid #554336;
  padding-bottom: 14px;
}

.panel-head span {
  color: #dbc2b0;
  font-size: 12px;
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  padding-top: 16px;
}

.setting-field {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.field-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.field-top strong {
  font-size: 13px;
}

.field-top small,
.field-hint {
  color: #a38c7c;
  font-size: 11px;
}

.setting-field input,
.setting-field select {
  min-height: 40px;
  width: 100%;
  border: 1px solid #554336;
  background: #0d0f0d;
  color: #f4ede5;
  padding: 0 10px;
}

.toggle-line {
  display: flex;
  min-height: 40px;
  align-items: center;
  gap: 10px;
  border: 1px solid #554336;
  background: #0d0f0d;
  padding: 0 10px;
}

.toggle-line input {
  min-height: auto;
  width: 18px;
  height: 18px;
  accent-color: #ffb77d;
}

.message {
  width: min(1180px, 100%);
  margin: 0 auto;
  border: 1px solid;
  padding: 10px 12px;
  font-size: 13px;
}

.message.error {
  border-color: rgba(248, 113, 113, 0.4);
  color: #fecaca;
  background: rgba(127, 29, 29, 0.25);
}

.message.success {
  border-color: rgba(255, 183, 125, 0.45);
  color: #ffddaf;
  background: rgba(217, 119, 6, 0.12);
}

.primary-btn,
.ghost-btn {
  min-height: 38px;
  border: 1px solid #ffb77d;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 700;
}

.primary-btn {
  background: #d97707;
  color: #0d0f0d;
}

.primary-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ghost-btn {
  background: transparent;
  color: #ffb77d;
}

@media (max-width: 920px) {
  .page-head,
  .settings-grid {
    grid-template-columns: 1fr;
  }

  .page-head {
    display: grid;
  }

  .summary-grid,
  .field-grid {
    grid-template-columns: 1fr;
  }
}
</style>
