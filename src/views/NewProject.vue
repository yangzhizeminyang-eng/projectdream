<script setup lang="ts">
/**
 * @file 新建项目配置页
 * @description 用户填写项目元信息（题材/时长/世界观/视觉风格/画幅），提交后调用
 *              createProject 创建项目，跳转到 /workspace/script/ai?projectId=xxx。
 */
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import { createProject } from '@/api/project'

const router = useRouter()

const form = reactive({
  name: '阿尔法项目',
  category: '科幻剧情片',
  targetDuration: 120,
  narrativeVision:
    '这是一部赛博都市寓言。在被数字霓虹吞没的不夜城里，情感成了最后一种不可复制的违禁品。主角作为记忆清算员，在回收废弃意识的过程中，意外触碰到足以撼动整座城市底层秩序的旧秘密。',
  visualStyle: '黑色电影风格',
  aspectRatio: '2.39:1',
})

const tags = ['Cyberpunk', 'Allegory', 'Dystopian']
const engine = '电影画面 V3 引擎'

const aspectImage =
  'https://lh3.googleusercontent.com/aida-public/AB6AXuDHU3XX9DE6g_J8mCdRDpXYclxkJeg2h_rT-MCq13hf4sB8k7wAsxBRLfH5SilyEfGQRdVbFGlkyru1-lmBaGjJQmZ2Lopxv-mmIa-K-jj8X4Qha3C-UQ37ckJ_3epcsp1_raYj-UDZh_szIIlwKOKNMkHUN9U1NNe235TA5ooUI2rcVWdsIV-Qb7QB61jUZwrz2GU1VZdqHx2XpjJOupWHnz9SDOpavckfIApD7WrVQMJOmVVoCxTgtg'
const aspectAlt = '电影宽银幕构图参考图。'
const referenceImage =
  'https://lh3.googleusercontent.com/aida-public/AB6AXuAKWcJo4xkGi3A_AWZDKxhrLmzjqjtQmT4E9PS-8YYsPZUHuk2P1ExDwBghHKEWPCdx7IgVpX9clP_ELgV8G5gNDbvYwIhOuADhu4sEgAwDCpOiamSX8wtu1RpnFch1b_r7d3wWHPcXAP-v-DTjPnxVs_5r9Fi8X9KL5qwhSUyO-OgxJJ1rO10mxwsaDK3VZcG0--sneDWFeRva0KNbsOk-OWOzoIVM5ZdqV_rz6oZDxMbl5srVJ--NfQ'
const referenceAlt = '暗调风格参考图。'

const categories = ['科幻剧情片', '黑色电影', '实验动画', '都市寓言']

const reelThumbnails = [
  'https://lh3.googleusercontent.com/aida-public/AB6AXuA625yyN2PehN8zTlLfl84JB_1sZrmJ1g81ZXJkgs-KfZpLtL0VPnfzW7r1bq4MvK-7REjE0cAFm4cDODl3gmEStXcIUQYqE8tUGXVwQG_geFybSY3uM6CfxaEi-xQtxmh7OUkHi2WsnmCx10-Nc62SMgM28XaGVGnDJyD5yELGh7hkLVGfrgvm06xIVBNnEuYk13CnzOHh8EnQQOtwBeUAuC4C1MWpH_JEOEt-xIEgGbD8xA8Ur_b8-Q',
]

const submitting = ref(false)
const submitError = ref('')

/**
 * @description 提交项目：调 createProject，跳到 AI 剧本页
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
    const project = await createProject({
      name,
      category: form.category,
      targetDuration: Number(form.targetDuration) || 60,
      narrativeVision: form.narrativeVision,
      visualStyle: form.visualStyle,
      aspectRatio: form.aspectRatio,
    })
    await router.push({
      path: '/workspace/script/ai',
      query: { projectId: String(project.id) },
    })
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : '创建项目失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <div class="mx-auto max-w-5xl px-12 py-12">
      <div class="mb-12 border-l-4 border-primary pl-6">
        <h1 class="mb-2 font-headline-lg text-headline-lg text-on-surface">新建项目配置</h1>
        <p class="font-body-md text-on-surface-variant">
          定义项目的叙事边界与视觉规格，系统会基于这些配置初始化整套 AI 创作工作流。
        </p>
      </div>

      <div class="grid grid-cols-12 gap-gutter border border-outline-variant bg-outline-variant">
        <div class="col-span-12 bg-surface-charcoal p-8 lg:col-span-8">
          <div class="space-y-8">
            <div>
              <label class="mb-3 block font-label-md text-label-md uppercase tracking-tighter text-primary">
                项目名称 / Project Name
              </label>
              <input
                v-model="form.name"
                class="paper-texture w-full border-none px-4 py-3 font-body-lg text-body-lg focus:ring-1 focus:ring-primary"
                placeholder="输入项目代号..."
                type="text"
              />
            </div>

            <div class="grid grid-cols-2 gap-8">
              <div>
                <label class="mb-3 block font-label-md text-label-md uppercase tracking-tighter text-primary">
                  作品类型 / Category
                </label>
                <select
                  v-model="form.category"
                  class="paper-texture w-full appearance-none border-none px-4 py-3 font-body-md text-body-md"
                >
                  <option v-for="opt in categories" :key="opt" :value="opt">{{ opt }}</option>
                </select>
              </div>
              <div>
                <label class="mb-3 block font-label-md text-label-md uppercase tracking-tighter text-primary">
                  默认引擎 / Engine
                </label>
                <div class="paper-texture flex items-center gap-2 px-4 py-3">
                  <span class="material-symbols-outlined text-sm">precision_manufacturing</span>
                  <span class="font-body-md text-body-md">{{ engine }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="col-span-12 flex flex-col justify-between bg-surface-container-high p-8 lg:col-span-4">
          <div>
            <label class="mb-6 block font-label-md text-label-md uppercase tracking-tighter text-primary">
              画幅比例 / Aspect Ratio
            </label>
            <div class="group relative cursor-pointer border border-outline bg-surface-charcoal p-4 transition-all hover:border-primary">
              <div class="mb-2 aspect-[2.39/1] overflow-hidden bg-outline-variant">
                <div
                  class="h-full w-full bg-cover bg-center opacity-30"
                  :style="`background-image: url('${aspectImage}')`"
                  :data-alt="aspectAlt"
                ></div>
                <div class="absolute inset-0 flex items-center justify-center">
                  <span class="font-display-lg text-headline-md text-on-surface">{{ form.aspectRatio }}</span>
                </div>
              </div>
              <div class="text-center font-label-sm text-label-sm text-on-surface-variant">电影宽银幕</div>
            </div>
          </div>

          <div class="mt-8">
            <label class="mb-3 block font-label-md text-label-md uppercase tracking-tighter text-primary">
              目标时长 / Target Duration
            </label>
            <div class="flex items-end gap-2">
              <input
                v-model.number="form.targetDuration"
                class="paper-texture w-24 border-none px-4 py-3 text-center font-display-lg text-headline-md"
                type="number"
                min="1"
              />
              <span class="mb-3 font-label-md text-label-md text-on-surface-variant">分钟 / MINS</span>
            </div>
          </div>
        </div>

        <div class="col-span-12 bg-surface-charcoal p-8 lg:col-span-7">
          <label class="mb-4 block font-label-md text-label-md uppercase tracking-tighter text-primary">
            故事愿景 / Narrative Vision
          </label>
          <textarea
            v-model="form.narrativeVision"
            class="paper-texture w-full resize-none border-none p-6 font-body-md text-body-md leading-relaxed"
            placeholder="描述核心冲突与世界观..."
            rows="8"
          ></textarea>
          <div class="mt-4 flex gap-2">
            <span
              v-for="tag in tags"
              :key="tag"
              class="border border-outline bg-surface-variant px-2 py-1 text-[10px] uppercase text-on-surface-variant"
            >
              {{ tag }}
            </span>
          </div>
        </div>

        <div class="col-span-12 flex flex-col border-l border-outline-variant bg-surface-charcoal lg:col-span-5">
          <div class="p-8 pb-4">
            <label class="mb-4 block font-label-md text-label-md uppercase tracking-tighter text-primary">
              视觉风格锚点 / Visual Anchor
            </label>
            <div class="flex items-center gap-4 border border-primary bg-primary/5 p-4">
              <span class="material-symbols-outlined text-primary" style="font-variation-settings: 'FILL' 1;">movie_filter</span>
              <div>
                <div class="font-label-md text-label-md text-on-surface">
                  <input
                    v-model="form.visualStyle"
                    class="w-full border-none bg-transparent p-0 text-on-surface focus:ring-0"
                    type="text"
                  />
                </div>
                <div class="text-[10px] text-on-surface-variant">高反差、硬光照明、克制构图</div>
              </div>
            </div>
          </div>

          <div class="group relative flex-1 overflow-hidden">
            <div
              class="absolute inset-0 bg-cover bg-center transition-transform duration-700 group-hover:scale-110"
              :style="`background-image: url('${referenceImage}')`"
              :data-alt="referenceAlt"
            ></div>
            <div class="noir-gradient absolute inset-0"></div>
            <div class="absolute bottom-6 left-8">
              <div class="mb-1 font-label-sm text-label-sm text-primary">参考预览</div>
              <div class="font-display-lg text-headline-md text-on-surface opacity-80">明暗对照</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="submitError" class="mt-6 border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
        {{ submitError }}
      </div>

      <div class="mt-12 flex items-center justify-between border-t border-outline-variant pt-8">
        <div class="flex gap-4">
          <button
            type="button"
            class="border border-outline px-8 py-3 font-label-md text-label-md text-on-surface-variant transition-all hover:bg-surface-variant"
            :disabled="submitting"
            @click="router.push('/dashboard')"
          >
            取消 / CANCEL
          </button>
          <button
            type="button"
            class="border border-outline px-8 py-3 font-label-md text-label-md text-on-surface-variant transition-all hover:bg-surface-variant"
            :disabled="submitting"
          >
            导入配置
          </button>
        </div>
        <button
          type="button"
          class="flex items-center gap-3 bg-primary px-12 py-3 font-label-md text-label-md font-bold text-on-secondary-fixed transition-all hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="submitting"
          @click="onSubmit"
        >
          <span v-if="!submitting">开始创建项目</span>
          <span v-else>正在创建...</span>
          <span v-if="!submitting" class="material-symbols-outlined text-sm">arrow_forward</span>
          <span v-else class="material-symbols-outlined animate-spin text-sm">progress_activity</span>
        </button>
      </div>
    </div>

    <footer class="flex h-24 overflow-x-hidden border-t border-outline-variant bg-surface-container-lowest">
      <div class="flex h-full shrink-0 items-center border-r border-outline-variant bg-surface-charcoal px-6">
        <span class="rotate-180 font-label-sm text-label-sm uppercase text-on-surface-variant" style="writing-mode: vertical-rl;">
          创作底片带
        </span>
      </div>
      <div class="flex flex-1 gap-gutter bg-outline-variant">
        <div class="relative flex h-full w-48 cursor-pointer items-center justify-center overflow-hidden bg-surface-charcoal">
          <div
            class="absolute inset-0 bg-cover opacity-20 grayscale"
            :style="`background-image: url('${reelThumbnails[0]}')`"
            :data-alt="'建筑局部参考图'"
          ></div>
          <span class="material-symbols-outlined text-outline transition-colors group-hover:text-primary">add_box</span>
        </div>
        <div
          v-for="index in 4"
          :key="index"
          class="flex h-full w-48 items-center justify-center bg-surface-charcoal opacity-40"
        >
          <div class="mx-8 h-1 w-full bg-outline-variant"></div>
        </div>
      </div>
    </footer>
  </WorkspaceLayout>
</template>
