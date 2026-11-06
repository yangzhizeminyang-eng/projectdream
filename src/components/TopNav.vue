<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { clearAuthSession, getAuthUser, type AuthUser } from '@/api/auth'
import { useCurrentProjectMeta } from '@/lib/current-project'

const route = useRoute()
const router = useRouter()

const authUser = ref<AuthUser | null>(getAuthUser())
const menuOpen = ref(false)
const notificationOpen = ref(false)
const notificationLayer = ref<HTMLElement | null>(null)
const toolbarHint = ref('')
const {
  currentProjectId,
  projectLoading,
  projectName,
  projectStatusLabel,
} = useCurrentProjectMeta()

let hintTimer: number | null = null

// 顶部导航根据当前路由显示页面标题、当前项目和项目状态。
// 用户信息从 localStorage 读取，项目元信息由 useCurrentProjectMeta() 异步加载。
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
  // 工具栏提示是短暂状态，新的提示会覆盖旧提示，并重新计时。
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
  // 记录最近一次访问位置，属于本地 UI 便利功能，不参与业务数据保存。
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

function showSyncStatus() {
  setToolbarHint('当前为本地开发环境')
}

function showHistoryHint() {
  setToolbarHint('这里只记录最近访问位置，不包含表单草稿')
}

function showNotificationsHint() {
  menuOpen.value = false
  notificationOpen.value = !notificationOpen.value
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value
  notificationOpen.value = false
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
  // 清除前端会话后回到登录页；后端 session 是否撤销由后端策略决定。
  clearAuthSession()
  authUser.value = null
  menuOpen.value = false
  router.replace('/')
}

watch(
  () => route.fullPath,
  () => {
    // 路由切换后刷新用户显示信息，并关闭头像菜单。
    authUser.value = getAuthUser()
    menuOpen.value = false
    notificationOpen.value = false
  },
)

watch(notificationOpen, async (open) => {
  if (!open) return
  await nextTick()
  notificationLayer.value?.focus()
})

onBeforeUnmount(() => {
  if (hintTimer) window.clearTimeout(hintTimer)
})
</script>

<template>
  <header
    class="workspace-topbar fixed left-0 top-0 z-50 flex h-[64px] w-full items-center justify-between gap-3 border-b border-outline-variant bg-surface px-3 md:px-6"
  >
    <div class="workspace-topbar-main flex min-w-0 items-center">
      <button
        class="workspace-brand font-display-lg text-2xl tracking-tight text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        type="button"
        @click="goHome"
      >
        <span class="workspace-brand-mark" aria-hidden="true">
          <span class="material-symbols-outlined">movie_filter</span>
        </span>
        <span class="workspace-brand-copy">
          <span class="workspace-brand-cn">帧心帧意</span>
          <span class="workspace-brand-en">AI 漫剧制片</span>
        </span>
      </button>
      <div class="workspace-context min-w-0">
        <div class="workspace-context-kicker truncate">
          {{ sectionTitle }}
        </div>
        <div v-if="isWorkspace" class="hidden items-center gap-4 lg:flex">
          <span class="workspace-project">
            <span class="workspace-project-icon material-symbols-outlined" aria-hidden="true">movie</span>
            <span class="workspace-project-name truncate">{{ projectName }}</span>
          </span>
          <span
            class="workspace-project-status"
            :title="currentProjectId ? `当前项目 ID：${currentProjectId}` : '当前还没有项目上下文'"
          >
            <span class="workspace-project-status-dot" aria-hidden="true"></span>
            {{ projectLoading ? '读取项目中' : projectStatusLabel }}
          </span>
        </div>
      </div>
    </div>

    <div class="workspace-topbar-tools flex items-center gap-2 md:gap-4">
      <div class="workspace-utility hidden items-center gap-1.5 md:flex">
        <button
          aria-label="云端同步状态"
          class="workspace-utility-button"
          type="button"
          @click="showSyncStatus"
        >
          <span class="material-symbols-outlined" aria-hidden="true">cloud_done</span>
        </button>
        <button
          aria-label="查看历史"
          class="workspace-utility-button"
          type="button"
          @click="showHistoryHint"
        >
          <span class="material-symbols-outlined" aria-hidden="true">history</span>
        </button>
        <button
          aria-label="通知中心"
          :aria-expanded="notificationOpen"
          aria-controls="workspace-notification-dialog"
          class="workspace-utility-button relative"
          type="button"
          @click="showNotificationsHint"
        >
          <span class="material-symbols-outlined" aria-hidden="true">notifications</span>
        </button>
        <span
          v-if="toolbarHint"
          class="workspace-hint max-w-[220px] truncate border border-primary/30 bg-primary/10 px-3 py-1 text-xs text-primary"
        >
          {{ toolbarHint }}
        </span>
      </div>

      <div v-if="route.path !== '/workspace/studio'" class="workspace-actions hidden gap-3 sm:flex">
        <button
          class="workspace-action workspace-action--quiet border border-outline-variant px-4 py-1 text-sm text-on-surface transition-all hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="rememberPosition"
        >
          <span class="material-symbols-outlined" aria-hidden="true">bookmark_add</span>
          {{ recordButtonLabel }}
        </button>
      </div>

      <div class="relative lg:hidden">
        <button
          aria-label="个人中心"
          :aria-expanded="menuOpen"
          aria-haspopup="menu"
          :class="{ 'is-open': menuOpen }"
          class="workspace-profile flex h-9 min-w-[2.25rem] items-center justify-center border border-outline-variant bg-surface-container-highest px-2 text-sm text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="toggleMenu"
        >
          <span class="workspace-avatar">{{ avatarLabel }}</span>
          <span class="material-symbols-outlined workspace-profile-chevron" aria-hidden="true">expand_more</span>
        </button>

        <Transition name="workspace-profile-popover">
          <div
            v-if="menuOpen"
            id="workspace-profile-menu"
            class="workspace-profile-menu absolute right-0 top-[calc(100%+0.5rem)] w-64 border border-outline-variant bg-surface-container-low p-3 shadow-2xl"
            role="menu"
            aria-label="个人中心菜单"
          >
            <div class="workspace-profile-summary border-b border-outline-variant pb-3">
              <div class="text-sm font-semibold text-on-surface">{{ displayName }}</div>
              <div class="mt-1 text-xs text-on-surface-variant">{{ userPhone }}</div>
            </div>
            <div class="mt-3 grid gap-2">
              <button
                class="workspace-profile-menu-item flex items-center gap-2 px-3 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                role="menuitem"
                type="button"
                @click="goHome"
              >
                <span class="material-symbols-outlined text-base">space_dashboard</span>
                项目总览
              </button>
              <button
                class="workspace-profile-menu-item flex items-center gap-2 px-3 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                role="menuitem"
                type="button"
                @click="goNewProject"
              >
                <span class="material-symbols-outlined text-base">add_circle</span>
                新建项目
              </button>
              <button
                class="workspace-profile-menu-item flex items-center gap-2 px-3 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                role="menuitem"
                type="button"
                @click="goAISettings"
              >
                <span class="material-symbols-outlined text-base">settings_suggest</span>
                模型设置
              </button>
              <button
                class="workspace-profile-menu-item flex items-center gap-2 px-3 py-2 text-left text-sm text-danger-red transition-colors hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                role="menuitem"
                type="button"
                @click="logout"
              >
                <span class="material-symbols-outlined text-base">logout</span>
                退出登录
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </header>

  <Teleport to="body">
    <div
      v-if="notificationOpen"
      ref="notificationLayer"
      class="workspace-notification-layer fixed inset-0 z-[60] flex items-start justify-center px-4 pt-24 sm:pt-28"
      role="presentation"
      tabindex="-1"
      @click.self="notificationOpen = false"
      @keydown.esc="notificationOpen = false"
    >
      <section
        id="workspace-notification-dialog"
        class="workspace-notification-dialog w-full max-w-[560px] border border-outline-variant bg-surface-container-low shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-notification-title"
        @click.stop
      >
        <header class="workspace-notification-header flex items-center justify-between gap-4 border-b border-outline-variant px-5 py-4 sm:px-6">
          <div class="flex min-w-0 items-center gap-3">
            <span class="workspace-notification-icon material-symbols-outlined" aria-hidden="true">notifications_active</span>
            <div class="min-w-0">
              <h2 id="workspace-notification-title" class="font-headline-md text-on-surface">系统提示</h2>
              <p class="mt-1 text-xs text-on-surface-variant">这里会显示与你的项目有关的提醒</p>
            </div>
          </div>
          <button
            type="button"
            class="workspace-notification-close flex h-9 w-9 shrink-0 items-center justify-center border border-outline-variant text-on-surface-variant transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            aria-label="关闭系统提示"
            @click="notificationOpen = false"
          >
            <span class="material-symbols-outlined text-[20px]" aria-hidden="true">close</span>
          </button>
        </header>

        <div class="workspace-notification-empty px-6 py-12 text-center sm:px-10 sm:py-14">
          <span class="material-symbols-outlined workspace-notification-empty-icon" aria-hidden="true">notifications_none</span>
          <h3 class="mt-5 text-base font-semibold text-on-surface">暂无新的系统提示</h3>
          <p class="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-on-surface-variant">
            当生成任务、项目状态或交付流程出现需要你处理的事项时，提醒会显示在这里。
          </p>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.workspace-topbar {
  --topbar-bg: rgba(12, 13, 12, 0.92);
  border-color: rgba(164, 132, 84, 0.38);
  background:
    linear-gradient(90deg, rgba(255, 183, 125, 0.045), transparent 32%),
    var(--topbar-bg);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  box-shadow: inset 0 -1px 0 rgba(255, 183, 125, 0.08);
}

.workspace-topbar-main {
  height: 100%;
}

.workspace-brand {
  display: inline-flex;
  align-items: center;
  gap: 0.8rem;
  height: 100%;
  padding-right: 1.15rem;
  min-width: 0;
  border: 0;
  background: transparent;
}

.workspace-brand-mark {
  display: inline-flex;
  width: 2.35rem;
  height: 2.35rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 183, 125, 0.72);
  background: rgba(255, 183, 125, 0.08);
  color: #ffb77d;
  transition:
    background-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    border-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-brand:hover .workspace-brand-mark {
  border-color: #ffb77d;
  background: rgba(255, 183, 125, 0.15);
  transform: translateY(-1px);
}

.workspace-brand-mark .material-symbols-outlined { font-size: 1.15rem; }

.workspace-brand-copy {
  display: grid;
  min-width: 0;
  gap: 0.18rem;
  text-align: left;
}

.workspace-brand-cn {
  color: #ffb77d;
  font-family: 'Playfair Display', 'Noto Serif SC', serif;
  font-size: 1.12rem;
  font-weight: 700;
  line-height: 1;
}

.workspace-brand-en,
.workspace-context-kicker {
  color: #a38c7c;
  font-family: 'Noto Sans', 'Noto Sans SC', sans-serif;
  font-size: 0.56rem;
  font-weight: 700;
  letter-spacing: 0.16em;
  line-height: 1.2;
  text-transform: none;
}

.workspace-context {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.35rem;
  max-width: min(42vw, 34rem);
  height: 2.75rem;
  border-left: 1px solid rgba(164, 132, 84, 0.38);
  padding-left: 1.15rem;
}

.workspace-context-kicker {
  font-size: 0.6rem;
  letter-spacing: 0.18em;
  line-height: 1;
}

.workspace-context > div:last-child {
  gap: 0.7rem;
}

.workspace-project {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 0.4rem;
}

.workspace-project-icon {
  flex: 0 0 auto;
  color: #ffb77d;
  font-size: 1rem;
}

.workspace-project-name {
  max-width: min(25vw, 18rem);
  color: #eee8df;
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.workspace-project-status {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.38rem;
  border: 1px solid rgba(255, 183, 125, 0.26);
  background: rgba(255, 183, 125, 0.07);
  padding: 0.24rem 0.55rem;
  color: #ffb77d;
  font-size: 0.66rem;
  line-height: 1;
  white-space: nowrap;
}

.workspace-project-status-dot {
  width: 0.35rem;
  height: 0.35rem;
  border-radius: 999px;
  background: #ffb77d;
  box-shadow: 0 0 0 3px rgba(255, 183, 125, 0.1);
}

.workspace-utility {
  border-right: 1px solid rgba(164, 132, 84, 0.32);
  padding-right: 0.9rem;
}

.workspace-utility-button {
  display: inline-flex;
  width: 2.25rem;
  height: 2.25rem;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  color: #b7aa9c;
  transition:
    border-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-utility-button:hover {
  border-color: rgba(255, 183, 125, 0.22);
  background: rgba(255, 183, 125, 0.07);
  color: #ffb77d;
  transform: translateY(-1px);
}

.workspace-utility-button .material-symbols-outlined {
  font-size: 1.25rem;
}

.workspace-hint {
  background: rgba(255, 183, 125, 0.07);
  border-color: rgba(255, 183, 125, 0.38);
}

.workspace-action {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-height: 2.25rem;
  border-radius: 0;
  transition:
    border-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-action::after {
  position: absolute;
  inset: 0;
  content: '';
  pointer-events: none;
  background: linear-gradient(105deg, transparent 35%, rgba(255, 247, 237, 0.16) 50%, transparent 65%);
  opacity: 0;
  transform: translateX(-115%);
  transition:
    opacity 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 500ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-action:hover {
  transform: translateY(-1px);
}

.workspace-action:hover::after {
  opacity: 1;
  transform: translateX(115%);
}

.workspace-action:active,
.workspace-profile:active { transform: translateY(1px); }

.workspace-action .material-symbols-outlined {
  font-size: 1rem;
  transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-action:hover .material-symbols-outlined {
  transform: translateY(-1px) scale(1.06);
}

.workspace-action--quiet { background: rgba(255, 255, 255, 0.025); }
.workspace-action--quiet:hover {
  background: rgba(255, 183, 125, 0.07);
}

.workspace-action--primary {
  box-shadow: 0 8px 24px rgba(217, 119, 7, 0.14);
}

.workspace-action--primary:hover {
  box-shadow: 0 11px 28px rgba(217, 119, 7, 0.22);
}

.workspace-profile {
  gap: 0.15rem;
  border-color: rgba(164, 132, 84, 0.42);
  background: rgba(255, 255, 255, 0.045);
  transition: border-color 220ms cubic-bezier(0.16, 1, 0.3, 1), transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-profile:hover {
  border-color: rgba(255, 183, 125, 0.62);
  background: rgba(255, 183, 125, 0.08);
}

.workspace-profile.is-open {
  border-color: rgba(255, 183, 125, 0.72);
  background: rgba(255, 183, 125, 0.12);
  box-shadow: 0 0 0 3px rgba(255, 183, 125, 0.06);
}

.workspace-avatar {
  display: inline-flex;
  width: 1.35rem;
  height: 1.35rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 183, 125, 0.55);
  border-radius: 999px;
  color: #ffb77d;
  font-size: 0.72rem;
  font-weight: 700;
}

.workspace-profile-chevron {
  color: #a38c7c;
  font-size: 1rem;
  transition:
    color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-profile.is-open .workspace-profile-chevron {
  color: #ffb77d;
  transform: rotate(180deg);
}

.workspace-profile-menu {
  transform-origin: top right;
  border-color: rgba(164, 132, 84, 0.46);
  background:
    linear-gradient(145deg, rgba(255, 183, 125, 0.08), transparent 35%),
    #171917;
  box-shadow:
    0 22px 48px rgba(0, 0, 0, 0.34),
    0 0 0 1px rgba(255, 183, 125, 0.04);
}

.workspace-profile-summary {
  animation: profileSummaryIn 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.workspace-profile-menu-item {
  position: relative;
  transform-origin: left center;
  transition:
    background-color 180ms cubic-bezier(0.16, 1, 0.3, 1),
    color 180ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-profile-menu-item:hover {
  transform: translateX(3px);
}

.workspace-profile-menu-item .material-symbols-outlined {
  color: #a38c7c;
  transition:
    color 180ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-profile-menu-item:hover .material-symbols-outlined {
  color: #ffb77d;
  transform: translateX(1px);
}

.workspace-profile-popover-enter-active,
.workspace-profile-popover-leave-active {
  transition:
    opacity 180ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-profile-popover-enter-from,
.workspace-profile-popover-leave-to {
  opacity: 0;
  transform: translateY(-0.45rem) scale(0.97);
}

.workspace-profile-popover-enter-active .workspace-profile-menu-item {
  animation: profileItemIn 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.workspace-profile-popover-enter-active .workspace-profile-menu-item:nth-child(2) {
  animation-delay: 35ms;
}

.workspace-profile-popover-enter-active .workspace-profile-menu-item:nth-child(3) {
  animation-delay: 70ms;
}

.workspace-profile-popover-enter-active .workspace-profile-menu-item:nth-child(4) {
  animation-delay: 105ms;
}

@keyframes profileSummaryIn {
  from {
    opacity: 0;
    transform: translateY(-0.2rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes profileItemIn {
  from {
    opacity: 0;
    transform: translateX(-0.35rem);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.workspace-notification-layer {
  background: rgba(4, 6, 8, 0.68);
  backdrop-filter: blur(7px);
  -webkit-backdrop-filter: blur(7px);
}

.workspace-notification-dialog {
  border-color: rgba(164, 132, 84, 0.48);
  background:
    linear-gradient(135deg, rgba(255, 183, 125, 0.08), transparent 42%),
    #171917;
  animation: notificationPanelIn 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
  box-shadow:
    0 28px 80px rgba(0, 0, 0, 0.48),
    0 0 0 1px rgba(255, 183, 125, 0.04);
}

@keyframes notificationPanelIn {
  from {
    opacity: 0;
    transform: translateY(-0.75rem) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.workspace-notification-header {
  background: rgba(255, 183, 125, 0.035);
}

.workspace-notification-icon {
  display: inline-flex;
  width: 2.35rem;
  height: 2.35rem;
  align-items: center;
  justify-content: center;
  background: rgba(217, 119, 7, 0.16);
  color: #ffb77d;
  font-size: 1.25rem;
}

.workspace-notification-empty {
  min-height: 15rem;
}

.workspace-notification-empty-icon {
  color: #8d7968;
  font-size: 2.75rem;
  opacity: 0.9;
}

.workspace-notification-close {
  transition:
    border-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-notification-close:active {
  transform: translateY(1px);
}

@media (max-width: 767px) {
  .workspace-brand-en,
  .workspace-context { display: none; }
  .workspace-brand-cn { font-size: 1rem; }
  .workspace-brand { padding-right: 0; }
  .workspace-brand-mark { width: 2.15rem; height: 2.15rem; }
  .workspace-utility { padding-right: 0.35rem; }
  .workspace-topbar-tools { gap: 0.25rem; }
}

@media (prefers-reduced-motion: reduce) {
  .workspace-notification-dialog {
    animation: none;
  }
}
</style>
