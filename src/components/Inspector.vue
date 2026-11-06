<script setup lang="ts">
import { ref } from 'vue'

interface PendingTask {
  id: number
  name: string
  status: '进行中' | '排队中' | '暂停'
  progress: number
  remaining: string
}

interface Message {
  role: 'System' | 'Project Manager' | 'You'
  text: string
}

const tasks = ref<PendingTask[]>([
  { id: 1, name: '镜头渲染：SH_012', status: '进行中', progress: 72, remaining: '剩余 4 分钟' },
  { id: 2, name: 'AI 动作捕捉优化', status: '排队中', progress: 0, remaining: '等待资产：主角_跑动_02' },
  { id: 3, name: '4K 素材转码', status: '暂停', progress: 0, remaining: '手动挂起' },
])

const messages = ref<Message[]>([
  { role: 'System', text: '检测到场次 04 的对比度偏低，是否自动套用高反差夜景预设？' },
  { role: 'Project Manager', text: '正在分析序列 04 的节奏点和镜头衔接。' },
])

const input = ref('')
const diskUsed = 60

function sendMsg() {
  // Inspector 目前是本地演示状态，输入内容只追加到右侧消息列表，
  // 尚未接入真实 AI 对话接口。
  const value = input.value.trim()
  if (!value) return
  messages.value.push({ role: 'You', text: value })
  input.value = ''
}
</script>

<template>
  <aside class="fixed bottom-0 right-0 top-[64px] z-40 hidden w-[320px] flex-col border-l border-outline-variant bg-surface-container-low p-4 xl:flex">
    <div class="mb-6">
      <h2 class="mb-4 flex items-center gap-2 font-label-md text-sm uppercase tracking-[0.2em] text-primary">
        <span class="material-symbols-outlined">pending_actions</span>
        待处理任务（{{ tasks.length }}）
      </h2>
      <div class="space-y-3">
        <article
          v-for="task in tasks"
          :key="task.id"
          class="relative border border-outline-variant bg-surface-charcoal p-3"
        >
          <div class="mb-2 flex items-start justify-between gap-3">
            <span class="text-sm text-white">{{ task.name }}</span>
            <span
              class="text-[10px]"
              :class="task.status === '进行中' ? 'text-primary' : 'text-on-surface-variant'"
            >
              {{ task.status }}
            </span>
          </div>
          <div v-if="task.progress > 0" class="h-1 w-full bg-surface-container">
            <div class="h-full animate-pulse bg-primary" :style="`width: ${task.progress}%;`"></div>
          </div>
          <div class="mt-2 flex items-center justify-between">
            <span class="text-[10px] text-on-surface-variant">{{ task.remaining }}</span>
            <button
              aria-label="取消任务"
              class="material-symbols-outlined text-xs text-on-surface-variant transition-colors hover:text-danger-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              type="button"
            >
              cancel
            </button>
          </div>
        </article>
      </div>
    </div>

    <div class="mb-6 flex flex-1 flex-col">
      <h2 class="mb-4 flex items-center gap-2 font-label-md text-sm uppercase tracking-[0.2em] text-primary">
        <span class="material-symbols-outlined">chat_bubble</span>
        AI 制作助手
      </h2>
      <div class="scroll-optimized mb-3 flex-1 overflow-y-auto overscroll-y-contain border border-outline-variant bg-surface-container-lowest p-3 no-scrollbar">
        <div v-for="(message, index) in messages" :key="index" class="mb-3">
          <div
            class="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em]"
            :class="message.role === 'System' ? 'text-primary' : 'text-on-surface-variant'"
          >
            {{ message.role }}
          </div>
          <div
            class="border-l border-primary p-2 text-xs"
            :class="
              message.role === 'System'
                ? 'bg-surface-charcoal text-on-surface'
                : 'italic text-on-surface-variant'
            "
          >
            {{ message.text }}
          </div>
        </div>
      </div>
      <div class="relative">
        <input
          v-model="input"
          class="w-full border border-outline-variant bg-surface-charcoal py-2 pl-3 pr-10 text-xs transition-all focus:border-primary focus:ring-0"
          placeholder="输入给助手的指令..."
          type="text"
          @keyup.enter="sendMsg"
        />
        <button
          aria-label="发送消息"
          class="material-symbols-outlined absolute right-3 top-1/2 -translate-y-1/2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="sendMsg"
        >
          send
        </button>
      </div>
    </div>

    <div class="border-t border-outline-variant pt-4">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-[10px] text-on-surface-variant">磁盘空间（NVMe）</span>
        <span class="text-[10px] text-on-surface-variant">1.2 TB / 2.0 TB</span>
      </div>
      <div class="h-1 w-full bg-surface-container">
        <div class="h-full bg-on-surface-variant" :style="`width: ${diskUsed}%;`"></div>
      </div>
    </div>
  </aside>
</template>
