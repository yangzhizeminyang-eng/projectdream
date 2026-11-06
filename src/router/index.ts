// 登录、项目总览、剧本、场景、角色、分镜视频、音频和剪辑这些模块
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { hasAuthSession } from '@/api/auth'
import { getCreativeWorkflowGates } from '@/api/project'
import { getWorkspaceContext } from '@/lib/context'

declare module 'vue-router' {
  interface RouteMeta {
    guestOnly?: boolean
    requiresAuth?: boolean
    title?: string
    /**
     * 是否由 WorkspaceLayout 自动渲染逻辑父页面返回按钮。
     * 已有自定义页面头部返回操作的页面显式设为 false。
     */
    layoutBack?: boolean
    /**
     * @description 上一个路由的 name（由 beforeEach 注入），
     *              用于 App.vue 的路由过渡方向判断
     */
    fromName?: string
  }
}

const APP_TITLE = '帧心帧意 - AI漫剧制片系统'

function withTitle(title: string): string {
  return `${title} | 帧心帧意`
}

// 整个前端的页面地图。
// 每个 route 对应一个页面组件；meta.requiresAuth 表示必须登录后才能访问。
// 工作台页面都走 /workspace/*，并通过 query 里的 projectId / sceneId / storyboardId 定位上下文。
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    meta: { guestOnly: true, title: '产品介绍' },
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
    path: '/workspace/studio/idea',
    name: 'studio-idea',
    component: () => import('@/views/StudioIdea.vue'),
    meta: { requiresAuth: true, title: '创意输入', layoutBack: false },
  },
  {
    path: '/workspace/studio/script',
    name: 'studio-script',
    component: () => import('@/views/StudioScript.vue'),
    meta: { requiresAuth: true, title: '剧本生成', layoutBack: false },
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
    meta: { requiresAuth: true, title: '角色详情', layoutBack: false },
  },
  {
    path: '/workspace/character/consistency',
    name: 'character-consistency',
    component: () => import('@/views/CharacterConsistency.vue'),
    meta: { requiresAuth: true, title: '角色一致性' },
  },
  {
    path: '/workspace/assets',
    name: 'asset-library',
    component: () => import('@/views/AssetLibrary.vue'),
    meta: { requiresAuth: true, title: '资产库', layoutBack: false },
  },
  {
    path: '/workspace/assets/canvas',
    name: 'asset-canvas',
    component: () => import('@/views/AssetCanvas.vue'),
    meta: { requiresAuth: true, title: '资产画布', layoutBack: false },
  },
  {
    path: '/workspace/storyboard',
    name: 'storyboard-list',
    component: () => import('@/views/StoryboardList.vue'),
    meta: { requiresAuth: true, title: '分镜看板', layoutBack: false },
  },
  {
    path: '/workspace/storyboard/editor',
    name: 'storyboard-editor-legacy',
    redirect: (to) => ({ name: 'storyboard-video-studio', query: to.query }),
  },
  {
    path: '/workspace/audio',
    name: 'audio-studio',
    component: () => import('@/views/AudioStudio.vue'),
    meta: { requiresAuth: true, title: '音频工作台', layoutBack: false },
  },
  {
    path: '/workspace/ai-tasks',
    name: 'ai-task-center',
    component: () => import('@/views/AITaskCenter.vue'),
    meta: { requiresAuth: true, title: '任务中心', layoutBack: false },
  },
  {
    path: '/workspace/market',
    name: 'market-studio',
    component: () => import('@/views/MarketStudio.vue'),
    meta: { requiresAuth: true, title: '市场与实验', layoutBack: false },
  },
  {
    path: '/workspace/production-run',
    name: 'production-run',
    component: () => import('@/views/ProductionRun.vue'),
    meta: { requiresAuth: true, title: '生产运行', layoutBack: false },
  },
  {
    path: '/workspace/story-quality',
    name: 'story-quality',
    component: () => import('@/views/StoryQuality.vue'),
    meta: { requiresAuth: true, title: '故事质量' },
  },
  {
    path: '/workspace/edit',
    name: 'final-edit',
    component: () => import('@/views/FinalEdit.vue'),
    meta: { requiresAuth: true, title: '成片编辑', layoutBack: false },
  },
  {
    path: '/workspace/export',
    name: 'episode-export',
    component: () => import('@/views/Export.vue'),
    meta: { requiresAuth: true, title: '成片导出', layoutBack: false },
  },
  {
    path: '/workspace/studio',
    name: 'production-studio',
    component: () => import('@/views/ProjectStudio.vue'),
    meta: { requiresAuth: true, title: '创作总览', layoutBack: false },
  },
  {
    path: '/workspace/episodes',
    name: 'episode-workbench',
    component: () => import('@/views/EpisodeWorkbench.vue'),
    meta: { requiresAuth: true, title: '分集分镜', layoutBack: false },
  },
  {
    path: '/workspace/episodes/studio',
    name: 'storyboard-video-studio',
    component: () => import('@/views/StoryboardVideoStudio.vue'),
    meta: { requiresAuth: true, title: '分镜视频创作', layoutBack: false },
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
 //登录拦截，如果页面要求登录但没有 token，就跳回登录页。
router.beforeEach(async (to, from) => {
  const authenticated = hasAuthSession()

  // 记录“从哪个页面来”，App.vue 会据此决定页面切换动画方向。
  // 将来源路由 name 注入目标 meta，供 App.vue 决定过渡方向
  if (from.name) {
    to.meta.fromName = from.name as string
  }

  if (to.meta.requiresAuth && !authenticated) {
    // 访问需要登录的页面时，如果本地没有 token，就踢回登录页。
    // redirect 参数用于登录成功后回到原本想访问的页面。
    return {
      path: '/',
      query: to.fullPath !== '/' ? { redirect: to.fullPath } : {},
    }
  }

  if (to.meta.guestOnly && authenticated) {
    // 已登录用户再访问登录/注册页时，直接进入项目总览。
    return '/dashboard'
  }

  const gatedStage = to.name === 'asset-library' || to.name === 'asset-canvas'
    ? 'assets'
    : to.name === 'episode-workbench' || to.name === 'storyboard-video-studio'
      ? 'storyboard'
      : null
  const explicitAssetRecovery = gatedStage === 'assets' && to.query.allowIncomplete === '1'
  if (authenticated && gatedStage && !explicitAssetRecovery) {
    const projectId = Number(to.query.projectId) || getWorkspaceContext()?.projectId || 0
    if (!projectId) return { path: '/dashboard', query: { reason: 'need-project' } }
    try {
      const gates = await getCreativeWorkflowGates(projectId)
      const gate = gates[gatedStage]
      if (!gate.allowed) {
        return {
          path: '/workspace/studio/script',
          query: { projectId: String(projectId), gateReason: gate.reason },
        }
      }
    } catch {
      return {
        path: '/workspace/studio',
        query: { projectId: String(projectId), gateCheckFailed: '1' },
      }
    }
  }

  return true
})

router.afterEach((to) => {
  // 每次路由切换后同步浏览器标签页标题。
  document.title = typeof to.meta.title === 'string' ? withTitle(to.meta.title) : APP_TITLE
})

export default router
