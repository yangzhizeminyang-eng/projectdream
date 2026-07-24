<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { clearAuthSession } from '@/api/auth'
import { getWorkspaceContext } from '@/lib/context'
import { useCurrentProjectMeta } from '@/lib/current-project'

const route = useRoute()
const router = useRouter()

interface NavItem {
  path: string
  label: string
  icon: string
  requireContext?: 'project' | 'scene' | 'shot'
}

const { projectName, projectStatusLabel } = useCurrentProjectMeta()

const items: NavItem[] = [
  { path: '/dashboard', label: '项目总览', icon: 'folder_open' },
  { path: '/workspace/script/ai', label: '剧本', icon: 'description', requireContext: 'project' },
  { path: '/workspace/script', label: '剧本编辑', icon: 'edit_note', requireContext: 'scene' },
  { path: '/workspace/character', label: '角色', icon: 'person_search', requireContext: 'project' },
  { path: '/workspace/assets', label: '资产', icon: 'inventory_2', requireContext: 'project' },
  { path: '/workspace/storyboard', label: '分镜', icon: 'auto_stories', requireContext: 'scene' },
  { path: '/workspace/frame', label: '画面生成', icon: 'movie_filter', requireContext: 'shot' },
  { path: '/workspace/video', label: '视频生成', icon: 'videocam', requireContext: 'shot' },
  { path: '/workspace/audio', label: '音频', icon: 'mic', requireContext: 'project' },
  { path: '/workspace/ai-tasks', label: '任务中心', icon: 'pending_actions', requireContext: 'project' },
  { path: '/workspace/edit', label: '剪辑', icon: 'movie_edit', requireContext: 'project' },
  { path: '/workspace/export', label: '导出', icon: 'ios_share', requireContext: 'project' },
]

const activePath = computed(() => route.path)

function isActive(path: string) {
  if (path === '/dashboard') return activePath.value === '/dashboard' || activePath.value === '/new'
  return activePath.value.startsWith(path)
}

function go(path: string) {
  router.push(path)
}

function openFrameShortcut() {
  goItem({
    path: '/workspace/frame',
    label: '画面生成',
    icon: 'movie_filter',
    requireContext: 'shot',
  })
}

function goItem(item: NavItem) {
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
      path: '/workspace/script/ai',
      query: { projectId: String(ctx.projectId), needScene: '1' },
    })
    return
  }

  router.push({ path: '/dashboard', query: { reason: 'need-project' } })
}

function logout() {
  clearAuthSession()
  router.replace('/')
}
</script>

<template>
  <nav
    class="fixed bottom-0 left-0 top-[64px] z-40 hidden w-[220px] flex-col border-r border-outline-variant bg-surface-container-lowest py-4 lg:flex"
  >
    <div class="mb-8 px-4">
      <div class="mb-2 flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center border border-primary">
          <span class="material-symbols-outlined text-primary">movie_filter</span>
        </div>
        <div class="min-w-0">
          <div class="truncate font-label-md text-primary">{{ projectName }}</div>
          <div class="text-[10px] text-on-surface-variant">{{ projectStatusLabel }}</div>
        </div>
      </div>
      <button
        class="burning-orange-btn mt-4 flex w-full items-center justify-center gap-2 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        type="button"
        @click="openFrameShortcut"
      >
        <span class="material-symbols-outlined text-sm">add</span>
        新建镜头
      </button>
    </div>

    <div class="scroll-optimized flex-1 overflow-y-auto overscroll-y-contain no-scrollbar">
      <ul class="space-y-1">
        <li v-for="item in items" :key="item.path" class="px-2">
          <button
            class="w-full text-left"
            :class="isActive(item.path) ? 'nav-item-active' : 'nav-item'"
            type="button"
            @click="goItem(item)"
          >
            <span class="material-symbols-outlined">{{ item.icon }}</span>
            <span class="font-label-md text-label-md">{{ item.label }}</span>
          </button>
        </li>
      </ul>
    </div>

    <div class="mt-auto border-t border-outline-variant pt-4">
      <button
        class="flex w-full items-center gap-3 px-4 py-2 text-on-surface-variant transition-all hover:bg-surface-container hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        type="button"
        @click="go('/new')"
      >
        <span class="material-symbols-outlined">library_add</span>
        <span class="font-label-md text-label-md">新建项目</span>
      </button>
      <button
        class="flex w-full items-center gap-3 px-4 py-2 text-on-surface-variant transition-all hover:bg-surface-container hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        :class="{ 'bg-surface-container-low text-primary': activePath === '/settings/ai' }"
        type="button"
        @click="go('/settings/ai')"
      >
        <span class="material-symbols-outlined">settings_suggest</span>
        <span class="font-label-md text-label-md">模型设置</span>
      </button>
      <button
        class="flex w-full items-center gap-3 px-4 py-2 text-on-surface-variant transition-all hover:bg-surface-container hover:text-danger-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        type="button"
        @click="logout"
      >
        <span class="material-symbols-outlined">logout</span>
        <span class="font-label-md text-label-md">退出登录</span>
      </button>
    </div>
  </nav>
</template>
