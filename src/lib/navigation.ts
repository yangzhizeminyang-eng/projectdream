import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from 'vue-router'

type BackTarget = {
  to: RouteLocationRaw
  label: string
}

function contextQuery(route: RouteLocationNormalizedLoaded, keys: string[]): Record<string, string> {
  return Object.fromEntries(
    keys
      .map((key) => [key, route.query[key]])
      .filter(([, value]) => typeof value === 'string' && value.trim()),
  ) as Record<string, string>
}

/**
 * Resolve the product's logical parent instead of relying on browser history.
 * A direct URL entry therefore still has a predictable way out.
 */
export function resolveWorkspaceBackTarget(route: RouteLocationNormalizedLoaded): BackTarget | null {
  const query = (keys: string[]) => contextQuery(route, keys)

  if (route.path === '/new' || route.path === '/settings/ai') {
    return { to: '/dashboard', label: '返回项目总览' }
  }

  if (route.path === '/workspace/script/ai') {
    return { to: '/dashboard', label: '返回项目总览' }
  }

  if (route.path === '/workspace/scenes') {
    return {
      to: { path: '/workspace/script/ai', query: query(['projectId']) },
      label: '返回 AI 剧本',
    }
  }

  if (route.path === '/workspace/script') {
    return {
      to: { path: '/workspace/scenes', query: query(['projectId']) },
      label: '返回场景拆解',
    }
  }

  if (route.path.startsWith('/workspace/character/detail') || route.path === '/workspace/character/consistency') {
    return {
      to: { path: '/workspace/character', query: query(['projectId']) },
      label: '返回角色库',
    }
  }

  if (route.path === '/workspace/character') {
    return { to: '/dashboard', label: '返回项目总览' }
  }

  if (route.path === '/workspace/episodes/studio') {
    return {
      to: { path: '/workspace/episodes', query: query(['projectId', 'episodeNo']) },
      label: '返回分集分镜',
    }
  }

  if (route.path === '/workspace/storyboard/editor') {
    return {
      to: { path: '/workspace/episodes', query: query(['projectId', 'episodeNo']) },
      label: '返回分集分镜',
    }
  }

  if (route.path.startsWith('/workspace/storyboard')) {
    return {
      to: { path: '/workspace/scenes', query: query(['projectId']) },
      label: '返回场景拆解',
    }
  }

  if (route.path === '/workspace/assets' || route.path === '/workspace/audio') {
    return { to: '/dashboard', label: '返回项目总览' }
  }

  if (route.path === '/workspace/ai-tasks' || route.path === '/workspace/market' || route.path === '/workspace/story-quality') {
    return { to: '/dashboard', label: '返回项目总览' }
  }

  if (route.path === '/workspace/edit') {
    return {
      to: { path: '/workspace/scenes', query: query(['projectId']) },
      label: '返回场景拆解',
    }
  }

  return null
}
