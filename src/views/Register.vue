<!--
  @file PanelFlow 注册页 - 手机号 + 验证码注册
  @description 基于 stitch_panelflow_creative_studio/pf_00_2/code.html 重构：
                 - 与 Login.vue 同一品牌区三段式（顶部 logo / 中部宣言 / 底部工具集）
                 - 装饰大数字 "02" + 边角技术刻度
                 - 表单字段图标统一在左（与原设计稿一致）
                 - 倒计时按钮 + 协议勾选 + 完整响应式
                 - 提交按钮 shimmer + 箭头 + 渐变 hover
                 - 多视口响应式（375/768/900/1024/1280/1440/1920）
  @author PanelFlow Studio
-->
<script setup lang="ts">
/**
 * @file <script setup> 段负责注册页交互逻辑
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { checkPhone, registerWithSms, saveAuthSession, sendSmsCode } from '@/api/auth'
import BrandPanel from '@/components/BrandPanel.vue'

const router = useRouter()

/** 表单状态：手机号 / 验证码 / 昵称 / 密码 / 确认密码 / 协议 / 提交中 / 倒计时 */
const phone = ref('')
const code = ref('')
const nickname = ref('')
const password = ref('')
const confirmPassword = ref('')
const agreed = ref(true)
const submitting = ref(false)
const countdown = ref(0)
const showPassword = ref(false)
const showConfirmPassword = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

/** 倒计时定时器 */
let timer: number | null = null

/** 手机号格式校验：1 开头 11 位 */
const phoneValid = computed(() => /^1\d{10}$/.test(normalizePhone(phone.value)))
/** 验证码格式校验：6 位数字 */
const codeValid = computed(() => /^\d{6}$/.test(code.value))
/** 两次密码是否一致（密码至少 6 位） */
const passwordMatch = computed(
  () => password.value.length >= 6 && password.value === confirmPassword.value,
)
/** 是否可以发送验证码：手机号合法 + 不在倒计时 */
const canSendCode = computed(() => phoneValid.value && countdown.value === 0)
/** 是否可以提交：所有字段都通过校验 + 协议勾选 + 不在提交中 */
const canSubmit = computed(
  () =>
    phoneValid.value &&
    codeValid.value &&
    nickname.value.trim().length >= 2 &&
    passwordMatch.value &&
    agreed.value &&
    !submitting.value,
)

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
  errorMessage.value = ''
  successMessage.value = ''
}

/**
 * @description 处理验证码输入：仅保留数字、最长 6 位
 * @param {string} value 原始输入
 * @returns {void}
 */
function onCodeInput(value: string): void {
  code.value = value.replace(/\D/g, '').slice(0, 6)
  errorMessage.value = ''
  successMessage.value = ''
}

/**
 * @description 启动验证码倒计时
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

/**
 * @description 发送注册验证码：先检查手机号是否已注册
 * @returns {Promise<void>}
 * @throws {Error} 手机号已注册或发送失败时抛出
 */
async function handleSendCode(): Promise<void> {
  if (!canSendCode.value) return

  try {
    errorMessage.value = ''
    successMessage.value = ''
    const phoneNumber = normalizePhone(phone.value)
    const result = await checkPhone(phoneNumber)
    if (result.exists) {
      errorMessage.value = '该手机号已注册，请直接前往登录'
      return
    }
    const sendResult = await sendSmsCode(phoneNumber, 'register')
    startCountdown(sendResult.countdown || 60)
    successMessage.value = sendResult.devCode
      ? `验证码已发送，开发验证码：${sendResult.devCode}`
      : '验证码已发送，请注意查收短信'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '验证码发送失败'
  }
}

/**
 * @description 提交注册：前端校验 → API 调用 → 跳转 dashboard
 * @param {Event} e 表单事件
 * @returns {Promise<void>}
 */
async function handleRegister(e: Event): Promise<void> {
  e.preventDefault()
  if (submitting.value) return

  if (!phoneValid.value) {
    errorMessage.value = '请输入正确的 11 位手机号'
    return
  }
  if (!codeValid.value) {
    errorMessage.value = '请输入 6 位短信验证码'
    return
  }
  if (nickname.value.trim().length < 2) {
    errorMessage.value = '昵称至少需要 2 个字符'
    return
  }
  if (password.value.length < 6) {
    errorMessage.value = '密码至少需要 6 位'
    return
  }
  if (!passwordMatch.value) {
    errorMessage.value = '两次输入的密码不一致'
    return
  }
  if (!agreed.value) {
    errorMessage.value = '请先阅读并同意用户协议与隐私政策'
    return
  }

  errorMessage.value = ''
  successMessage.value = ''
  submitting.value = true

  try {
    const result = await registerWithSms(
      normalizePhone(phone.value),
      code.value,
      nickname.value.trim(),
      password.value,
    )
    saveAuthSession(result)
    successMessage.value = '注册成功，正在进入工作台…'
    window.setTimeout(() => {
      router.push('/dashboard')
    }, 500)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '注册失败'
  } finally {
    submitting.value = false
  }
}

/**
 * @description 跳到登录
 * @returns {void}
 */
function goLogin(): void {
  router.push('/')
}

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <main class="auth-shell" aria-label="PanelFlow 注册">
    <!-- 左侧品牌区 1/2（公共组件） -->
    <BrandPanel episode="02" label="注册" />

    <!-- 右侧表单区 1/2 -->
    <section class="form-panel" aria-label="注册录入">
      <div class="paper-texture" aria-hidden="true"></div>

      <div class="auth-card">
        <div class="auth-tag" aria-hidden="true">创建账号 · 版本 2.0</div>

        <div class="mobile-brand" aria-hidden="true">
          <span class="mobile-brand-mark">
            <span class="material-symbols-outlined">movie_filter</span>
          </span>
          <h2>PanelFlow</h2>
        </div>

        <header class="auth-header">
          <span class="auth-eyebrow">注册</span>
          <h2 class="auth-title">创建账号</h2>
          <p class="auth-sub">完成注册后即可进入创作平台</p>
        </header>

        <form class="auth-form" @submit="handleRegister" novalidate>
          <!-- 手机号 -->
          <label class="field">
            <span class="field-label">手机号</span>
            <div class="field-box" :class="{ 'field-box-focus': !errorMessage }">
              <span class="material-symbols-outlined field-icon-left">smartphone</span>
              <input
                :value="phone"
                type="text"
                inputmode="tel"
                autocomplete="tel"
                placeholder="138 0013 8000"
                maxlength="13"
                @input="onPhoneInput(($event.target as HTMLInputElement).value)"
              />
            </div>
          </label>

          <!-- 验证码 -->
          <label class="field">
            <span class="field-label">短信验证码</span>
            <div class="code-row">
              <div class="field-box field-box-flex">
                <span class="material-symbols-outlined field-icon-left">verified_user</span>
                <input
                  :value="code"
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  placeholder="输入验证码"
                  maxlength="6"
                  @input="onCodeInput(($event.target as HTMLInputElement).value)"
                />
              </div>
              <button
                type="button"
                class="code-button"
                :class="{ 'code-button-ready': canSendCode }"
                :disabled="!canSendCode"
                @click="handleSendCode"
              >
                {{ countdown > 0 ? `重新获取 (${countdown}s)` : '获取验证码' }}
              </button>
            </div>
          </label>

          <!-- 昵称 -->
          <label class="field">
            <span class="field-label">昵称</span>
            <div class="field-box">
              <span class="material-symbols-outlined field-icon-left">person</span>
              <input
                v-model="nickname"
                type="text"
                placeholder="您的创作者名称"
                autocomplete="nickname"
              />
            </div>
          </label>

          <!-- 密码 -->
          <label class="field">
            <span class="field-label">设置密码</span>
            <div class="field-box">
              <span class="material-symbols-outlined field-icon-left">lock</span>
              <input
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="new-password"
                placeholder="至少 6 位密码"
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
          </label>

          <!-- 确认密码 -->
          <label class="field">
            <span
              class="field-label"
              :class="{ 'field-label-error': confirmPassword && !passwordMatch }"
            >确认密码</span>
            <div
              class="field-box"
              :class="{ 'field-box-error': confirmPassword && !passwordMatch }"
            >
              <span class="material-symbols-outlined field-icon-left">lock_reset</span>
              <input
                v-model="confirmPassword"
                :type="showConfirmPassword ? 'text' : 'password'"
                autocomplete="new-password"
                placeholder="再次输入密码"
              />
              <button
                type="button"
                class="icon-button"
                :aria-label="showConfirmPassword ? '隐藏密码' : '显示密码'"
                @click="showConfirmPassword = !showConfirmPassword"
              >
                <span class="material-symbols-outlined">
                  {{ showConfirmPassword ? 'visibility' : 'visibility_off' }}
                </span>
              </button>
            </div>
            <p v-if="confirmPassword && !passwordMatch" class="error-text">
              <span class="material-symbols-outlined">error</span>
              <span>两次密码输入不一致</span>
            </p>
          </label>

          <p v-if="errorMessage" class="error-text error-text--top">
            <span class="material-symbols-outlined">error</span>
            <span>{{ errorMessage }}</span>
          </p>
          <p v-if="successMessage" class="success-text">
            <span class="material-symbols-outlined">check_circle</span>
            <span>{{ successMessage }}</span>
          </p>

          <!-- 协议 -->
          <label class="terms-row">
            <input v-model="agreed" type="checkbox" class="terms-input" />
            <span class="terms-box" aria-hidden="true">
              <span class="material-symbols-outlined">check</span>
            </span>
            <span class="terms-text">
              我已阅读并同意
              <a class="terms-link" href="javascript:void(0)">用户协议</a>
              与
              <a class="terms-link" href="javascript:void(0)">隐私政策</a>
            </span>
          </label>

          <button
            type="submit"
            class="submit-button"
            :class="{ 'is-loading': submitting }"
            :disabled="!canSubmit"
          >
            <span v-if="submitting" class="spinner" aria-hidden="true"></span>
            <span class="submit-text">{{ submitting ? '注册中…' : '立即注册' }}</span>
            <span v-if="!submitting" class="material-symbols-outlined submit-arrow" aria-hidden="true">arrow_forward</span>
            <span v-if="submitting" class="shimmer" aria-hidden="true"></span>
          </button>
        </form>

        <footer class="auth-footer">
          <p>
            已有账号？
            <button type="button" class="link-button" @click="goLogin">去登录</button>
          </p>
        </footer>
      </div>
    </section>
  </main>
</template>

<style scoped>
/* =====================================================================
 * 注册页 - Darkroom Professional 片场控制台
 * 设计来源：stitch_panelflow_creative_studio/pf_00_2/code.html
 * 设计原则：
 *  1. 1:1 双栏布局（与登录页保持一致，遵循 pf_00_2 原稿）
 *  2. 硬边 border-radius 0
 *  3. 品牌区与登录完全一致（统一设计语言）
 *  4. 注册字段图标在左（与原设计一致）
 *  5. 多视口响应式：375/768/900/1024/1280/1440/1920
 * ===================================================================== */

/* ---------- CSS 变量（设计 Token，与 Login 一致） ---------- */
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
  --color-success: #96ccff;

  --font-display: 'Playfair Display', 'Noto Serif SC', serif;
  --font-body: 'Noto Sans', 'Noto Sans SC', sans-serif;
}

/* ----- 外层 ----- */
.auth-shell {
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
 * 品牌区样式已抽出到 <BrandPanel> 公共组件
 * ===================================================================== */

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
  overflow: hidden;
}

/* 表单区微光：顶部径向高光（与登录页一致） */
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
  max-width: 28rem; /* 448px - 注册字段多 */
  padding: 0.5rem 0 0;
  z-index: 1;
  animation: rise 800ms cubic-bezier(0.16, 1, 0.3, 1) both;
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

.auth-header {
  margin-bottom: 1.75rem;
}

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
  font-size: clamp(1.625rem, 2.2vw, 1.875rem);
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
.auth-form {
  display: grid;
  gap: 1.125rem;
}

.field {
  display: grid;
  gap: 0.4rem;
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

.field-label-error {
  color: var(--color-danger-soft);
}

.field-box {
  position: relative;
  display: flex;
  align-items: center;
  border: 1px solid var(--color-outline);
  background: var(--color-charcoal);
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease,
    transform 0.2s ease;
}

.field-box:hover { border-color: var(--color-text-mute); background: #1f201e; }

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

.field-box-flex { flex: 1; }

.field-box input {
  flex: 1;
  width: 100%;
  border: none;
  background: transparent;
  padding: 0.875rem 1rem 0.875rem 2.875rem;
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: 0.9375rem;
  line-height: 1.5;
  caret-color: var(--color-primary-strong);
  outline: none;
}

/* 昵称和密码字段不需要左图标时，单独处理 */
.field-box:not(:has(.field-icon-left)) input {
  padding-left: 1rem;
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
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
  transition: color 0.2s ease;
}

.field-box:focus-within .field-icon-left { color: var(--color-primary-strong); }

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
  transition: color 0.18s ease;
}

.icon-button:hover,
.icon-button:focus-visible { color: var(--color-primary-strong); }

.icon-button .material-symbols-outlined {
  font-size: 20px;
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}

/* 短信行 */
.code-row {
  display: flex;
  align-items: stretch;
}

.code-row .field-box { flex: 1; }

.code-button {
  flex-shrink: 0;
  min-width: 8.5rem;
  border: 1px solid var(--color-outline);
  border-left: none;
  background: #292a28;
  color: var(--color-text-faint);
  padding: 0 1rem;
  font-family: var(--font-body);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
}

.code-button-ready {
  color: #e6c18c;
  background: #232420;
}

.code-button-ready:hover {
  color: var(--color-primary);
  border-color: var(--color-primary-strong);
  background: #1e201e;
}

.code-button:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

/* 协议 */
.terms-row {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.25rem 0;
  cursor: pointer;
}

.terms-input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
  width: 0;
  height: 0;
}

.terms-box {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--color-bronze);
  background: rgba(217, 119, 6, 0.18);
  color: var(--color-primary-strong);
  flex-shrink: 0;
  margin-top: 1px;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.terms-input:checked + .terms-box {
  background: var(--color-primary-strong);
  border-color: var(--color-primary-strong);
  color: #2f1500;
}

.terms-input:checked + .terms-box .material-symbols-outlined {
  opacity: 1;
  font-variation-settings: 'FILL' 1, 'wght' 700, 'GRAD' 0, 'opsz' 24;
}

.terms-box .material-symbols-outlined {
  font-size: 14px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.terms-text {
  font-family: var(--font-body);
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-text-mute);
  user-select: none;
}

.terms-link {
  color: #e6c18c;
  text-decoration: none;
  font-weight: 600;
  transition: color 0.15s ease;
}

.terms-link:hover {
  color: var(--color-primary);
  text-decoration: underline;
}

/* 提示文本 */
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

.error-text .material-symbols-outlined { font-size: 14px; }

.success-text {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.625rem 0.875rem;
  background: rgba(150, 204, 255, 0.08);
  border: 1px solid rgba(150, 204, 255, 0.4);
  font-family: var(--font-body);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-success);
  letter-spacing: 0.02em;
}

.success-text .material-symbols-outlined { font-size: 16px; }

/* 提交按钮 */
.submit-button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  width: 100%;
  padding: 1.0625rem 1.25rem;
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
  margin-top: 0.375rem;
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

.submit-button.is-loading {
  cursor: progress;
}

.submit-text {
  display: inline-block;
}

.submit-arrow {
  font-size: 18px;
  font-variation-settings: 'FILL' 0, 'wght' 600, 'GRAD' 0, 'opsz' 24;
  transition: transform 0.2s ease;
}

.submit-button:hover:not(:disabled) .submit-arrow {
  transform: translateX(3px);
}

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

/* 底部链接 */
.auth-footer {
  margin-top: 1.75rem;
  padding-top: 1.5rem;
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
 *  - ≥1920 大屏
 *  - 1440-1919 标准桌面
 *  - 1280-1439 紧凑桌面
 *  - 1024-1279 桌面最低（关键适配点）
 *  - 768-1023 平板
 *  - 480-767 手机
 *  - <480 小屏
 * ===================================================================== */

/* ≥1920 大屏 */
@media (min-width: 1920px) {
  :deep(.brand-content) { padding: 5rem 5rem !important; }
  :deep(.brand-meta) { grid-template-columns: repeat(4, minmax(0, 1fr)) !important; }
  .auth-card { max-width: 30rem; }
  .form-panel { padding: 3rem 2.5rem; }
}

/* 1440-1919 标准桌面 */
@media (min-width: 1440px) and (max-width: 1919px) {
  .auth-card { max-width: 28.5rem; }
}

/* 1280-1439 紧凑桌面 */
@media (min-width: 1280px) and (max-width: 1439px) {
  :deep(.brand-content) { padding: 3rem 2.75rem !important; gap: 1.5rem !important; }
  :deep(.brand-headline) { font-size: clamp(2.25rem, 3.4vw, 2.75rem) !important; }
  :deep(.brand-desc) { font-size: 1rem !important; }
  :deep(.brand-meta) {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 0.875rem 1.25rem !important;
  }
  :deep(.brand-mega-num) { font-size: clamp(6rem, 9vw, 9rem) !important; }
  .auth-card { max-width: 26.5rem; }
}

/* 1024-1279 桌面最低：brand-content 紧凑 + 字号缩小 */
@media (min-width: 1024px) and (max-width: 1279px) {
  :deep(.brand-content) { padding: 2.25rem 2.25rem !important; gap: 1.25rem !important; }
  :deep(.brand-headline) { font-size: 2.125rem !important; line-height: 1.1 !important; }
  :deep(.brand-eyebrow) { margin-bottom: 1rem !important; }
  :deep(.brand-desc) { font-size: 0.9375rem !important; line-height: 1.55 !important; margin-bottom: 1.5rem !important; }
  :deep(.brand-meta) {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 0.75rem 1rem !important;
    padding-top: 1rem !important;
  }
  :deep(.brand-meta-item dt) { font-size: 0.5625rem !important; letter-spacing: 0.16em !important; }
  :deep(.brand-meta-item dd) { font-size: 0.8125rem !important; }
  :deep(.brand-mid) { max-width: 100% !important; }
  :deep(.brand-mega-num) { font-size: clamp(5.5rem, 8vw, 7.5rem) !important; }
  :deep(.brand-mega-prefix) { font-size: 1.25rem !important; }
  :deep(.brand-corner) { width: 14px; height: 14px; }
  :deep(.brand-tick) { left: 2.25rem !important; right: 2.25rem !important; }
  .auth-card { max-width: 24.5rem; }
  .form-panel { padding: 1.75rem 1.25rem; }
  .auth-title { font-size: 1.625rem; }
  .auth-form { gap: 1rem; }
}

/* <1024 移动端 */
@media (max-width: 1023px) {
  .form-panel { width: 100%; }
  .auth-tag { right: 0.5rem; top: -1rem; font-size: 0.65rem; }
}

/* 768-1023 平板 */
@media (min-width: 768px) and (max-width: 1023px) {
  .form-panel { padding: 3rem 2rem; }
  .auth-card { max-width: 30rem; }
  .auth-title { font-size: 1.75rem; }
}

/* 480-767 大屏手机 */
@media (max-width: 767px) {
  .form-panel { padding: 2rem 1.25rem; }
  .auth-card { max-width: 100%; }
  .auth-title { font-size: 1.5rem; }
  .auth-sub { font-size: 0.875rem; }
  .auth-footer { margin-top: 1.5rem; padding-top: 1.25rem; }
  .auth-form { gap: 1rem; }
}

/* <480 小屏手机 */
@media (max-width: 479px) {
  .form-panel { padding: 1.5rem 1rem; }
  .auth-card { padding: 0; }
  .auth-tag { right: 0.5rem; padding: 0.4rem 0.75rem; font-size: 0.6rem; }
  .mobile-brand { padding: 0.75rem; }
  .mobile-brand h2 { font-size: 1.25rem; }
  .auth-form { gap: 0.875rem; }
  .field-box input { padding: 0.8125rem 0.875rem 0.8125rem 2.625rem; font-size: 0.875rem; }
  .field-box:not(:has(.field-icon-left)) input { padding-left: 0.875rem; }
  .code-button { min-width: 7rem; padding: 0 0.625rem; font-size: 0.6875rem; }
  .submit-button { padding: 1rem 1rem; font-size: 0.75rem; letter-spacing: 0.14em; }
  .code-row { flex-direction: row; gap: 0.5rem; }
  .auth-title { font-size: 1.375rem; }
  .auth-header { margin-bottom: 1.5rem; }
  .auth-sub { font-size: 0.8125rem; }
}

/* 高对比 / 减弱动效 */
@media (prefers-reduced-motion: reduce) {
  :deep(.brand-bg),
  :deep(.brand-status-dot),
  :deep(.brand-top),
  :deep(.brand-mid),
  :deep(.brand-bottom),
  .auth-card,
  .field-box,
  .spinner,
  .shimmer {
    animation: none !important;
    transform: none !important;
  }
}

/* 焦点可见性 */
.submit-button:focus-visible,
.code-button:focus-visible,
.link-button:focus-visible,
.icon-button:focus-visible,
.terms-row:focus-within .terms-box {
  outline: none;
  box-shadow:
    0 0 0 2px rgba(255, 183, 125, 0.6),
    0 0 0 4px rgba(217, 119, 7, 0.4);
}
</style>
