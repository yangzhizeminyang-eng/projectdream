<!--
  @file PanelFlow 根组件 - 路由过渡编排
  @description 在 <RouterView> 外层包 <Transition> 实现页面间过渡：
                 - Auth 类页面（login/register/forgot/reset）：横向位移 + 淡入淡出
                 - Workspace 类页面（dashboard/workspace/*）：纵向位移 + 轻微 scale + 淡入淡出
                 - mode="out-in"：旧页面先离场（350ms），新页面再进场（450ms）
                 - 配合 Dashboard.vue 内部 stagger 实现"由远及近"的层次感
                 - 支持 prefers-reduced-motion：直接禁用过渡
  @author PanelFlow Studio
-->
<script setup lang="ts">
/**
 * @file <script setup> 段负责根组件的过渡编排逻辑
 */
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'

const route = useRoute()

/**
 * @file 路由分类：
 *        - Auth: 登录/注册/找回密码/重置密码（横向位移，模拟"侧向进入"）
 *        - Workspace: 仪表板/工作台（纵向位移 + 轻微 scale，模拟"向下进入工作空间"）
 */
type PageFamily = 'auth' | 'workspace'

const AUTH_NAMES = new Set(['login', 'register', 'forgot-password', 'reset-password'])

/**
 * @description 判断目标路由所属页面族
 * @param {string} [name] route.name
 * @returns {PageFamily} 'auth' 或 'workspace'
 */
function familyOf(name?: string): PageFamily {
  return name && AUTH_NAMES.has(name) ? 'auth' : 'workspace'
}

/**
 * @description 根据"上一页 → 下一页"决定过渡类名
 * - auth → workspace：登录页向左滑出 + dashboard 从下方淡入
 * - workspace → auth：dashboard 向上方滑出 + 登录页从右侧淡入
 * - 首次加载（appear）：使用 enter-workspace-initial 或 enter-auth-initial
 */
const transitionName = computed(() => {
  const from = familyOf(typeof route.meta.fromName === 'string' ? route.meta.fromName : undefined)
  const to = familyOf(route.name as string | undefined)
  if (from === 'auth' && to === 'workspace') return 'auth-to-workspace'
  if (from === 'workspace' && to === 'auth') return 'workspace-to-auth'
  return to === 'auth' ? 'enter-auth' : 'enter-workspace'
})
</script>

<template>
  <RouterView v-slot="{ Component, route: r }">
    <Transition
      :name="transitionName"
      mode="out-in"
      appear
    >
      <component :is="Component" :key="r.fullPath" />
    </Transition>
  </RouterView>
</template>

<style>
/* ============================================================
 * 路由过渡：Auth ↔ Workspace
 * - out-in 模式：旧页面先完全离场，再让新页面进场
 * - 全部使用 transform + opacity（GPU 加速，避免 layout/paint）
 * - cubic-bezier(0.4, 0, 0.2, 1)：Material 标准缓动，先快后慢
 * ============================================================ */

/* 1. Auth → Workspace（登录页 → 仪表板，最关键路径） */
.auth-to-workspace-enter-active,
.auth-to-workspace-leave-active,
.workspace-to-auth-enter-active,
.workspace-to-auth-leave-active,
.enter-auth-enter-active,
.enter-auth-leave-active,
.enter-workspace-enter-active,
.enter-workspace-leave-active {
  transition:
    opacity 450ms cubic-bezier(0.4, 0, 0.2, 1),
    transform 450ms cubic-bezier(0.4, 0, 0.2, 1);
  will-change: transform, opacity;
}

/* 1.1 旧登录页向左 + 向下淡出（短暂"滑出"，但留出时间感） */
.auth-to-workspace-leave-from {
  opacity: 1;
  transform: translateX(0) scale(1);
}
.auth-to-workspace-leave-to {
  opacity: 0;
  transform: translateX(-3%) scale(0.985);
  filter: blur(2px);
}
.auth-to-workspace-leave-active {
  transition-duration: 280ms;
}

/* 1.2 新 dashboard 从下方 + 淡入 + 轻微 scale（"进入"动效） */
.auth-to-workspace-enter-from {
  opacity: 0;
  transform: translateY(14px) scale(0.992);
}
.auth-to-workspace-enter-to {
  opacity: 1;
  transform: translateY(0) scale(1);
}

/* 2. Workspace → Auth（仪表板 → 登录页，如登出场景） */
.workspace-to-auth-leave-from {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.workspace-to-auth-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.992);
  filter: blur(2px);
}
.workspace-to-auth-leave-active {
  transition-duration: 280ms;
}

.workspace-to-auth-enter-from {
  opacity: 0;
  transform: translateX(4%) scale(0.992);
}
.workspace-to-auth-enter-to {
  opacity: 1;
  transform: translateX(0) scale(1);
}

/* 3. Auth 内部切换（登录 ↔ 注册/找回/重置） */
.enter-auth-enter-from {
  opacity: 0;
  transform: translateX(20px) scale(0.99);
}
.enter-auth-enter-to {
  opacity: 1;
  transform: translateX(0) scale(1);
}
.enter-auth-leave-from {
  opacity: 1;
  transform: translateX(0) scale(1);
}
.enter-auth-leave-to {
  opacity: 0;
  transform: translateX(-20px) scale(0.99);
}

/* 4. Workspace 内部切换（如 dashboard → /workspace/storyboard） */
.enter-workspace-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.995);
}
.enter-workspace-enter-to {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.enter-workspace-leave-from {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.enter-workspace-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.995);
}

/* 5. 减少动效偏好：尊重操作系统"减少动效"设置 */
@media (prefers-reduced-motion: reduce) {
  .auth-to-workspace-enter-active,
  .auth-to-workspace-leave-active,
  .workspace-to-auth-enter-active,
  .workspace-to-auth-leave-active,
  .enter-auth-enter-active,
  .enter-auth-leave-active,
  .enter-workspace-enter-active,
  .enter-workspace-leave-active {
    transition: opacity 0.01ms !important;
    transform: none !important;
  }
  .auth-to-workspace-enter-from,
  .auth-to-workspace-leave-to,
  .workspace-to-auth-enter-from,
  .workspace-to-auth-leave-to,
  .enter-auth-enter-from,
  .enter-auth-leave-to,
  .enter-workspace-enter-from,
  .enter-workspace-leave-to {
    transform: none !important;
    filter: none !important;
  }
}
</style>
