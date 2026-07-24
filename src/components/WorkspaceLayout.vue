<script setup lang="ts">
import Inspector from './Inspector.vue'
import SideNav from './SideNav.vue'
import TopNav from './TopNav.vue'

withDefaults(
  defineProps<{
    showSide?: boolean
    showInspector?: boolean
    noPadding?: boolean
    selfManagedScroll?: boolean
  }>(),
  { showSide: true, showInspector: true, noPadding: false, selfManagedScroll: false },
)
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
          'min-h-0 min-w-0 flex-1 bg-background',
          selfManagedScroll ? 'overflow-hidden' : 'overflow-y-auto overscroll-y-contain',
          showSide ? 'lg:ml-[220px]' : '',
          showInspector ? 'xl:mr-[320px]' : '',
          noPadding ? 'overflow-x-hidden' : 'p-margin-md overflow-x-hidden',
        ]"
      >
        <slot />
      </main>
      <Inspector v-if="showInspector" />
    </div>
  </div>
</template>
