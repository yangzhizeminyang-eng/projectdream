<script setup lang="ts">
/**
 * @file 新建项目
 * @description 这里只建立项目身份。创作参数在创意输入页完成。
 */
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import { createProject } from '@/api/project'

const router = useRouter()

const form = reactive({ name: '阿尔法项目' })
const submitting = ref(false)
const submitError = ref('')

/**
 * @description 创建项目并进入创作总览
 * @returns {Promise<void>}
 */
async function onSubmit() {
  if (submitting.value) return
  submitError.value = ''

  const name = form.name.trim()
  if (!name) {
    submitError.value = '项目名不能为空'
    return
  }

  submitting.value = true
  try {
    const project = await createProject({ name })
    await router.push({
      path: '/workspace/studio',
      query: { projectId: String(project.id), view: 'overview' },
    })
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : '创建项目失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <WorkspaceLayout :show-side="false" :show-inspector="false" :no-padding="true">
    <div class="mx-auto max-w-5xl px-5 py-8 sm:px-8 sm:py-10 lg:px-12 lg:py-12">
      <header class="mb-10 max-w-2xl">
        <h1 class="font-headline-lg text-headline-lg leading-tight text-on-surface">新建项目</h1>
        <p class="mt-3 font-body-md leading-relaxed text-on-surface-variant">
          先建立项目，随后在创作首页完成作品类型、故事愿景、视觉方向和画面规格。
        </p>
      </header>

      <form class="space-y-10" @submit.prevent="onSubmit">
        <section class="border-y border-outline-variant py-8 lg:py-12">
          <label class="mb-3 block text-sm font-semibold text-on-surface" for="project-name">项目名称</label>
          <input
            id="project-name"
            v-model="form.name"
            class="w-full max-w-2xl border border-outline-variant bg-surface-container-lowest px-4 py-4 text-lg text-on-surface outline-none transition-colors placeholder:text-on-surface-variant focus:border-primary focus:ring-1 focus:ring-primary"
            placeholder="给这个项目起个名字"
            type="text"
            autocomplete="off"
          />
          <p class="mt-4 text-sm leading-relaxed text-on-surface-variant">
          创建后先进入创作总览，再按剧本、资产、分镜视频的顺序推进。
          </p>
        </section>

        <div v-if="submitError" class="border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {{ submitError }}
        </div>

        <div class="flex flex-col gap-5 pt-1 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-wrap items-center gap-x-5 gap-y-3">
            <button
              type="button"
              class="text-sm text-on-surface-variant transition-colors hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              :disabled="submitting"
              @click="router.push('/dashboard')"
            >
              取消
            </button>
            <p class="text-xs leading-relaxed text-on-surface-variant">
              项目创建后，所有设定仍可继续调整。
            </p>
          </div>
          <button
            type="submit"
            class="flex items-center justify-center gap-3 bg-primary px-8 py-3 font-semibold text-on-secondary-fixed transition-all hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="submitting"
          >
            <span v-if="!submitting">创建项目</span>
            <span v-else>正在创建</span>
            <span v-if="!submitting" class="material-symbols-outlined text-sm">arrow_forward</span>
            <span v-else class="material-symbols-outlined animate-spin text-sm">progress_activity</span>
          </button>
        </div>
      </form>
    </div>
  </WorkspaceLayout>
</template>
