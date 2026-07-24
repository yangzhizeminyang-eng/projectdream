import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { hasAuthSession } from '@/api/auth'

declare module 'vue-router' {
  interface RouteMeta {
    guestOnly?: boolean
    requiresAuth?: boolean
    title?: string
    /**
     * @description 上一个路由的 name（由 beforeEach 注入），
     *              用于 App.vue 的路由过渡方向判断
     */
    fromName?: string
  }
}

const APP_TITLE = 'PanelFlow - AI漫剧制片系统'

function withTitle(title: string): string {
  return `${title} | PanelFlow`
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    meta: { guestOnly: true, title: '登录' },
  },
  {
    path: '/login',
    redirect: '/',
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('@/views/Register.vue'),
    meta: { guestOnly: true, title: '注册' },
  },
  {
    path: '/forgot-password',
    name: 'forgot-password',
    component: () => import('@/views/ForgotPassword.vue'),
    meta: { guestOnly: true, title: '找回密码' },
  },
  {
    path: '/reset-password',
    name: 'reset-password',
    component: () => import('@/views/ResetPassword.vue'),
    meta: { guestOnly: true, title: '重置密码' },
  },
  {
    path: '/dashboard',
    name: 'dashboard',
    component: () => import('@/views/Dashboard.vue'),
    meta: { requiresAuth: true, title: '项目总览' },
  },
  {
    path: '/new',
    name: 'new-project',
    component: () => import('@/views/NewProject.vue'),
    meta: { requiresAuth: true, title: '新建项目' },
  },
  {
    path: '/settings/ai',
    name: 'ai-settings',
    component: () => import('@/views/AISettings.vue'),
    meta: { requiresAuth: true, title: '模型设置' },
  },
  {
    path: '/workspace/script/ai',
    name: 'ai-script',
    component: () => import('@/views/AIScript.vue'),
    meta: { requiresAuth: true, title: 'AI 剧本' },
  },
  {
    path: '/workspace/scenes',
    name: 'scenes',
    component: () => import('@/views/Scenes.vue'),
    meta: { requiresAuth: true, title: '场景拆解' },
  },
  {
    path: '/workspace/script',
    name: 'script-editor',
    component: () => import('@/views/ScriptEditor.vue'),
    meta: { requiresAuth: true, title: '剧本编辑' },
  },
  {
    path: '/workspace/character',
    name: 'character-library',
    component: () => import('@/views/CharacterLibrary.vue'),
    meta: { requiresAuth: true, title: '角色库' },
  },
  {
    path: '/workspace/character/detail',
    name: 'character-detail',
    component: () => import('@/views/CharacterDetail.vue'),
    meta: { requiresAuth: true, title: '角色详情' },
  },
  {
    path: '/workspace/assets',
    name: 'asset-library',
    component: () => import('@/views/AssetLibrary.vue'),
    meta: { requiresAuth: true, title: '资产库' },
  },
  {
    path: '/workspace/storyboard',
    name: 'storyboard-list',
    component: () => import('@/views/StoryboardList.vue'),
    meta: { requiresAuth: true, title: '分镜看板' },
  },
  {
    path: '/workspace/storyboard/editor',
    name: 'storyboard-editor',
    component: () => import('@/views/StoryboardEditor.vue'),
    meta: { requiresAuth: true, title: '分镜编辑' },
  },
  {
    path: '/workspace/frame',
    name: 'frame-generate',
    component: () => import('@/views/FrameGenerate.vue'),
    meta: { requiresAuth: true, title: '画面生成' },
  },
  {
    path: '/workspace/frame/result',
    name: 'frame-result',
    component: () => import('@/views/FrameResult.vue'),
    meta: { requiresAuth: true, title: '镜头结果' },
  },
  {
    path: '/workspace/video',
    name: 'video-generate',
    component: () => import('@/views/VideoGenerate.vue'),
    meta: { requiresAuth: true, title: '视频生成' },
  },
  {
    path: '/workspace/audio',
    name: 'audio-studio',
    component: () => import('@/views/AudioStudio.vue'),
    meta: { requiresAuth: true, title: '音频工作台' },
  },
  {
    path: '/workspace/ai-tasks',
    name: 'ai-task-center',
    component: () => import('@/views/AITaskCenter.vue'),
    meta: { requiresAuth: true, title: '任务中心' },
  },
  {
    path: '/workspace/edit',
    name: 'final-edit',
    component: () => import('@/views/FinalEdit.vue'),
    meta: { requiresAuth: true, title: '成片编辑' },
  },
  {
    path: '/workspace/export',
    name: 'export',
    component: () => import('@/views/Export.vue'),
    meta: { requiresAuth: true, title: '导出交付' },
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

router.beforeEach((to, from) => {
  const authenticated = hasAuthSession()

  // 将来源路由 name 注入目标 meta，供 App.vue 决定过渡方向
  if (from.name) {
    to.meta.fromName = from.name as string
  }

  if (to.meta.requiresAuth && !authenticated) {
    return {
      path: '/',
      query: to.fullPath !== '/' ? { redirect: to.fullPath } : {},
    }
  }

  if (to.meta.guestOnly && authenticated) {
    return '/dashboard'
  }

  return true
})

router.afterEach((to) => {
  document.title = typeof to.meta.title === 'string' ? withTitle(to.meta.title) : APP_TITLE
})

export default router
