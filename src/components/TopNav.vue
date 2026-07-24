<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { clearAuthSession, getAuthUser, type AuthUser } from '@/api/auth'
import { getWorkspaceContext } from '@/lib/context'
import { useCurrentProjectMeta } from '@/lib/current-project'

const route = useRoute()
const router = useRouter()

const authUser = ref<AuthUser | null>(getAuthUser())
const menuOpen = ref(false)
const toolbarHint = ref('')
const {
  currentProjectId,
  projectLoading,
  projectName,
  projectStatusLabel,
} = useCurrentProjectMeta()

let hintTimer: number | null = null

const isWorkspace = computed(() => route.path.startsWith('/workspace'))
const sectionTitle = computed(() =>
  typeof route.meta.title === 'string' ? route.meta.title : '项目总览',
)
const displayName = computed(() => authUser.value?.nickname?.trim() || '创作者')
const userPhone = computed(() => {
  const phone = authUser.value?.phone || ''
  return /^1\d{10}$/.test(phone) ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '未绑定手机号'
})
const avatarLabel = computed(() => displayName.value.slice(0, 1) || '我')
const recordButtonLabel = computed(() =>
  toolbarHint.value.includes('位置已记录') ? '已记录' : '记录位置',
)

function setToolbarHint(message: string) {
  toolbarHint.value = message
  if (hintTimer) window.clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => {
    toolbarHint.value = ''
    hintTimer = null
  }, 2400)
}

function goHome() {
  menuOpen.value = false
  router.push('/dashboard')
}

function rememberPosition() {
  const savedAt = new Date().toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
  localStorage.setItem(
    'projectdream_last_position',
    JSON.stringify({
      path: route.fullPath,
      savedAt,
    }),
  )
  setToolbarHint(`位置已记录 ${savedAt}`)
}

function goExport() {
  const ctx = getWorkspaceContext()
  if (ctx?.projectId) {
    router.push({
      path: '/workspace/export',
      query: { projectId: String(ctx.projectId) },
    })
    return
  }
  router.push('/workspace/export')
}

function showSyncStatus() {
  setToolbarHint('当前为本地开发环境')
}

function showHistoryHint() {
  setToolbarHint('这里只记录最近访问位置，不包含表单草稿')
}

function showNotificationsHint() {
  setToolbarHint('暂无新的系统提示')
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value
}

function goNewProject() {
  menuOpen.value = false
  router.push('/new')
}

function goAISettings() {
  menuOpen.value = false
  router.push('/settings/ai')
}

function logout() {
  clearAuthSession()
  authUser.value = null
  menuOpen.value = false
  router.replace('/')
}

watch(
  () => route.fullPath,
  () => {
    authUser.value = getAuthUser()
    menuOpen.value = false
  },
)

onBeforeUnmount(() => {
  if (hintTimer) window.clearTimeout(hintTimer)
})
</script>

<template>
  <header
    class="fixed left-0 top-0 z-50 flex h-[64px] w-full items-center justify-between gap-4 border-b border-outline-variant bg-surface px-4 md:px-margin-md"
  >
    <div class="flex min-w-0 items-center gap-4 md:gap-8">
      <button
        class="font-display-lg text-2xl tracking-tight text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        type="button"
        @click="goHome"
      >
        梦绘片场
      </button>
      <div class="min-w-0">
        <div class="truncate text-xs uppercase tracking-[0.2em] text-on-surface-variant">
          {{ sectionTitle }}
        </div>
        <div v-if="isWorkspace" class="hidden items-center gap-4 lg:flex">
          <span class="truncate font-label-md text-on-surface">{{ projectName }}</span>
          <span
            class="border border-primary/30 bg-primary/10 px-3 py-1 text-xs text-primary"
            :title="currentProjectId ? `当前项目 ID：${currentProjectId}` : '当前还没有项目上下文'"
          >
            {{ projectLoading ? '读取项目中' : projectStatusLabel }}
          </span>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-2 md:gap-6">
      <div class="hidden items-center gap-3 md:flex">
        <button
          aria-label="云端同步状态"
          class="material-symbols-outlined text-on-surface-variant transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="showSyncStatus"
        >
          cloud_done
        </button>
        <button
          aria-label="查看历史"
          class="material-symbols-outlined text-on-surface-variant transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="showHistoryHint"
        >
          history
        </button>
        <button
          aria-label="通知中心"
          class="material-symbols-outlined relative text-on-surface-variant transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="showNotificationsHint"
        >
          notifications
          <span class="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary-container"></span>
        </button>
        <span
          v-if="toolbarHint"
          class="max-w-[220px] truncate border border-primary/30 bg-primary/10 px-3 py-1 text-xs text-primary"
        >
          {{ toolbarHint }}
        </span>
      </div>

      <div class="hidden gap-3 sm:flex">
        <button
          class="border border-outline-variant px-4 py-1 text-sm text-on-surface transition-all hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="rememberPosition"
        >
          {{ recordButtonLabel }}
        </button>
        <button
          class="burning-orange-btn px-4 py-1 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="goExport"
        >
          导出
        </button>
      </div>

      <div class="relative">
        <button
          aria-label="个人中心"
          class="flex h-9 min-w-[2.25rem] items-center justify-center border border-outline-variant bg-surface-container-highest px-2 text-sm text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="toggleMenu"
        >
          <span class="font-semibold">{{ avatarLabel }}</span>
        </button>

        <div
          v-if="menuOpen"
          class="absolute right-0 top-[calc(100%+0.5rem)] w-64 border border-outline-variant bg-surface-container-low p-3 shadow-2xl"
        >
          <div class="border-b border-outline-variant pb-3">
            <div class="text-sm font-semibold text-on-surface">{{ displayName }}</div>
            <div class="mt-1 text-xs text-on-surface-variant">{{ userPhone }}</div>
          </div>
          <div class="mt-3 grid gap-2">
            <button
              class="flex items-center gap-2 px-3 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              type="button"
              @click="goHome"
            >
              <span class="material-symbols-outlined text-base">space_dashboard</span>
              项目总览
            </button>
            <button
              class="flex items-center gap-2 px-3 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              type="button"
              @click="goNewProject"
            >
              <span class="material-symbols-outlined text-base">add_circle</span>
              新建项目
            </button>
            <button
              class="flex items-center gap-2 px-3 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              type="button"
              @click="goAISettings"
            >
              <span class="material-symbols-outlined text-base">settings_suggest</span>
              模型设置
            </button>
            <button
              class="flex items-center gap-2 px-3 py-2 text-left text-sm text-danger-red transition-colors hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              type="button"
              @click="logout"
            >
              <span class="material-symbols-outlined text-base">logout</span>
              退出登录
            </button>
          </div>
        </div>
      </div>
    </div>
  </header>
</template>
