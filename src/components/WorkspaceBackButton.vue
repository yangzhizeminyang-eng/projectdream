<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import { useRouter } from 'vue-router'

const props = defineProps<{
  to: RouteLocationRaw
  label: string
}>()

const router = useRouter()

function goBack(): void {
  void router.push(props.to)
}
</script>

<template>
  <div class="workspace-backbar">
    <button
      class="workspace-back-button"
      type="button"
      :aria-label="label"
      @click="goBack"
    >
      <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
      <span>{{ label }}</span>
    </button>
  </div>
</template>
