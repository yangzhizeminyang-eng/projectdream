<!--
  @file PanelFlow 登录页 - 手机号 + 密码登录
  @description 基于 stitch_panelflow_creative_studio/pf_00_1/code.html 重构：
                 - 品牌区由 <BrandPanel> 公共组件渲染（58/42 + 三段式 + 装饰大数字 01）
                 - 表单区 42% 紧凑布局，含 shimmer 提交动画、帮助/接口/状态次级链接
                 - 多视口响应式（375/768/1024/1280/1440/1920）
                 - 优化：
                   * 1024-1280 视口下 brand-content 紧凑布局，meta 改 2 列
                   * 表单区焦点光晕、card 微光、移动端呼吸节奏
                   * 装饰邮戳 auth-tag 在窄屏自适应
  @author PanelFlow Studio
-->
<script setup lang="ts">
/**
 * @file <script setup> 段负责登录页交互逻辑
 */
import { computed, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { loginWithPassword, saveAuthSession } from '@/api/auth'
import BrandPanel from '@/components/BrandPanel.vue'

const router = useRouter()

/** 表单状态：手机号 / 密码 / 显示密码 / 提交中 */
const phone = ref('')
const password = ref('')
const showPassword = ref(false)
const submitting = ref(false)
const errorMessage = ref('')

const phoneError = ref('')
const passwordError = ref('')

/**
 * @description 微信扫码模态状态：
 *  - showWechatModal: 是否展示模态框
 *  - wechatScanning: 扫码进行中（仅影响提示文案）
 *  - wechatCountdown: 倒计时秒数（每 1s 减 1；归零时切换扫描状态）
 *  - wechatQrTick: 二维码占位动画 tick（每 600ms 切换，给"扫描线"感）
 */
const showWechatModal = ref(false)
const wechatScanning = ref(true)
const wechatCountdown = ref(120)
const wechatQrTick = ref(0)
let wechatTimer: number | undefined
let wechatQrTimer: number | undefined

/**
 * @description 规范化手机号：仅保留数字、最长 11 位
 * @param {string} value 原始输入
 * @returns {string} 规范化后的手机号
 */
function normalizePhone(value: string): string {
  return value.replace(/\D/g, '').slice(0, 11)
}

/**
 * @description 将 11 位手机号格式化为 3-4-4 段
 * @param {string} value 原始输入
 * @returns {string} 格式化后的展示文本
 */
function formatPhone(value: string): string {
  const normalized = normalizePhone(value)
  return normalized.replace(/^(\d{0,3})(\d{0,4})(\d{0,4}).*$/, (_, a: string, b: string, c: string) =>
    [a, b, c].filter(Boolean).join(' '),
  )
}

/**
 * @description 处理手机号输入：格式化 + 清错
 * @param {string} value 原始输入
 * @returns {void}
 */
function onPhoneInput(value: string): void {
  phone.value = formatPhone(value)
  phoneError.value = ''
  errorMessage.value = ''
}

/**
 * @description 处理密码输入：清错
 * @returns {void}
 */
function onPasswordInput(): void {
  passwordError.value = ''
  errorMessage.value = ''
}

/**
 * @description 提交登录：前端校验 → API 调用 → 跳转 dashboard
 * @param {Event} e 表单事件
 * @returns {Promise<void>}
 */
async function handleLogin(e: Event): Promise<void> {
  e.preventDefault()
  if (submitting.value) return

  const phoneNumber = normalizePhone(phone.value)
  if (!/^1\d{10}$/.test(phoneNumber)) {
    phoneError.value = '请输入正确的 11 位手机号'
    return
  }
  if (password.value.length < 6) {
    passwordError.value = '密码至少 6 位'
    return
  }

  errorMessage.value = ''
  submitting.value = true

  try {
    const result = await loginWithPassword(phoneNumber, password.value)
    saveAuthSession(result)
    router.push('/dashboard')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '登录失败，请重试'
  } finally {
    submitting.value = false
  }
}

/**
 * @description 跳到忘记密码：保留当前输入的手机号
 * @returns {void}
 */
function goForgot(): void {
  const phoneNumber = normalizePhone(phone.value)
  router.push({ path: '/forgot-password', query: phoneNumber ? { phone: phoneNumber } : {} })
}

/**
 * @description 跳到注册
 * @returns {void}
 */
function goRegister(): void {
  router.push('/register')
}

/**
 * @description 打开微信扫码模态，启动倒计时 + 二维码扫描线动画
 * @returns {void}
 */
function openWechatModal(): void {
  if (showWechatModal.value) return
  showWechatModal.value = true
  wechatScanning.value = true
  wechatCountdown.value = 120
  wechatQrTick.value = 0
  wechatTimer = window.setInterval(() => {
    if (wechatCountdown.value > 0) {
      wechatCountdown.value -= 1
    } else {
      wechatScanning.value = false
    }
  }, 1000)
  wechatQrTimer = window.setInterval(() => {
    wechatQrTick.value = (wechatQrTick.value + 1) % 100
  }, 600)
}

/**
 * @description 关闭微信扫码模态，清理定时器
 * @returns {void}
 */
function closeWechatModal(): void {
  showWechatModal.value = false
  if (wechatTimer) {
    window.clearInterval(wechatTimer)
    wechatTimer = undefined
  }
  if (wechatQrTimer) {
    window.clearInterval(wechatQrTimer)
    wechatQrTimer = undefined
  }
}

/**
 * @description 倒计时格式化为 mm:ss
 * @param {number} sec 剩余秒数
 * @returns {string} 格式化后的时间字符串
 */
function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m.toString().padStart(1, '0')}:${s.toString().padStart(2, '0')}`
}

/** 提交按钮可用性：手机号 11 位 + 密码 6 位以上 + 不在提交中 */
const canSubmit = computed(() => {
  if (submitting.value) return false
  return normalizePhone(phone.value).length === 11 && password.value.length >= 6
})

/**
 * @description 组件卸载时清理微信扫码定时器，防止内存泄漏
 * @returns {void}
 */
onUnmounted(() => {
  if (wechatTimer) {
    window.clearInterval(wechatTimer)
    wechatTimer = undefined
  }
  if (wechatQrTimer) {
    window.clearInterval(wechatQrTimer)
    wechatQrTimer = undefined
  }
})
</script>

<template>
  <main class="auth-shell" aria-label="PanelFlow 登录">
    <!-- 左侧品牌区 7/12（≥1024 显示），公共组件 -->
    <BrandPanel episode="01" label="登录" />

    <!-- 右侧表单区 5/12 -->
    <section class="form-panel" aria-label="登录录入">
      <div class="paper-texture" aria-hidden="true"></div>

      <div class="auth-card">
        <!-- 装饰邮戳 -->
        <div class="auth-tag" aria-hidden="true">创作入口 · 版本 2.0</div>

        <!-- 移动端品牌字（<1024 显示） -->
        <div class="mobile-brand" aria-hidden="true">
          <span class="mobile-brand-mark">
            <span class="material-symbols-outlined">movie_filter</span>
          </span>
          <h2>PanelFlow</h2>
        </div>

        <header class="auth-header">
          <span class="auth-eyebrow">登录</span>
          <h1 class="auth-title">欢迎登录</h1>
          <p class="auth-sub">请输入手机号和密码进入创作平台</p>
        </header>

        <form class="auth-form" @submit="handleLogin" novalidate>
          <!-- 手机号 -->
          <label class="field">
            <span class="field-label">手机号</span>
            <div class="field-box" :class="{ 'field-box-error': phoneError, 'field-box-focus': !phoneError }">
              <input
                :value="phone"
                type="text"
                inputmode="tel"
                autocomplete="tel"
                placeholder="138 0000 0000"
                maxlength="13"
                @input="onPhoneInput(($event.target as HTMLInputElement).value)"
              />
              <span class="material-symbols-outlined field-icon">smartphone</span>
            </div>
            <p v-if="phoneError" class="error-text">
              <span class="material-symbols-outlined">error</span>
              <span>{{ phoneError }}</span>
            </p>
          </label>

          <!-- 密码 -->
          <label class="field">
            <div class="field-row">
              <span class="field-label">登录密码</span>
              <button type="button" class="forgot-link" @click="goForgot">忘记密码？</button>
            </div>
            <div class="field-box" :class="{ 'field-box-error': passwordError }">
              <input
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="请输入密码（至少 6 位）"
                @input="onPasswordInput"
              />
              <button
                type="button"
                class="icon-button"
                :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                @click="showPassword = !showPassword"
              >
                <span class="material-symbols-outlined">
                  {{ showPassword ? 'visibility' : 'visibility_off' }}
                </span>
              </button>
            </div>
            <p v-if="passwordError" class="error-text">
              <span class="material-symbols-outlined">error</span>
              <span>{{ passwordError }}</span>
            </p>
          </label>

          <p v-if="errorMessage" class="error-text error-text--top">
            <span class="material-symbols-outlined">error</span>
            <span>{{ errorMessage }}</span>
          </p>

          <button
            type="submit"
            class="submit-button"
            :class="{ 'is-loading': submitting }"
            :disabled="!canSubmit"
          >
            <span v-if="submitting" class="spinner" aria-hidden="true"></span>
            <span class="submit-text">{{ submitting ? '登录中…' : '立即登录' }}</span>
            <span v-if="!submitting" class="material-symbols-outlined submit-arrow" aria-hidden="true">arrow_forward</span>
            <span v-if="submitting" class="shimmer" aria-hidden="true"></span>
          </button>
        </form>

        <!-- 微信扫码登录：与主登录区形成层次分明的次级入口 -->
        <div class="wechat-divider" aria-hidden="true">
          <span class="wechat-divider-line"></span>
          <span class="wechat-divider-text">或使用微信扫码登录</span>
          <span class="wechat-divider-line"></span>
        </div>

        <button
          type="button"
          class="wechat-button"
          aria-label="使用微信扫码登录"
          @click="openWechatModal"
        >
          <span class="wechat-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" focusable="false">
              <path d="M8.69 4C4.99 4 2 6.5 2 9.6c0 1.74 1 3.3 2.6 4.36L4 16.5l2.6-1.36c.62.18 1.27.28 1.95.28.27 0 .54-.02.81-.05-.16-.5-.26-1.02-.26-1.56 0-3.18 3.05-5.76 6.81-5.76.24 0 .47.01.7.04C16.04 5.66 12.66 4 8.69 4Zm-2.5 3.5a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7Zm5 0a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7Z"/>
              <path d="M22 14.5c0-2.55-2.5-4.6-5.5-4.6s-5.5 2.05-5.5 4.6c0 2.55 2.5 4.6 5.5 4.6.6 0 1.18-.07 1.72-.21L20 20l-.4-1.7c1.45-.86 2.4-2.2 2.4-3.8Zm-7.3-1.4a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Zm3.6 0a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z"/>
            </svg>
          </span>
          <span class="wechat-text">微信扫码登录</span>
          <span class="material-symbols-outlined wechat-arrow" aria-hidden="true">qr_code_2</span>
        </button>

        <footer class="auth-footer">
          <p>
            没有账号？
            <button type="button" class="link-button" @click="goRegister">立即注册</button>
          </p>
        </footer>

        <!-- 次级链接 -->
        <nav class="meta-links" aria-label="次级链接">
          <a class="meta-link" href="javascript:void(0)">帮助</a>
          <span class="meta-sep" aria-hidden="true">·</span>
          <a class="meta-link" href="javascript:void(0)">接口</a>
          <span class="meta-sep" aria-hidden="true">·</span>
          <a class="meta-link" href="javascript:void(0)">片场状态</a>
        </nav>
      </div>
    </section>

    <!-- 微信扫码模态：Teleport 到 body 之外避免被父容器 transform 影响定位 -->
    <Teleport to="body">
      <Transition name="wechat-modal">
        <div
          v-if="showWechatModal"
          class="wechat-modal-root"
          role="dialog"
          aria-modal="true"
          aria-labelledby="wechat-modal-title"
          @click.self="closeWechatModal"
          @keydown.esc="closeWechatModal"
        >
          <div class="wechat-modal-backdrop" aria-hidden="true"></div>
          <div class="wechat-modal-card">
            <button
              type="button"
              class="wechat-modal-close"
              aria-label="关闭扫码"
              @click="closeWechatModal"
            >
              <span class="material-symbols-outlined" aria-hidden="true">close</span>
            </button>

            <header class="wechat-modal-head">
              <span class="wechat-modal-eyebrow">微信扫码</span>
              <h2 id="wechat-modal-title" class="wechat-modal-title">
                <span class="wechat-modal-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" focusable="false">
                    <path d="M8.69 4C4.99 4 2 6.5 2 9.6c0 1.74 1 3.3 2.6 4.36L4 16.5l2.6-1.36c.62.18 1.27.28 1.95.28.27 0 .54-.02.81-.05-.16-.5-.26-1.02-.26-1.56 0-3.18 3.05-5.76 6.81-5.76.24 0 .47.01.7.04C16.04 5.66 12.66 4 8.69 4Zm-2.5 3.5a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7Zm5 0a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7Z"/>
                    <path d="M22 14.5c0-2.55-2.5-4.6-5.5-4.6s-5.5 2.05-5.5 4.6c0 2.55 2.5 4.6 5.5 4.6.6 0 1.18-.07 1.72-.21L20 20l-.4-1.7c1.45-.86 2.4-2.2 2.4-3.8Zm-7.3-1.4a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Zm3.6 0a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z"/>
                  </svg>
                </span>
                <span>微信扫码登录</span>
              </h2>
              <p class="wechat-modal-sub">打开微信扫一扫，完成授权即可登录</p>
            </header>

            <div class="wechat-modal-qr">
              <!-- QR 装饰：四角 + 中心 logo + 扫描线 -->
              <div class="qr-frame" aria-hidden="true">
                <span class="qr-corner qr-corner-tl"></span>
                <span class="qr-corner qr-corner-tr"></span>
                <span class="qr-corner qr-corner-bl"></span>
                <span class="qr-corner qr-corner-br"></span>
                <div class="qr-grid" :style="`--qr-tick: ${wechatQrTick}`">
                  <span v-for="n in 64" :key="n" class="qr-cell" :data-bit="(n * 7 + wechatQrTick) % 11 < 5 ? 1 : 0"></span>
                </div>
                <div class="qr-scanline" aria-hidden="true"></div>
                <div class="qr-logo" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor" focusable="false">
                    <path d="M8.69 4C4.99 4 2 6.5 2 9.6c0 1.74 1 3.3 2.6 4.36L4 16.5l2.6-1.36c.62.18 1.27.28 1.95.28.27 0 .54-.02.81-.05-.16-.5-.26-1.02-.26-1.56 0-3.18 3.05-5.76 6.81-5.76.24 0 .47.01.7.04C16.04 5.66 12.66 4 8.69 4Zm-2.5 3.5a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7Zm5 0a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7Z"/>
                    <path d="M22 14.5c0-2.55-2.5-4.6-5.5-4.6s-5.5 2.05-5.5 4.6c0 2.55 2.5 4.6 5.5 4.6.6 0 1.18-.07 1.72-.21L20 20l-.4-1.7c1.45-.86 2.4-2.2 2.4-3.8Zm-7.3-1.4a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Zm3.6 0a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z"/>
                  </svg>
                </div>
              </div>
            </div>

            <footer class="wechat-modal-foot">
              <p class="wechat-modal-status" :class="{ 'is-expired': !wechatScanning }">
                <span class="status-dot" aria-hidden="true"></span>
                <span v-if="wechatScanning">
                  二维码有效 · 剩余 <strong>{{ formatCountdown(wechatCountdown) }}</strong>
                </span>
                <span v-else>二维码已过期，请点击刷新</span>
              </p>
              <div class="wechat-modal-actions">
                <button
                  v-if="!wechatScanning"
                  type="button"
                  class="wechat-modal-refresh"
                  @click="openWechatModal"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
                  <span>刷新二维码</span>
                </button>
                <button
                  type="button"
                  class="wechat-modal-cancel"
                  @click="closeWechatModal"
                >
                  取消
                </button>
              </div>
            </footer>
          </div>
        </div>
      </Transition>
    </Teleport>
  </main>
</template>

<style scoped>
/* =====================================================================
 * 登录页 - Darkroom Professional
 *  - 品牌区已抽出到 <BrandPanel>，本文件仅保留：外层 + 表单区 + 响应式
 *  - 优化：响应式断点细化、field 聚焦反馈、card 微光
 * ===================================================================== */

.auth-shell {
  --color-bg: #121412;
  --color-surface: #0d0f0d;
  --color-charcoal: #1B1C1A;
  --color-text: #e3e3df;
  --color-text-soft: #dbc2b0;
  --color-text-mute: #a38c7c;
  --color-text-faint: #8f877d;
  --color-primary: #ffb77d;
  --color-primary-strong: #d97706;
  --color-primary-hover: #f59e0b;
  --color-bronze: #A48454;
  --color-outline: #554336;
  --color-danger: #B91C1C;
  --color-danger-soft: #ff8b8b;
  --font-display: 'Playfair Display', 'Noto Serif SC', serif;
  --font-body: 'Noto Sans', 'Noto Sans SC', sans-serif;

  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-body);
  overflow-x: hidden;
  position: relative;
}

/* 强制 58/42：覆写 BrandPanel 默认 1/2 */
:deep(.brand-panel) {
  width: 58.3333%;
}
@media (max-width: 1023px) {
  :deep(.brand-panel) { display: none; }
}

/* =====================================================================
 * 表单区 42%
 * ===================================================================== */
.form-panel {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  padding: 2rem 1.5rem;
  background: var(--color-surface);
  min-height: 100vh;
  min-height: 100dvh;
  overflow: hidden;
}

/* 表单区微光：顶部径向高光 */
.form-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  background: radial-gradient(
    ellipse at 50% 0%,
    rgba(217, 119, 6, 0.06) 0%,
    rgba(217, 119, 6, 0.02) 25%,
    transparent 55%
  );
  pointer-events: none;
}

.paper-texture {
  position: absolute;
  inset: 0;
  opacity: 0.05;
  background-color: #121412;
  background-image: url("https://www.transparenttextures.com/patterns/p6.png");
  pointer-events: none;
  z-index: 0;
}

.auth-card {
  position: relative;
  width: 100%;
  max-width: 26.25rem;
  padding: 0.5rem 0 0;
  z-index: 1;
  animation: rise 800ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes rise {
  from { opacity: 0; transform: translate3d(0, 18px, 0); }
  to   { opacity: 1; transform: translate3d(0, 0, 0); }
}

/* 装饰邮戳 */
.auth-tag {
  position: absolute;
  top: -1rem;
  right: -1.25rem;
  background: var(--color-bronze);
  color: #2f1500;
  padding: 0.5rem 1rem;
  font-family: var(--font-body);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  transform: rotate(2deg);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  z-index: 2;
}

/* 移动端品牌字 */
.mobile-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  margin-bottom: 1.5rem;
  padding: 0.875rem 1rem;
  background: rgba(255, 183, 125, 0.04);
  border: 1px solid var(--color-outline);
  border-left: 2px solid var(--color-primary);
}
.mobile-brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--color-primary);
  color: var(--color-primary);
  flex-shrink: 0;
  box-shadow: 0 0 14px rgba(255, 183, 125, 0.18);
}
.mobile-brand-mark .material-symbols-outlined {
  font-size: 18px;
  font-variation-settings: 'FILL' 1, 'wght' 500, 'GRAD' 0, 'opsz' 24;
}
.mobile-brand h2 {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.5rem;
  letter-spacing: -0.01em;
  color: var(--color-primary);
  line-height: 1;
}
@media (min-width: 1024px) {
  .mobile-brand { display: none; }
}

/* 标题区 */
.auth-header { margin-bottom: 2.25rem; }
.auth-eyebrow {
  display: inline-block;
  margin: 0 0 0.625rem;
  font-family: var(--font-body);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--color-primary-strong);
}
.auth-title {
  margin: 0 0 0.5rem;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: clamp(1.75rem, 2.4vw, 2.125rem);
  line-height: 1.18;
  letter-spacing: -0.01em;
  color: var(--color-text);
  text-wrap: balance;
}
.auth-sub {
  margin: 0;
  font-family: var(--font-body);
  font-size: 0.9375rem;
  font-weight: 400;
  line-height: 1.55;
  color: var(--color-text-soft);
}

/* =====================================================================
 * 表单
 * ===================================================================== */
.auth-form { display: grid; gap: 1.375rem; }
.field { display: grid; gap: 0.5rem; }
.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.field-label {
  font-family: var(--font-body);
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-text-mute);
}
.forgot-link {
  border: none;
  background: transparent;
  padding: 0;
  font-family: var(--font-body);
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-primary);
  cursor: pointer;
  transition: color 0.18s ease;
}
.forgot-link:hover,
.forgot-link:focus-visible { color: var(--color-primary-strong); }

/* 输入框 */
.field-box {
  position: relative;
  display: flex;
  align-items: center;
  border: 1px solid var(--color-outline);
  background: var(--color-charcoal);
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background 0.2s ease,
    transform 0.2s ease;
}
.field-box:hover {
  border-color: var(--color-text-mute);
  background: #1f201e;
}
.field-box-focus:focus-within {
  border-color: var(--color-primary-strong);
  box-shadow:
    0 0 0 1px var(--color-primary-strong),
    0 0 24px rgba(217, 119, 7, 0.22);
  background: #1f201e;
  transform: translateY(-1px);
}
.field-box-error { border-color: var(--color-danger) !important; }
.field-box-error:focus-within {
  border-color: var(--color-danger) !important;
  box-shadow: 0 0 0 1px var(--color-danger), 0 0 16px rgba(185, 28, 28, 0.2);
}
.field-box input {
  flex: 1;
  width: 100%;
  border: none;
  background: transparent;
  padding: 1rem 1rem 1rem 1.25rem;
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: 0.9375rem;
  line-height: 1.5;
  caret-color: var(--color-primary-strong);
  outline: none;
}
.field-box input::placeholder { color: var(--color-text-faint); letter-spacing: 0.01em; }
.field-box input:-webkit-autofill,
.field-box input:-webkit-autofill:hover,
.field-box input:-webkit-autofill:focus {
  -webkit-box-shadow: 0 0 0 30px var(--color-charcoal) inset !important;
  -webkit-text-fill-color: var(--color-text) !important;
}
.field-icon {
  position: absolute;
  right: 1rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-primary-strong);
  font-size: 20px;
  pointer-events: none;
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
  transition: color 0.2s ease;
}
.field-box-focus:focus-within .field-icon { color: var(--color-primary); }

/* 密码显示切换按钮 */
.icon-button {
  position: absolute;
  right: 0.5rem;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  color: var(--color-text-mute);
  cursor: pointer;
  transition: color 0.18s ease, transform 0.18s ease;
}
.icon-button:hover,
.icon-button:focus-visible { color: var(--color-primary-strong); }
.icon-button .material-symbols-outlined {
  font-size: 20px;
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}

/* 错误提示 */
.error-text {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  font-family: var(--font-body);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.03em;
  color: var(--color-danger-soft);
}
.error-text--top {
  padding: 0.625rem 0.875rem;
  background: rgba(185, 28, 28, 0.12);
  border: 1px solid rgba(185, 28, 28, 0.4);
  letter-spacing: 0.02em;
}
.error-text .material-symbols-outlined {
  font-size: 14px;
  font-variation-settings: 'FILL' 0, 'wght' 600, 'GRAD' 0, 'opsz' 24;
}

/* =====================================================================
 * 提交按钮（含 shimmer + 箭头）
 * ===================================================================== */
.submit-button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  width: 100%;
  padding: 1.125rem 1.25rem;
  background: var(--color-primary-strong);
  border: 1px solid var(--color-primary-strong);
  color: #2f1500;
  font-family: var(--font-body);
  font-size: 0.8125rem;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  cursor: pointer;
  overflow: hidden;
  transition:
    background-color 0.2s ease,
    color 0.2s ease,
    transform 0.2s ease,
    box-shadow 0.2s ease;
  margin-top: 0.5rem;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.25);
}
.submit-button:hover:not(:disabled) {
  background: linear-gradient(180deg, #f59e0b 0%, var(--color-primary-strong) 100%);
  transform: translateY(-1px);
  box-shadow: 0 8px 24px rgba(217, 119, 7, 0.32), 0 2px 0 rgba(0, 0, 0, 0.25);
}
.submit-button:active:not(:disabled) {
  transform: translateY(0) scale(0.985);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.25);
}
.submit-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
  background: #292a28;
  color: var(--color-text-faint);
  border-color: var(--color-outline);
  box-shadow: none;
}
.submit-button.is-loading { cursor: progress; }
.submit-text { display: inline-block; }
.submit-arrow {
  font-size: 18px;
  font-variation-settings: 'FILL' 0, 'wght' 600, 'GRAD' 0, 'opsz' 24;
  transition: transform 0.2s ease;
}
.submit-button:hover:not(:disabled) .submit-arrow { transform: translateX(3px); }

.spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(47, 21, 0, 0.3);
  border-top-color: #2f1500;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.3),
    transparent
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s linear infinite;
  pointer-events: none;
}
@keyframes shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

/* =====================================================================
 * 微信扫码登录 - 次级入口
 * - 设计 token：
 *    --wechat-green:        #07C160  微信品牌色（官方色）
 *    --wechat-green-strong: #06AD56  hover 加深
 *    --wechat-green-soft:   rgba(7,193,96,0.10) 暗背景下 hover 底色
 * - 双段次级风格：边框 + 微信绿 + 文字，hover 时填充绿色 + 文字反白
 * - 视觉层次：主按钮"立即登录"是橙色填充；微信按钮是绿色边框次级
 * - 不影响现有表单功能：仅在 submit 按钮后、footer 前插入
 * ===================================================================== */
.wechat-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 1.5rem 0 1rem;
}
.wechat-divider-line {
  flex: 1 1 auto;
  height: 1px;
  background: var(--color-outline);
  opacity: 0.5;
}
.wechat-divider-text {
  flex-shrink: 0;
  font-family: var(--font-body);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--color-text-mute);
}

.wechat-button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  width: 100%;
  height: 3rem;
  padding: 0 1.25rem;
  background: transparent;
  border: 1px solid #07C160;
  color: #1AAD66;
  font-family: var(--font-body);
  font-size: 0.875rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  cursor: pointer;
  overflow: hidden;
  transition: all 220ms cubic-bezier(0.4, 0, 0.2, 1);
}
.wechat-button::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, #07C160 0%, #06AD56 100%);
  transform: translateY(101%);
  transition: transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
  z-index: 0;
}
.wechat-button > * { position: relative; z-index: 1; }
.wechat-button:hover,
.wechat-button:focus-visible {
  color: #ffffff;
  border-color: #06AD56;
  box-shadow: 0 6px 18px rgba(7, 193, 96, 0.28);
  outline: none;
}
.wechat-button:hover::before,
.wechat-button:focus-visible::before { transform: translateY(0); }
.wechat-button:active { transform: scale(0.985); }

.wechat-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  color: #07C160;
  transition: color 220ms ease;
}
.wechat-button:hover .wechat-icon,
.wechat-button:focus-visible .wechat-icon { color: #ffffff; }
.wechat-icon svg { display: block; }

.wechat-text {
  letter-spacing: 0.04em;
}
.wechat-arrow {
  font-size: 1.125rem !important;
  color: #07C160;
  transition: transform 280ms cubic-bezier(0.16, 1, 0.3, 1), color 220ms ease;
}
.wechat-button:hover .wechat-arrow,
.wechat-button:focus-visible .wechat-arrow {
  color: #ffffff;
  transform: translateX(2px) rotate(8deg);
}

/* =====================================================================
 * 底部链接
 * ===================================================================== */
.auth-footer {
  margin-top: 2.25rem;
  padding-top: 1.75rem;
  border-top: 1px solid var(--color-outline);
  text-align: center;
}
.auth-footer p {
  margin: 0;
  font-family: var(--font-body);
  font-size: 0.875rem;
  font-weight: 400;
  line-height: 1.5;
  color: var(--color-text-soft);
}
.link-button {
  border: none;
  background: transparent;
  margin-left: 0.5rem;
  font-family: var(--font-body);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.5;
  color: var(--color-primary);
  cursor: pointer;
  transition: color 0.18s ease;
}
.link-button:hover,
.link-button:focus-visible {
  color: var(--color-primary-strong);
  text-decoration: underline;
}

/* 次级链接 */
.meta-links {
  margin-top: 2rem;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 0.75rem;
  opacity: 0.5;
  transition: opacity 0.2s ease;
}
.meta-links:hover,
.meta-links:focus-within { opacity: 1; }
.meta-link {
  font-family: var(--font-body);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--color-text-mute);
  text-decoration: none;
  transition: color 0.2s ease;
}
.meta-link:hover,
.meta-link:focus-visible { color: var(--color-primary); }
.meta-sep {
  font-size: 0.625rem;
  color: var(--color-text-faint);
  user-select: none;
}

/* =====================================================================
 * 响应式断点（按视口宽度）
 *  - ≥1920 大屏
 *  - 1440-1919 标准桌面
 *  - 1280-1439 紧凑桌面
 *  - 1024-1279 桌面最低（关键适配点）
 *  - 768-1023 平板
 *  - 480-767 手机
 *  - <480 小屏手机
 * ===================================================================== */

/* ≥1920 大屏：放大 padding */
@media (min-width: 1920px) {
  :deep(.brand-content) { padding: 5rem 5rem !important; }
  .auth-card { max-width: 28rem; }
  .form-panel { padding: 3rem 2.5rem; }
}

/* 1440-1919 标准桌面 */
@media (min-width: 1440px) and (max-width: 1919px) {
  .auth-card { max-width: 27rem; }
}

/* 1280-1439 紧凑桌面：让 brand-content 更紧凑 */
@media (min-width: 1280px) and (max-width: 1439px) {
  :deep(.brand-content) { padding: 3rem 2.75rem !important; }
  :deep(.brand-headline) { font-size: clamp(2.25rem, 3.4vw, 2.75rem) !important; }
  :deep(.brand-meta) { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  .auth-card { max-width: 25.5rem; }
}

/* 1024-1279 桌面最低：brand-content 紧凑 + 字号缩小 */
@media (min-width: 1024px) and (max-width: 1279px) {
  :deep(.brand-content) { padding: 2.25rem 2.25rem !important; gap: 1.25rem !important; }
  :deep(.brand-headline) { font-size: 2.125rem !important; line-height: 1.1 !important; }
  :deep(.brand-eyebrow) { margin-bottom: 1rem !important; }
  :deep(.brand-desc) { font-size: 0.9375rem !important; line-height: 1.55 !important; }
  :deep(.brand-meta) {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 0.75rem 1rem !important;
  }
  :deep(.brand-meta-item dt) { font-size: 0.5625rem !important; }
  :deep(.brand-meta-item dd) { font-size: 0.8125rem !important; }
  :deep(.brand-mega-num) { font-size: clamp(5.5rem, 8vw, 7.5rem) !important; }
  :deep(.brand-corner) { width: 14px; height: 14px; }
  .auth-card { max-width: 23.5rem; }
  .form-panel { padding: 2rem 1.25rem; }
  .auth-title { font-size: 1.875rem; }
}

@media (max-width: 1023px) {
  .form-panel { width: 100%; }
  .auth-tag { right: 0.5rem; top: -1rem; font-size: 0.65rem; }
}

/* 768-1023 平板 */
@media (min-width: 768px) and (max-width: 1023px) {
  .form-panel { padding: 3rem 2rem; }
  .auth-card { max-width: 28rem; }
  .auth-title { font-size: 1.875rem; }
}

/* 480-767 手机 */
@media (max-width: 767px) {
  .form-panel { padding: 2rem 1.25rem; }
  .auth-card { max-width: 100%; }
  .auth-title { font-size: 1.625rem; }
  .auth-sub { font-size: 0.875rem; }
  .meta-links { gap: 0.625rem; }
  .meta-link { font-size: 0.625rem; letter-spacing: 0.14em; }
  .auth-footer { margin-top: 1.75rem; padding-top: 1.5rem; }
}

/* <480 小屏 */
@media (max-width: 479px) {
  .form-panel { padding: 1.5rem 1rem; }
  .auth-card { padding: 0; }
  .auth-tag { right: 0.5rem; padding: 0.4rem 0.75rem; font-size: 0.6rem; }
  .mobile-brand { padding: 0.75rem; }
  .mobile-brand h2 { font-size: 1.25rem; }
  .auth-form { gap: 1.125rem; }
  .field-box input { padding: 0.875rem 0.875rem 0.875rem 1rem; font-size: 0.875rem; }
  .submit-button { padding: 1rem 1rem; font-size: 0.75rem; letter-spacing: 0.14em; }
  .auth-header { margin-bottom: 1.75rem; }
  .auth-title { font-size: 1.5rem; }
  .auth-sub { font-size: 0.8125rem; }
}

@media (prefers-reduced-motion: reduce) {
  .auth-card,
  .field-box,
  .spinner,
  .shimmer,
  .submit-button {
    animation: none !important;
    transform: none !important;
  }
}

.submit-button:focus-visible,
.forgot-link:focus-visible,
.icon-button:focus-visible,
.link-button:focus-visible,
.meta-link:focus-visible,
.wechat-button:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px rgba(255, 183, 125, 0.6),
    0 0 0 4px rgba(217, 119, 7, 0.4);
}
.wechat-button:focus-visible {
  box-shadow:
    0 0 0 2px rgba(7, 193, 96, 0.55),
    0 0 0 4px rgba(7, 193, 96, 0.25);
}
</style>

<!-- =====================================================================
 * 微信扫码模态：Teleport 到 body 之外，必须用 unscoped 样式
 * - 暗背景遮罩 + 居中卡片
 * - QR 装饰：四角定位块 + 8x8 网格 + 扫描线 + 中心 logo
 * - 倒计时 + 状态点（脉冲动画）
 * ===================================================================== -->
<style>
.wechat-modal-root {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}
.wechat-modal-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(8, 10, 8, 0.72);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.wechat-modal-card {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 22rem;
  padding: 1.75rem 1.5rem 1.25rem;
  background: #1B1C1A;
  border: 1px solid #554336;
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.55),
    0 0 0 1px rgba(255, 183, 125, 0.06) inset;
  font-family: 'Noto Sans', 'Noto Sans SC', sans-serif;
  color: #e3e3df;
}

.wechat-modal-close {
  position: absolute;
  top: 0.625rem;
  right: 0.625rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid transparent;
  background: transparent;
  color: #a38c7c;
  cursor: pointer;
  transition: all 200ms ease;
}
.wechat-modal-close:hover,
.wechat-modal-close:focus-visible {
  color: #ffb77d;
  border-color: #554336;
  outline: none;
}
.wechat-modal-close .material-symbols-outlined { font-size: 18px; }

.wechat-modal-head { text-align: center; margin-bottom: 1.25rem; }
.wechat-modal-eyebrow {
  display: inline-block;
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: #d97706;
  margin-bottom: 0.5rem;
}
.wechat-modal-title {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 0.375rem;
  font-family: 'Playfair Display', 'Noto Serif SC', serif;
  font-weight: 600;
  font-size: 1.25rem;
  line-height: 1.2;
  color: #ffb77d;
  letter-spacing: -0.005em;
}
.wechat-modal-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #07C160;
}
.wechat-modal-sub {
  margin: 0;
  font-size: 0.8125rem;
  font-weight: 400;
  line-height: 1.5;
  color: #a38c7c;
}

.wechat-modal-qr {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 1.25rem;
}

/* QR 框 */
.qr-frame {
  position: relative;
  width: 12rem;
  height: 12rem;
  background: #ffffff;
  padding: 0.75rem;
  border: 1px solid #554336;
  box-shadow: 0 0 0 4px rgba(7, 193, 96, 0.08);
  overflow: hidden;
}
.qr-corner {
  position: absolute;
  width: 1.5rem;
  height: 1.5rem;
  border: 3px solid #07C160;
}
.qr-corner-tl { top: 0.5rem;    left: 0.5rem;    border-right: 0; border-bottom: 0; }
.qr-corner-tr { top: 0.5rem;    right: 0.5rem;   border-left: 0;  border-bottom: 0; }
.qr-corner-bl { bottom: 0.5rem; left: 0.5rem;    border-right: 0; border-top: 0; }
.qr-corner-br { bottom: 0.5rem; right: 0.5rem;   border-left: 0;  border-top: 0; }

.qr-grid {
  position: absolute;
  inset: 0.75rem;
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  grid-template-rows: repeat(8, 1fr);
  gap: 1px;
}
.qr-cell {
  display: block;
  background: #ffffff;
}
.qr-cell[data-bit="1"] { background: #121412; }

.qr-scanline {
  position: absolute;
  left: 0.75rem;
  right: 0.75rem;
  height: 2px;
  background: linear-gradient(90deg, transparent 0%, #07C160 50%, transparent 100%);
  box-shadow: 0 0 10px rgba(7, 193, 96, 0.6);
  animation: qr-scan 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  top: 0.75rem;
}
@keyframes qr-scan {
  0%   { transform: translateY(0);     opacity: 0; }
  10%  { opacity: 1; }
  90%  { opacity: 1; }
  100% { transform: translateY(calc(12rem - 1.5rem - 4px)); opacity: 0; }
}

.qr-logo {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3rem;
  height: 3rem;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  color: #07C160;
  border: 2px solid #07C160;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
}

.wechat-modal-foot {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: center;
  border-top: 1px solid #554336;
  padding-top: 0.875rem;
}
.wechat-modal-status {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  font-size: 0.75rem;
  color: #dbc2b0;
}
.wechat-modal-status strong {
  font-family: 'Playfair Display', serif;
  font-weight: 600;
  color: #ffb77d;
  letter-spacing: 0.04em;
  margin-left: 0.125rem;
}
.wechat-modal-status.is-expired { color: #ff8b8b; }
.status-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: #07C160;
  box-shadow: 0 0 0 0 rgba(7, 193, 96, 0.55);
  animation: status-pulse 1.6s ease-out infinite;
}
.wechat-modal-status.is-expired .status-dot {
  background: #ff8b8b;
  animation: none;
}
@keyframes status-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(7, 193, 96, 0.55); }
  70%  { box-shadow: 0 0 0 6px rgba(7, 193, 96, 0); }
  100% { box-shadow: 0 0 0 0 rgba(7, 193, 96, 0); }
}

.wechat-modal-actions {
  display: flex;
  gap: 0.5rem;
  width: 100%;
}
.wechat-modal-refresh,
.wechat-modal-cancel {
  flex: 1 1 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  height: 2.25rem;
  padding: 0 0.875rem;
  font-family: 'Noto Sans', sans-serif;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 200ms ease;
}
.wechat-modal-refresh {
  background: rgba(7, 193, 96, 0.1);
  border: 1px solid #07C160;
  color: #1AAD66;
}
.wechat-modal-refresh:hover,
.wechat-modal-refresh:focus-visible {
  background: #07C160;
  color: #ffffff;
  outline: none;
}
.wechat-modal-refresh .material-symbols-outlined { font-size: 16px; }
.wechat-modal-cancel {
  background: transparent;
  border: 1px solid #554336;
  color: #a38c7c;
}
.wechat-modal-cancel:hover,
.wechat-modal-cancel:focus-visible {
  border-color: #ffb77d;
  color: #ffb77d;
  outline: none;
}

/* 模态过渡：缩放 + 淡入 */
.wechat-modal-enter-active {
  transition: opacity 220ms cubic-bezier(0.4, 0, 0.2, 1);
}
.wechat-modal-leave-active {
  transition: opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
}
.wechat-modal-enter-from,
.wechat-modal-leave-to { opacity: 0; }
.wechat-modal-enter-active .wechat-modal-card {
  animation: wechat-card-in 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.wechat-modal-leave-active .wechat-modal-card {
  animation: wechat-card-out 200ms cubic-bezier(0.4, 0, 0.2, 1) both;
}
@keyframes wechat-card-in {
  from { opacity: 0; transform: translateY(8px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes wechat-card-out {
  from { opacity: 1; transform: scale(1); }
  to   { opacity: 0; transform: scale(0.97); }
}

@media (prefers-reduced-motion: reduce) {
  .qr-scanline,
  .status-dot,
  .wechat-modal-enter-active .wechat-modal-card,
  .wechat-modal-leave-active .wechat-modal-card {
    animation: none !important;
  }
}

@media (max-width: 480px) {
  .wechat-modal-card { max-width: 100%; padding: 1.5rem 1.25rem 1rem; }
  .qr-frame { width: 10.5rem; height: 10.5rem; }
  @keyframes qr-scan {
    100% { transform: translateY(calc(10.5rem - 1.5rem - 4px)); }
  }
}
</style>
