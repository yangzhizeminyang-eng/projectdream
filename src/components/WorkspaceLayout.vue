<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, type RouteLocationRaw } from 'vue-router'
import Inspector from './Inspector.vue'
import SideNav from './SideNav.vue'
import TopNav from './TopNav.vue'
import WorkspaceBackButton from './WorkspaceBackButton.vue'
import { resolveWorkspaceBackTarget } from '@/lib/navigation'

// 工作台页面的统一壳层：
// 顶部导航固定，左侧菜单和右侧 Inspector 可按页面开关，中间 slot 承载具体业务页面。
// 这样每个页面只关心业务，不需要重复写三栏布局。
const props = withDefaults(
  defineProps<{
    showSide?: boolean
    showInspector?: boolean
    noPadding?: boolean
    selfManagedScroll?: boolean
    backTo?: RouteLocationRaw | null
    backLabel?: string
  }>(),
  {
    showSide: true,
    showInspector: true,
    noPadding: false,
    selfManagedScroll: false,
    backTo: undefined,
    backLabel: undefined,
  },
)

const route = useRoute()
const logicalBack = computed(() => resolveWorkspaceBackTarget(route))
const shouldShowBack = computed(
  () => route.meta.layoutBack !== false && Boolean(props.backTo || logicalBack.value),
)
const resolvedBackTo = computed(() => props.backTo || logicalBack.value?.to || null)
const resolvedBackLabel = computed(() => props.backLabel || logicalBack.value?.label || '返回上一级')
</script>

<template>
  <div class="flex h-screen h-[100dvh] flex-col overflow-hidden">
    <TopNav />
    <div class="flex min-h-0 flex-1 pt-[64px]">
      <SideNav v-if="showSide" />
      <!--
        主滚动容器：scroll-optimized 触发 GPU 合成
        - min-w-0: 防止 flex 子项因内容最小尺寸撑破布局
        - overscroll-behavior: 防止滚动穿透到 body
        - contain: 隔离绘制范围
      -->
      <main
        :class="[
          'workspace-main flex min-h-0 min-w-0 flex-1 flex-col bg-background',
          selfManagedScroll ? 'overflow-hidden' : 'overflow-y-auto overscroll-y-contain',
          showSide ? 'lg:ml-[220px]' : '',
          showInspector ? 'xl:mr-[320px]' : '',
          noPadding ? 'overflow-x-hidden' : 'p-margin-md overflow-x-hidden',
        ]"
      >
        <WorkspaceBackButton
          v-if="shouldShowBack && resolvedBackTo"
          :to="resolvedBackTo"
          :label="resolvedBackLabel"
        />
        <template v-if="selfManagedScroll">
          <div class="workspace-slot flex min-h-0 flex-1 flex-col">
            <slot />
          </div>
        </template>
        <slot v-else />
      </main>
      <Inspector v-if="showInspector" />
    </div>
  </div>
</template>
