<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { clearAuthSession, getAuthUser, type AuthUser } from '@/api/auth'
import { getCreativeWorkflowGates, type CreativeWorkflowGatesDTO } from '@/api/project'
import { getWorkspaceContext } from '@/lib/context'
import { useCurrentProjectMeta } from '@/lib/current-project'

const route = useRoute()
const router = useRouter()
const authUser = ref<AuthUser | null>(getAuthUser())
const accountMenuOpen = ref(false)
const workflowGates = ref<CreativeWorkflowGatesDTO | null>(null)

interface NavItem {
  path: string
  label: string
  icon: string
  requireContext?: 'project' | 'scene' | 'shot'
}

const { projectName, projectStatusLabel } = useCurrentProjectMeta()

const displayName = computed(() => authUser.value?.nickname?.trim() || '创作者')
const userPhone = computed(() => {
  const phone = authUser.value?.phone || ''
  return /^1\d{10}$/.test(phone) ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '未绑定手机号'
})
const avatarLabel = computed(() => displayName.value.slice(0, 1) || '我')

// 菜单项声明了自己需要哪一级上下文：
// project 只需要项目，scene 需要项目+场景，shot 需要项目+场景+分镜。
// 点击菜单时 goItem() 会根据当前 sessionStorage 上下文决定直接进入还是引导用户补齐前置条件。
const primaryItems: NavItem[] = [
  { path: '/dashboard', label: '项目总览', icon: 'folder_open' },
  { path: '/workspace/studio', label: '创作总览', icon: 'theaters', requireContext: 'project' },
]

const craftItems: NavItem[] = [
  { path: '/workspace/studio/script', label: '剧本生成', icon: 'description', requireContext: 'project' },
  { path: '/workspace/assets', label: '资产', icon: 'inventory_2', requireContext: 'project' },
  { path: '/workspace/episodes', label: '分镜视频生成', icon: 'movie', requireContext: 'project' },
]

const activePath = computed(() => route.path)

function isActive(path: string) {
  // 工作台子路由也要高亮父级菜单，例如分镜视频工作台仍高亮“分镜视频生成”。
  if (path === '/dashboard') return activePath.value === '/dashboard' || activePath.value === '/new'
  if (path === '/workspace/character') {
    return activePath.value === path || activePath.value.startsWith('/workspace/character/detail')
  }
  // 资产画布是资产的子页面，精确匹配，避免两项同时高亮
  if (path === '/workspace/assets') return activePath.value === path
  return activePath.value.startsWith(path)
}

function go(path: string) {
  accountMenuOpen.value = false
  router.push(path)
}

function openFrameShortcut() {
  goItem({
    path: '/workspace/studio/script',
    label: '剧本生成',
    icon: 'description',
    requireContext: 'project',
  })
}

function goItem(item: NavItem) {
  // 这是左侧导航的上下文路由器，避免用户从任意页面进入一个缺少 ID 的业务页面。
  if (!item.requireContext) {
    router.push(item.path)
    return
  }

  const ctx = getWorkspaceContext()

  if (ctx?.projectId && item.requireContext === 'shot' && ctx.sceneId && ctx.storyboardId) {
    router.push({
      path: item.path,
      query: {
        projectId: String(ctx.projectId),
        sceneId: String(ctx.sceneId),
        storyboardId: String(ctx.storyboardId),
      },
    })
    return
  }

  if (ctx?.projectId && item.requireContext === 'scene' && ctx.sceneId) {
    router.push({
      path: item.path,
      query: { projectId: String(ctx.projectId), sceneId: String(ctx.sceneId) },
    })
    return
  }

  if (ctx?.projectId && item.requireContext === 'project') {
    const stage = item.path === '/workspace/assets' ? 'assets'
      : item.path === '/workspace/episodes' ? 'storyboard' : null
    if (stage) {
      void getCreativeWorkflowGates(ctx.projectId).then((gates) => {
        workflowGates.value = gates
        const gate = gates[stage]
        if (!gate.allowed) {
          router.push({ path: '/workspace/studio/script', query: { projectId: String(ctx.projectId), gateReason: gate.reason } })
          return
        }
        router.push({ path: item.path, query: { projectId: String(ctx.projectId) } })
      }).catch(() => {
        workflowGates.value = null
        router.push({
          path: '/workspace/studio',
          query: { projectId: String(ctx.projectId), gateCheckFailed: '1' },
        })
      })
      return
    }
    router.push({ path: item.path, query: { projectId: String(ctx.projectId) } })
    return
  }

  if (ctx?.projectId && item.requireContext === 'shot' && ctx.sceneId) {
    router.push({
      path: '/workspace/storyboard',
      query: { projectId: String(ctx.projectId), sceneId: String(ctx.sceneId), needShot: '1' },
    })
    return
  }

  if (ctx?.projectId) {
    router.push({
      path: '/workspace/studio/script',
      query: { projectId: String(ctx.projectId) },
    })
    return
  }

  router.push({ path: '/dashboard', query: { reason: 'need-project' } })
}

function logout() {
  clearAuthSession()
  authUser.value = null
  accountMenuOpen.value = false
  router.replace('/')
}

watch(
  () => route.fullPath,
  () => {
    authUser.value = getAuthUser()
    accountMenuOpen.value = false
  },
)

function toggleAccountMenu() {
  accountMenuOpen.value = !accountMenuOpen.value
}
</script>

<template>
  <nav
    class="workspace-sidenav fixed bottom-0 left-0 top-[64px] z-40 hidden w-[220px] flex-col border-r border-outline-variant bg-surface-container-lowest py-4 lg:flex"
  >
    <div class="side-project-header mb-8 px-4">
      <div class="mb-2 flex items-center gap-3">
        <div class="side-project-mark flex h-10 w-10 items-center justify-center border border-primary">
          <span class="material-symbols-outlined text-primary">movie_filter</span>
        </div>
        <div class="min-w-0">
      <div class="side-project-kicker">当前项目</div>
          <div class="truncate font-label-md text-primary">{{ projectName }}</div>
          <div class="text-[10px] text-on-surface-variant">{{ projectStatusLabel }}</div>
        </div>
      </div>
      <button
        class="side-action burning-orange-btn mt-4 flex w-full items-center justify-center gap-2 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        type="button"
        @click="openFrameShortcut"
      >
        <span class="material-symbols-outlined text-sm">add</span>
        开始创作
      </button>
    </div>

    <div class="scroll-optimized flex-1 overflow-y-auto overscroll-y-contain no-scrollbar">
      <div class="side-section-label">工作入口</div>
      <ul class="workspace-nav-list space-y-1">
        <li v-for="item in primaryItems" :key="item.path" class="workspace-nav-row px-2">
          <button
            class="workspace-nav-button w-full text-left"
            :class="isActive(item.path) ? 'nav-item-active' : 'nav-item'"
            type="button"
            :title="item.path === '/workspace/assets' && workflowGates && !workflowGates.assets.allowed ? workflowGates.assets.reason : item.path === '/workspace/episodes' && workflowGates && !workflowGates.storyboard.allowed ? workflowGates.storyboard.reason : undefined"
            @click="goItem(item)"
          >
            <span class="material-symbols-outlined">{{ item.icon }}</span>
            <span class="font-label-md text-label-md">{{ item.label }}</span>
          </button>
        </li>
      </ul>

      <details class="side-group" :open="craftItems.some((item) => isActive(item.path))">
        <summary class="side-group-summary">
          <span>创作素材</span>
          <span class="material-symbols-outlined">expand_more</span>
        </summary>
        <ul class="workspace-nav-list space-y-1">
          <li v-for="item in craftItems" :key="item.path" class="workspace-nav-row px-2">
            <button
              class="workspace-nav-button w-full text-left"
              :class="isActive(item.path) ? 'nav-item-active' : 'nav-item'"
              type="button"
              :title="item.path === '/workspace/assets' && workflowGates && !workflowGates.assets.allowed ? workflowGates.assets.reason : item.path === '/workspace/episodes' && workflowGates && !workflowGates.storyboard.allowed ? workflowGates.storyboard.reason : undefined"
              @click="goItem(item)"
            >
              <span class="material-symbols-outlined">{{ item.icon }}</span>
              <span class="font-label-md text-label-md">{{ item.label }}</span>
            </button>
          </li>
        </ul>
      </details>

      <div class="side-section-label side-quick-label">快捷入口</div>
      <ul class="workspace-nav-list space-y-1 side-quick-links">
        <li class="workspace-nav-row px-2">
          <button class="workspace-nav-button w-full text-left" :class="isActive('/settings/ai') ? 'nav-item-active' : 'nav-item'" type="button" @click="go('/settings/ai')">
            <span class="material-symbols-outlined">settings_suggest</span>
            <span class="font-label-md text-label-md">模型设置</span>
          </button>
        </li>
      </ul>

    </div>

    <div class="workspace-side-footer relative mt-auto border-t border-outline-variant pt-4">
      <Transition name="workspace-account-popover">
        <div
          v-if="accountMenuOpen"
          id="workspace-account-menu"
          class="workspace-account-menu"
          role="menu"
          aria-label="账户菜单"
          @keydown.esc="accountMenuOpen = false"
        >
          <div class="workspace-account-menu-items">
            <button
              class="workspace-account-menu-item"
              role="menuitem"
              type="button"
              @click="go('/dashboard')"
            >
              <span class="material-symbols-outlined">space_dashboard</span>
              项目总览
            </button>
            <button
              class="workspace-account-menu-item"
              role="menuitem"
              type="button"
              @click="go('/new')"
            >
              <span class="material-symbols-outlined">library_add</span>
              新建项目
            </button>
            <button
              class="workspace-account-menu-item workspace-account-menu-item--danger"
              role="menuitem"
              type="button"
              @click="logout"
            >
              <span class="material-symbols-outlined">logout</span>
              退出登录
            </button>
          </div>
        </div>
      </Transition>

      <button
        class="workspace-account"
        :class="{ 'is-open': accountMenuOpen }"
        type="button"
        aria-haspopup="menu"
        :aria-expanded="accountMenuOpen"
        :aria-label="accountMenuOpen ? '关闭账户菜单' : '打开账户菜单'"
        @click="toggleAccountMenu"
        @keydown.esc="accountMenuOpen = false"
      >
        <span class="workspace-account-avatar" aria-hidden="true">{{ avatarLabel }}</span>
        <span class="workspace-account-copy">
          <span class="workspace-account-name">{{ displayName }}</span>
          <span class="workspace-account-phone">{{ userPhone }}</span>
        </span>
        <span class="workspace-account-status" aria-label="已登录"></span>
        <span class="material-symbols-outlined workspace-account-chevron" aria-hidden="true">
          expand_more
        </span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.workspace-sidenav {
  border-color: rgba(164, 132, 84, 0.32);
  background:
    linear-gradient(180deg, rgba(255, 183, 125, 0.035), transparent 24%),
    #0c0d0c;
}

.side-project-header {
  border-bottom: 1px solid rgba(164, 132, 84, 0.3);
  padding-bottom: 1.35rem;
}

.side-project-mark {
  background: rgba(255, 183, 125, 0.06);
  box-shadow: inset 0 0 0 1px rgba(255, 183, 125, 0.06);
}

.side-project-kicker,
.side-section-label {
  color: #8f877d;
  font-family: 'Noto Sans', 'Noto Sans SC', sans-serif;
  font-size: 0.5rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  line-height: 1.3;
  text-transform: none;
}

.side-project-kicker { margin-bottom: 0.2rem; }

.side-action {
  min-height: 2.5rem;
  box-shadow: 0 10px 28px rgba(217, 119, 7, 0.15);
  transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.side-action:hover {
  transform: translateY(-1px);
  box-shadow: 0 14px 32px rgba(217, 119, 7, 0.22);
}

.side-section-label {
  margin: 0 1rem 0.55rem;
  padding-top: 0.25rem;
}

.workspace-nav-row { position: relative; }

.side-group {
  margin-top: 0.8rem;
  border-top: 1px solid rgba(164, 132, 84, 0.18);
  padding-top: 0.55rem;
}

.side-group-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.35rem 1rem 0.45rem;
  color: #8f877d;
  cursor: pointer;
  font-family: 'Noto Sans', 'Noto Sans SC', sans-serif;
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  list-style: none;
}

.side-group-summary::-webkit-details-marker { display: none; }
.side-group-summary .material-symbols-outlined {
  font-size: 1rem;
  transition: transform 180ms ease;
}
.side-group[open] .side-group-summary .material-symbols-outlined {
  transform: rotate(180deg);
}

.workspace-nav-button {
  min-height: 2.35rem;
  border-left: 1px solid transparent;
  transition:
    color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    border-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-nav-button:hover { transform: translateX(2px); }

.workspace-nav-row:nth-child(2),
.workspace-nav-row:nth-child(5),
.workspace-nav-row:nth-child(7),
.workspace-nav-row:nth-child(11),
.workspace-nav-row:nth-child(13) {
  margin-top: 0.85rem;
  padding-top: 0.7rem;
  border-top: 1px solid rgba(164, 132, 84, 0.18);
}

.workspace-side-footer {
  border-color: rgba(164, 132, 84, 0.3);
}

.workspace-account {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: calc(100% - 1.5rem);
  margin: 0 0.75rem;
  border: 1px solid rgba(164, 132, 84, 0.18);
  background: rgba(255, 255, 255, 0.018);
  padding: 0.55rem 0.6rem;
  text-align: left;
  transition:
    border-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-account:hover,
.workspace-account.is-open {
  border-color: rgba(255, 183, 125, 0.46);
  background: rgba(255, 183, 125, 0.055);
}

.workspace-account:active {
  transform: translateY(1px);
}

.workspace-account-avatar {
  display: inline-flex;
  width: 1.9rem;
  height: 1.9rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 183, 125, 0.42);
  border-radius: 0.28rem;
  background: rgba(255, 183, 125, 0.055);
  color: #f6b477;
  font-size: 0.78rem;
  font-weight: 800;
}

.workspace-account-copy {
  min-width: 0;
  flex: 1 1 auto;
}

.workspace-account-name {
  overflow: hidden;
  color: #eee8df;
  font-size: 0.74rem;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-account-phone {
  margin-top: 0.12rem;
  overflow: hidden;
  color: #9d9185;
  font-family: 'Noto Sans', 'Noto Sans SC', sans-serif;
  font-size: 0.6rem;
  letter-spacing: 0.03em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-account-status {
  width: 0.36rem;
  height: 0.36rem;
  flex: 0 0 auto;
  border-radius: 999px;
  background: #9bbf78;
}

.workspace-account-chevron {
  flex: 0 0 auto;
  color: #8f8275;
  font-size: 1rem;
  transition:
    color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-account.is-open .workspace-account-chevron {
  color: #ffb77d;
  transform: rotate(180deg);
}

.workspace-account-menu {
  position: absolute;
  right: 0.75rem;
  bottom: calc(100% + 0.5rem);
  left: 0.75rem;
  z-index: 2;
  border: 1px solid rgba(164, 132, 84, 0.34);
  background: #191a18;
  padding: 0.38rem;
  box-shadow:
    0 16px 32px rgba(0, 0, 0, 0.3),
    0 4px 10px rgba(0, 0, 0, 0.14);
}

.workspace-account-menu-items {
  display: grid;
  gap: 0.12rem;
}

.workspace-account-menu-item {
  display: flex;
  width: 100%;
  min-height: 2.15rem;
  align-items: center;
  gap: 0.55rem;
  padding: 0.38rem 0.5rem;
  color: #cfc6bb;
  font-size: 0.74rem;
  font-weight: 550;
  text-align: left;
  transition:
    background-color 180ms cubic-bezier(0.16, 1, 0.3, 1),
    color 180ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-account-menu-item:hover,
.workspace-account-menu-item.is-active {
  background: rgba(255, 183, 125, 0.07);
  color: #ffb77d;
}

.workspace-account-menu-item .material-symbols-outlined {
  color: #a38c7c;
  font-size: 1.05rem;
  transition: color 180ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-account-menu-item:hover .material-symbols-outlined,
.workspace-account-menu-item.is-active .material-symbols-outlined {
  color: #ffb77d;
}

.workspace-account-menu-item--danger {
  margin-top: 0.3rem;
  border-top: 1px solid rgba(164, 132, 84, 0.2);
  padding-top: 0.62rem;
  color: #fca5a5;
}

.workspace-account-menu-item--danger:hover {
  background: rgba(127, 29, 29, 0.18);
  color: #fee2e2;
}

.workspace-account-menu-item--danger:hover .material-symbols-outlined {
  color: #fecaca;
}

.workspace-account-popover-enter-active,
.workspace-account-popover-leave-active {
  transform-origin: bottom center;
  transition:
    opacity 180ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
}

.workspace-account-popover-enter-from,
.workspace-account-popover-leave-to {
  opacity: 0;
  transform: translateY(0.45rem) scale(0.97);
}

@media (prefers-reduced-motion: reduce) {
  .workspace-account,
  .workspace-account-chevron,
  .workspace-account-menu-item,
  .workspace-account-popover-enter-active,
  .workspace-account-popover-leave-active {
    transition: none;
  }
}
</style>
