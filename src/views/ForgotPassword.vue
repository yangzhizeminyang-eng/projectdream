<!--
  @file PanelFlow 忘记密码 - 步骤 1：手机验证
  @description 与 Login/Register 同一 Darkroom Professional 设计系统，使用 <BrandPanel> 公共组件。
               本页承担"找回密码"流程第一步：输入手机号 + 短信验证码
               验证通过后跳转到 /reset-password 设置新密码。
  @author PanelFlow Studio
-->
<script setup lang="ts">
/**
 * @file <script setup> 段负责忘记密码流程第一步的手机验证
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { sendSmsCode } from '@/api/auth'
import CaptchaSlider from '@/components/auth/CaptchaSlider.vue'
import BrandPanel from '@/components/BrandPanel.vue'

const router = useRouter()
const route = useRoute()

/** 表单状态 */
const phone = ref('')
const code = ref('')
const countdown = ref(0)
const submitting = ref(false)
const showDevCode = ref(false)
const devCode = ref('')
const errorMessage = ref('')
const captchaToken = ref('')

/** 字段级错误 */
const phoneError = ref('')
const codeError = ref('')

/** 倒计时定时器 */
let timer: number | null = null

/**
 * @description 规范化手机号
 * @param {string} value 原始输入
 * @returns {string} 仅含数字、最长 11 位
 */
function normalizePhone(value: string): string {
  return value.replace(/\D/g, '').slice(0, 11)
}

/**
 * @description 格式化手机号 3-4-4
 * @param {string} value 原始输入
 * @returns {string} 展示文本
 */
function formatPhone(value: string): string {
  const normalized = normalizePhone(value)
  return normalized.replace(/^(\d{0,3})(\d{0,4})(\d{0,4}).*$/, (_, a: string, b: string, c: string) =>
    [a, b, c].filter(Boolean).join(' '),
  )
}

/** 从 query 预填手机号 */
const initialPhone = typeof route.query.phone === 'string' ? route.query.phone : ''
if (initialPhone) {
  phone.value = formatPhone(initialPhone)
}

/**
 * @description 输入手机号
 * @param {string} value 原始输入
 * @returns {void}
 */
function onPhoneInput(value: string): void {
  phone.value = formatPhone(value)
  captchaToken.value = ''
  phoneError.value = ''
  errorMessage.value = ''
}

/**
 * @description 输入验证码
 * @param {string} value 原始输入
 * @returns {void}
 */
function onCodeInput(value: string): void {
  code.value = value.replace(/\D/g, '').slice(0, 6)
  codeError.value = ''
  errorMessage.value = ''
}

/**
 * @description 启动倒计时
 * @param {number} seconds 倒计时秒数
 * @returns {void}
 */
function startCountdown(seconds: number): void {
  countdown.value = seconds
  if (timer) {
    window.clearInterval(timer)
    timer = null
  }
  timer = window.setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0 && timer) {
      window.clearInterval(timer)
      timer = null
    }
  }, 1000)
}

/** 校验：手机号 11 位 */
const phoneValid = computed(() => /^1\d{10}$/.test(normalizePhone(phone.value)))
/** 校验：验证码 6 位 */
const codeValid = computed(() => /^\d{6}$/.test(code.value))

/**
 * @description 发送验证码
 * @returns {Promise<void>}
 * @throws {Error} 发送失败时抛出
 */
async function handleSendCode(): Promise<void> {
  if (!phoneValid.value) {
    phoneError.value = '请输入正确的 11 位手机号'
    return
  }
  if (countdown.value > 0) return

  try {
    errorMessage.value = ''
    const phoneNumber = normalizePhone(phone.value)
    if (!captchaToken.value) {
      errorMessage.value = '请先完成滑块验证'
      return
    }
    const result = await sendSmsCode(phoneNumber, 'reset', captchaToken.value)
    captchaToken.value = ''
    startCountdown(result.countdown || 60)
    if (result.devCode) {
      devCode.value = result.devCode
      showDevCode.value = true
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '验证码发送失败'
  }
}

/**
 * @description 提交：校验通过后跳转到设置新密码
 * @returns {void}
 */
function handleNext(): void {
  if (submitting.value) return
  if (!phoneValid.value) {
    phoneError.value = '请输入正确的 11 位手机号'
    return
  }
  if (!codeValid.value) {
    codeError.value = '请输入 6 位短信验证码'
    return
  }

  // 进入下一步：携带手机号 + 验证码
  router.push({
    path: '/reset-password',
    query: {
      phone: normalizePhone(phone.value),
      code: code.value,
    },
  })
}

/**
 * @description 返回登录（"想起密码了"链接）
 * @returns {void}
 */
function goBack(): void {
  router.push('/')
}

onBeforeUnmount(() => {
  if (timer) {
    window.clearInterval(timer)
    timer = null
  }
})
</script>

<template>
  <main class="auth-shell" aria-label="PanelFlow 找回密码">
    <!-- 左侧品牌区 1/2（公共组件） -->
    <BrandPanel episode="03" label="找回密码" />

    <!-- 右侧流程卡 -->
    <section class="form-panel" aria-label="找回密码流程">
      <div class="paper-texture" aria-hidden="true"></div>

      <div class="auth-card">
        <!-- 装饰邮戳 -->
        <div class="auth-tag" aria-hidden="true">找回密码 · 第一步</div>

        <!-- 移动端品牌字 -->
        <div class="mobile-brand" aria-hidden="true">
          <span class="mobile-brand-mark">
            <span class="material-symbols-outlined">movie_filter</span>
          </span>
          <h2>PanelFlow</h2>
        </div>

        <!-- 进度指示 -->
        <ol class="stepper" aria-label="进度">
          <li class="step is-active">
            <span class="step-num">01</span>
            <span class="step-label">验证手机</span>
          </li>
          <li class="step-sep" aria-hidden="true"></li>
          <li class="step">
            <span class="step-num">02</span>
            <span class="step-label">设置新密码</span>
          </li>
        </ol>

        <header class="auth-header">
          <span class="auth-eyebrow">找回密码</span>
          <h1 class="auth-title">找回密码</h1>
          <p class="auth-sub">输入注册时的手机号，我们将发送验证码以验证身份</p>
        </header>

        <form class="auth-form" @submit.prevent="handleNext" novalidate>
          <!-- 手机号 -->
          <label class="field">
            <span class="field-label">手机号</span>
            <div class="field-box" :class="{ 'field-box-error': phoneError }">
              <span class="material-symbols-outlined field-icon-left">smartphone</span>
              <input
                :value="phone"
                type="text"
                inputmode="tel"
                autocomplete="tel"
                placeholder="138 0000 0000"
                maxlength="13"
                @input="onPhoneInput(($event.target as HTMLInputElement).value)"
              />
            </div>
            <p v-if="phoneError" class="error-text">
              <span class="material-symbols-outlined">error</span>
              <span>{{ phoneError }}</span>
            </p>
          </label>

          <!-- 验证码 -->
          <label class="field">
            <span class="field-label">短信验证码</span>
            <div class="code-row">
              <div class="field-box field-box-flex" :class="{ 'field-box-error': codeError }">
                <span class="material-symbols-outlined field-icon-left">verified_user</span>
                <input
                  :value="code"
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  placeholder="6 位数字验证码"
                  maxlength="6"
                  @input="onCodeInput(($event.target as HTMLInputElement).value)"
                />
              </div>
              <button
                type="button"
                class="code-button"
                :class="{ 'is-ready': phoneValid && countdown === 0 }"
                :disabled="!phoneValid || countdown > 0"
                @click="handleSendCode"
              >
                {{ countdown > 0 ? `重新获取 (${countdown}s)` : '获取验证码' }}
              </button>
            </div>
            <p v-if="codeError" class="error-text">
              <span class="material-symbols-outlined">error</span>
              <span>{{ codeError }}</span>
            </p>
            <p v-else-if="showDevCode" class="dev-hint">
              <span class="material-symbols-outlined">info</span>
              <span>开发环境验证码：{{ devCode }}</span>
            </p>
          </label>

          <CaptchaSlider :phone="normalizePhone(phone)" @verified="captchaToken = $event" />

          <!-- 顶层错误提示 -->
          <p v-if="errorMessage" class="error-text error-text--top">
            <span class="material-symbols-outlined">error</span>
            <span>{{ errorMessage }}</span>
          </p>

          <!-- 下一步按钮 -->
          <button
            type="submit"
            class="submit-button"
            :disabled="!phoneValid || !codeValid"
          >
            <span>下一步：设置新密码</span>
            <span class="material-symbols-outlined submit-arrow">arrow_forward</span>
          </button>
        </form>

        <footer class="auth-footer">
          <p>
            想起密码了？
            <button type="button" class="link-button" @click="goBack">返回登录</button>
          </p>
        </footer>
      </div>
    </section>
  </main>
</template>

<style scoped>
/* =====================================================================
 * 找回密码页 - Darkroom Professional
 *  - 品牌区已抽出到 <BrandPanel>
 *  - 表单卡片强调"流程进度 + 找回步骤"
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
  --color-bronze: #A48454;
  --color-outline: #554336;
  --color-danger: #B91C1C;
  --color-danger-soft: #ff8b8b;
  --color-success: #96ccff;
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

/* =====================================================================
 * 表单区
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
}

.paper-texture {
  position: absolute;
  inset: 0;
  opacity: 0.05;
  background-color: #121412;
  background-image: url("https://www.transparenttextures.com/patterns/p6.png");
  pointer-events: none;
}

.auth-card {
  position: relative;
  width: 100%;
  max-width: 28rem;
  padding: 0.5rem 0 0;
  z-index: 1;
  animation: rise 800ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes rise {
  from { opacity: 0; transform: translate3d(0, 18px, 0); }
  to   { opacity: 1; transform: translate3d(0, 0, 0); }
}

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

/* 进度条 */
.stepper {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0 2rem;
  padding: 0;
  list-style: none;
  font-family: var(--font-body);
}

.step {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--color-text-faint);
}

.step.is-active {
  color: var(--color-primary-strong);
}

.step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid currentColor;
  font-size: 0.6875rem;
}

.step.is-active .step-num {
  background: var(--color-primary-strong);
  border-color: var(--color-primary-strong);
  color: #1B1C1A;
}

.step-label { white-space: nowrap; }

.step-sep {
  flex: 1;
  height: 1px;
  background: var(--color-outline);
  min-width: 24px;
}

.auth-header { margin-bottom: 2rem; }

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
  font-size: 2rem;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--color-text);
}

.auth-sub {
  margin: 0;
  font-family: var(--font-body);
  font-size: 0.9375rem;
  font-weight: 400;
  line-height: 1.55;
  color: var(--color-text-soft);
}

.auth-form { display: grid; gap: 1.375rem; }
.field { display: grid; gap: 0.5rem; }
.field-label {
  font-family: var(--font-body);
  font-size: 0.6875rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-text-mute);
}

.field-box {
  position: relative;
  display: flex;
  align-items: center;
  border: 1px solid var(--color-outline);
  background: var(--color-charcoal);
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}
.field-box:hover {
  border-color: var(--color-text-mute);
  background: #1f201e;
}
.field-box:focus-within {
  border-color: var(--color-primary-strong);
  box-shadow:
    0 0 0 1px var(--color-primary-strong),
    0 0 18px rgba(217, 119, 7, 0.18);
  background: #1f201e;
}
.field-box-error { border-color: var(--color-danger); }
.field-box-error:focus-within {
  border-color: var(--color-danger);
  box-shadow: 0 0 0 1px var(--color-danger);
}
.field-box-flex { flex: 1; }
.field-box input {
  flex: 1;
  width: 100%;
  border: none;
  background: transparent;
  padding: 1rem 1.25rem 1rem 3rem;
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: 0.9375rem;
  line-height: 1.5;
  caret-color: var(--color-primary-strong);
  outline: none;
}
.field-box input::placeholder { color: var(--color-text-faint); }
.field-box input:-webkit-autofill,
.field-box input:-webkit-autofill:hover,
.field-box input:-webkit-autofill:focus {
  -webkit-box-shadow: 0 0 0 30px var(--color-charcoal) inset !important;
  -webkit-text-fill-color: var(--color-text) !important;
}
.field-icon-left {
  position: absolute;
  left: 1rem;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-text-soft);
  font-size: 20px;
  pointer-events: none;
}
.field-box:focus-within .field-icon-left { color: var(--color-primary-strong); }

/* 短信行 */
.code-row { display: flex; gap: 0; }
.code-row .field-box { flex: 1; }
.code-button {
  flex-shrink: 0;
  min-width: 8rem;
  border: 1px solid var(--color-outline);
  border-left: none;
  background: #292a28;
  color: var(--color-text-mute);
  padding: 0 1.25rem;
  font-family: var(--font-body);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
}
.code-button.is-ready { color: var(--color-primary); }
.code-button.is-ready:hover {
  color: var(--color-primary-strong);
  border-color: var(--color-primary-strong);
  background: rgba(255, 183, 125, 0.04);
}
.code-button:disabled { cursor: not-allowed; opacity: 0.7; }

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

.dev-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  font-family: var(--font-body);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.03em;
  color: var(--color-success);
}
.dev-hint .material-symbols-outlined {
  font-size: 14px;
  font-variation-settings: 'FILL' 0, 'wght' 600, 'GRAD' 0, 'opsz' 24;
}

/* 提交按钮 */
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
}
.submit-button:hover:not(:disabled) {
  background: linear-gradient(180deg, #f59e0b 0%, var(--color-primary-strong) 100%);
  transform: translateY(-1px);
  box-shadow: 0 8px 24px rgba(217, 119, 7, 0.28);
}
.submit-button:active:not(:disabled) {
  transform: translateY(0) scale(0.98);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.25);
}
.submit-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
  background: #292a28;
  color: var(--color-text-faint);
  border-color: var(--color-outline);
}
.submit-arrow {
  font-size: 18px;
  font-variation-settings: 'FILL' 0, 'wght' 600, 'GRAD' 0, 'opsz' 24;
  transition: transform 0.2s ease;
}
.submit-button:hover:not(:disabled) .submit-arrow { transform: translateX(3px); }

/* 底部 */
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
  color: var(--color-text-soft);
}
.link-button {
  border: none;
  background: transparent;
  margin-left: 0.5rem;
  font-family: var(--font-body);
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-primary);
  cursor: pointer;
  transition: color 0.18s ease;
}
.link-button:hover,
.link-button:focus-visible {
  color: var(--color-primary-strong);
  text-decoration: underline;
}

/* =====================================================================
 * 响应式断点
 * ===================================================================== */
@media (min-width: 1920px) {
  :deep(.brand-content) { padding: 5rem 5rem; }
  .auth-card { max-width: 30rem; }
}
@media (min-width: 1280px) and (max-width: 1439px) {
  :deep(.brand-content) { padding: 3rem; }
  :deep(.brand-meta) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (min-width: 1024px) and (max-width: 1279px) {
  :deep(.brand-content) { padding: 2.25rem; }
  :deep(.brand-headline) { font-size: 2.25rem; }
  :deep(.brand-desc) { font-size: 1rem; }
  :deep(.brand-meta) { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
  :deep(.brand-mid) { max-width: 100%; }
  .auth-card { max-width: 26rem; }
}
@media (max-width: 1023px) {
  .form-panel { width: 100%; }
  .auth-tag { right: 0.5rem; top: -1rem; font-size: 0.65rem; }
}
@media (min-width: 768px) and (max-width: 1023px) {
  .form-panel { padding: 3rem 2rem; }
  .auth-card { max-width: 28rem; }
}
@media (max-width: 767px) {
  .form-panel { padding: 2rem 1.25rem; }
  .auth-card { max-width: 100%; }
  .auth-title { font-size: 1.625rem; }
  .auth-sub { font-size: 0.875rem; }
  .code-row { flex-direction: column; gap: 0.5rem; }
  .code-button { border-left: 1px solid var(--color-outline); min-height: 3rem; min-width: 100%; }
}
@media (max-width: 479px) {
  .form-panel { padding: 1.5rem 1rem; }
  .auth-card { padding: 0; }
  .auth-tag { right: 0.5rem; padding: 0.4rem 0.75rem; font-size: 0.6rem; }
  .mobile-brand { padding: 0.75rem; }
  .mobile-brand h2 { font-size: 1.25rem; }
  .auth-form { gap: 1.125rem; }
  .field-box input { padding: 0.875rem 1rem 0.875rem 2.625rem; font-size: 0.875rem; }
  .submit-button { padding: 1rem 1rem; font-size: 0.75rem; letter-spacing: 0.14em; }
}

@media (prefers-reduced-motion: reduce) {
  :deep(.brand-bg),
  :deep(.brand-status-dot),
  :deep(.brand-top),
  :deep(.brand-mid),
  :deep(.brand-bottom),
  .auth-card {
    animation: none !important;
    transform: none !important;
  }
}

.submit-button:focus-visible,
.code-button:focus-visible,
.link-button:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px rgba(255, 183, 125, 0.6),
    0 0 0 4px rgba(217, 119, 7, 0.4);
}
</style>
