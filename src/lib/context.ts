/**
 * @file 项目 / 场景上下文
 * @description 用 sessionStorage 暂存"最近一次访问的项目 / 场景 ID"，
 *              解决"从左侧菜单直接进入 workspace/* 页面"时 URL 缺 query 的问题。
 *              不会持久化到 localStorage，避免跨浏览器状态污染。
 *
 *  写入时机：
 *    - AIScript.vue 加载项目成功
 *    - ScriptEditor.vue 切换 / 加载场景
 *  读取时机：
 *    - SideNav.vue 在跳 /workspace/storyboard 等需要上下文的页面时补 query
 *    - StoryboardList.vue / StoryboardEditor.vue 进入时若 URL 缺 query，尝试用 context 兜底
 */

const STORAGE_KEY = 'pd:workspace-context'

export interface WorkspaceContext {
  projectId: number
  sceneId?: number
  storyboardId?: number
}

interface StoredShape extends WorkspaceContext {
  updatedAt: number
}

/**
 * @description 读取最近一次的项目 / 场景上下文
 * @returns {WorkspaceContext | null} 不存在或数据异常时返回 null
 */
export function getWorkspaceContext(): WorkspaceContext | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredShape
    if (!parsed || typeof parsed.projectId !== 'number' || !Number.isFinite(parsed.projectId)) {
      return null
    }
    return {
      projectId: parsed.projectId,
      sceneId: typeof parsed.sceneId === 'number' && Number.isFinite(parsed.sceneId) ? parsed.sceneId : undefined,
      storyboardId:
        typeof parsed.storyboardId === 'number' && Number.isFinite(parsed.storyboardId)
          ? parsed.storyboardId
          : undefined,
    }
  } catch {
    return null
  }
}

/**
 * @description 写入当前项目 / 场景上下文
 * @param {WorkspaceContext} ctx 上下文
 * @returns {void}
 */
export function setWorkspaceContext(ctx: WorkspaceContext): void {
  try {
    const payload: StoredShape = {
      projectId: ctx.projectId,
      sceneId: ctx.sceneId,
      storyboardId: ctx.storyboardId,
      updatedAt: Date.now(),
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // 静默忽略：sessionStorage 不可用时不影响主流程
  }
}

/**
 * @description 清空上下文（一般不需要调用）
 * @returns {void}
 */
export function clearWorkspaceContext(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // 静默忽略
  }
}
