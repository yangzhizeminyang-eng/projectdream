<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { getCaptchaChallenge, verifyCaptcha } from '@/api/auth'

const props = defineProps<{ phone?: string }>()
const emit = defineEmits<{ (event: 'verified', token: string): void }>()

const challenge = ref('')
const backgroundImage = ref('')
const pieceImage = ref('')
const trackWidth = ref(320)
const imageHeight = ref(120)
const pieceSize = ref(56)
const pieceTop = ref(32)
const position = ref(0)
const loading = ref(false)
const message = ref('点击获取滑块验证')
const maxPosition = computed(() => Math.max(0, trackWidth.value - pieceSize.value))
const pieceStyle = computed(() => ({
  left: `${position.value / Math.max(1, trackWidth.value) * 100}%`,
  top: `${pieceTop.value / imageHeight.value * 100}%`,
  width: `${pieceSize.value / trackWidth.value * 100}%`,
}))
let expiresTimer: number | undefined

async function loadChallenge(): Promise<void> {
  loading.value = true
  message.value = '正在获取验证'
  try {
    const result = await getCaptchaChallenge(props.phone || '')
    challenge.value = result.challenge
    backgroundImage.value = result.backgroundImage
    pieceImage.value = result.pieceImage
    trackWidth.value = result.trackWidth
    imageHeight.value = result.imageHeight
    pieceSize.value = result.pieceSize
    pieceTop.value = result.pieceTop
    position.value = 0
    message.value = '拖动拼图块，对准缺口后验证'
    if (expiresTimer) window.clearTimeout(expiresTimer)
    expiresTimer = window.setTimeout(() => {
      challenge.value = ''
      backgroundImage.value = ''
      pieceImage.value = ''
      message.value = '验证已过期，请重新获取'
    }, Math.max(1000, result.expiresAt - Date.now()))
  } catch (error) {
    message.value = error instanceof Error ? error.message : '验证获取失败'
  } finally {
    loading.value = false
  }
}

async function confirm(): Promise<void> {
  if (!challenge.value || loading.value) return
  loading.value = true
  try {
    const result = await verifyCaptcha(challenge.value, position.value, props.phone || '')
    message.value = '验证通过'
    emit('verified', result.captchaToken)
    challenge.value = ''
    backgroundImage.value = ''
    pieceImage.value = ''
    if (expiresTimer) window.clearTimeout(expiresTimer)
  } catch (error) {
    message.value = error instanceof Error ? error.message : '验证失败，请重试'
  } finally {
    loading.value = false
  }
}

watch(() => props.phone, () => {
  challenge.value = ''
  backgroundImage.value = ''
  pieceImage.value = ''
  position.value = 0
  message.value = '手机号变化，请重新获取验证'
  if (expiresTimer) window.clearTimeout(expiresTimer)
})
onBeforeUnmount(() => {
  if (expiresTimer) window.clearTimeout(expiresTimer)
})
</script>

<template>
  <div class="captcha-slider" aria-live="polite">
    <div class="captcha-slider__head">
      <span>{{ message }}</span>
      <button type="button" :disabled="loading" @click="loadChallenge">
        {{ challenge ? '换一题' : '获取验证' }}
      </button>
    </div>
    <div v-if="challenge" class="captcha-slider__body">
      <div
        class="captcha-slider__track"
        :style="{ aspectRatio: `${trackWidth} / ${imageHeight}` }"
      >
        <img class="captcha-slider__background" :src="backgroundImage" alt="拼图验证背景" draggable="false">
        <img
          class="captcha-slider__piece"
          :src="pieceImage"
          :style="pieceStyle"
          alt=""
          aria-hidden="true"
          draggable="false"
        >
      </div>
      <input
        v-model.number="position"
        type="range"
        min="0"
        :max="maxPosition"
        aria-label="拖动拼图块，对准缺口"
        :aria-valuetext="`拼图位置 ${position}`"
      >
      <button type="button" :disabled="loading" @click="confirm">
        {{ loading ? '验证中' : '验证' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.captcha-slider { display: grid; gap: 8px; margin: 10px 0; color: #625e58; font-size: 12px; }
.captcha-slider__head, .captcha-slider__body { display: flex; align-items: center; gap: 8px; }
.captcha-slider__head span { flex: 1; }
.captcha-slider button { min-height: 32px; border: 1px solid rgba(164, 132, 84, .45); padding: 5px 9px; color: #71430d; background: transparent; cursor: pointer; }
.captcha-slider button:disabled { cursor: not-allowed; opacity: .5; }
.captcha-slider__body { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 10px; }
.captcha-slider__track { position: relative; grid-column: 1 / -1; width: 100%; overflow: hidden; border: 1px solid rgba(218, 209, 184, .32); border-radius: 4px; background: #244c4b; }
.captcha-slider__background { display: block; width: 100%; height: 100%; object-fit: fill; user-select: none; }
.captcha-slider__piece { position: absolute; height: auto; aspect-ratio: 1; pointer-events: none; user-select: none; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .45)); }
.captcha-slider input { width: 100%; min-width: 0; accent-color: #8bc8b2; cursor: grab; }
.captcha-slider input:active { cursor: grabbing; }
.captcha-slider input:focus-visible, .captcha-slider button:focus-visible { outline: 2px solid #8bc8b2; outline-offset: 2px; }
@media (max-width: 360px) { .captcha-slider__body { gap: 6px; } .captcha-slider button { padding-inline: 7px; } }
</style>
