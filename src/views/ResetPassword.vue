<!--
  @file PanelFlow 重置密码 - 步骤 2：设置新密码
  @description 忘记密码流程第二步：使用 <BrandPanel> 公共组件（与登录/注册/找回完全一致）。
               接收手机号 + 验证码（来自 query），用户输入新密码与确认密码，
               提交后调用 resetPassword API，成功后自动跳转回登录页。
  @author PanelFlow Studio
-->
<script setup lang="ts">
/**
 * @file <script setup> 段负责重置密码的表单与跳转逻辑
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { resetPassword } from '@/api/auth'
import BrandPanel from '@/components/BrandPanel.vue'

const router = useRouter()
const route = useRoute()

/** 从 query 取出手机号与验证码 */
const phone = typeof route.query.phone === 'string' ? route.query.phone : ''
const code = typeof route.query.code === 'string' ? route.query.code : ''

/** 表单状态 */
const newPassword = ref('')
const confirmPassword = ref('')
const showPassword = ref(false)
const showConfirmPassword = ref(false)
const submitting = ref(false)
const successMessage = ref('')
const errorMessage = ref('')

/** 字段级错误 */
const newPasswordError = ref('')
const confirmPasswordError = ref('')

/**
 * 校验：手机号或验证码缺失则视为异常流程，跳回上一步
 * @returns {void}
 */
if (!phone || !code) {
  router.replace('/forgot-password')
}

/**
 * 密码强度：长度 + 复杂度
 * @returns {{ level: 0|1|2|3, label: string }}
 */
const passwordStrength = computed(() => {
  const pwd = newPassword.value
  if (pwd.length === 0) return { level: 0, label: '' }
  let score = 0
  if (pwd.length >= 6) score += 1
  if (pwd.length >= 10) score += 1
  if (/[A-Z]/.test(pwd)) score += 1
  if (/[0-9]/.test(pwd)) score += 1
  if (/[^A-Za-z0-9]/.test(pwd)) score += 1
  if (score <= 1) return { level: 1, label: '弱' }
  if (score <= 3) return { level: 2, label: '中' }
  return { level: 3, label: '强' }
})

/** 两次密码是否一致 */
const passwordMatch = computed(
  () => newPassword.value.length >= 6 && newPassword.value === confirmPassword.value,
)

/** 提交按钮可用性 */
const canSubmit = computed(
  () => !submitting.value && newPassword.value.length >= 6 && passwordMatch.value,
)

/**
 * @description 提交重置密码
 * @param {Event} e 表单事件
 * @returns {Promise<void>}
 */
async function handleReset(e: Event): Promise<void> {
  e.preventDefault()
  if (submitting.value || !canSubmit.value) return

  if (newPassword.value.length < 6) {
    newPasswordError.value = '密码至少 6 位'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    confirmPasswordError.value = '两次输入的密码不一致'
    return
  }

  errorMessage.value = ''
  successMessage.value = ''
  submitting.value = true

  try {
    await resetPassword(phone, code, newPassword.value)
    successMessage.value = '密码重置成功，正在跳转登录…'
    // 1.5s 后跳回登录页
    window.setTimeout(() => {
      router.replace('/')
    }, 1500)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '重置失败，请重试'
  } finally {
    submitting.value = false
  }
}

/**
 * @description 返回上一步
 * @returns {void}
 */
function goBack(): void {
  router.push('/forgot-password')
}

/**
 * @description 跳到登录页（立即）
 * @returns {void}
 */
function goLogin(): void {
  router.replace('/')
}
</script>

<template>
  <main class="auth-shell" aria-label="PanelFlow 重置密码">
    <!-- 左侧品牌区 1/2（公共组件） -->
    <BrandPanel episode="04" label="重置密码" />

    <!-- 右侧表单卡 -->
    <section class="form-panel" aria-label="设置新密码">
      <div class="paper-texture" aria-hidden="true"></div>

      <div class="auth-card">
        <div class="auth-tag" aria-hidden="true">找回密码 · 第二步</div>

        <div class="mobile-brand" aria-hidden="true">
          <span class="mobile-brand-mark">
            <span class="material-symbols-outlined">movie_filter</span>
          </span>
          <h2>PanelFlow</h2>
        </div>

        <!-- 进度条 -->
        <ol class="stepper" aria-label="进度">
          <li class="step is-done">
            <span class="step-num">
              <span class="material-symbols-outlined">check</span>
            </span>
            <span class="step-label">验证手机</span>
          </li>
          <li class="step-sep" aria-hidden="true"></li>
          <li class="step is-active">
            <span class="step-num">02</span>
            <span class="step-label">设置新密码</span>
          </li>
        </ol>

        <header class="auth-header">
          <span class="auth-eyebrow">重置密码</span>
          <h1 class="auth-title">设置新密码</h1>
          <p class="auth-sub">
            正在为手机号 <strong class="phone-mask">{{ phone }}</strong> 设置新密码
          </p>
        </header>

        <form class="auth-form" @submit="handleReset" novalidate>
          <!-- 新密码 -->
          <label class="field">
            <span class="field-label">新密码</span>
            <div class="field-box" :class="{ 'field-box-error': newPasswordError }">
              <span class="material-symbols-outlined field-icon-left">lock</span>
              <input
                v-model="newPassword"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="new-password"
                placeholder="至少 6 位，建议字母 + 数字组合"
                @input="newPasswordError = ''"
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
            <!-- 强度指示 -->
            <div v-if="newPassword" class="strength" :data-level="passwordStrength.level">
              <span class="strength-bar"></span>
              <span class="strength-bar"></span>
              <span class="strength-bar"></span>
              <span class="strength-label">强度：{{ passwordStrength.label }}</span>
            </div>
            <p v-if="newPasswordError" class="error-text">
              <span class="material-symbols-outlined">error</span>
              <span>{{ newPasswordError }}</span>
            </p>
          </label>

          <!-- 确认密码 -->
          <label class="field">
            <span class="field-label">确认新密码</span>
            <div
              class="field-box"
              :class="{ 'field-box-error': confirmPasswordError || (confirmPassword && !passwordMatch) }"
            >
              <span class="material-symbols-outlined field-icon-left">lock_reset</span>
              <input
                v-model="confirmPassword"
                :type="showConfirmPassword ? 'text' : 'password'"
                autocomplete="new-password"
                placeholder="再次输入新密码"
                @input="confirmPasswordError = ''"
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
            <p v-if="confirmPasswordError || (confirmPassword && !passwordMatch)" class="error-text">
              <span class="material-symbols-outlined">error</span>
              <span>{{ confirmPasswordError || '两次输入的密码不一致' }}</span>
            </p>
          </label>

          <!-- 成功提示 -->
          <p v-if="successMessage" class="success-banner">
            <span class="material-symbols-outlined">check_circle</span>
            <span>{{ successMessage }}</span>
          </p>

          <!-- 顶层错误提示 -->
          <p v-if="errorMessage" class="error-text error-text--top">
            <span class="material-symbols-outlined">error</span>
            <span>{{ errorMessage }}</span>
          </p>

          <!-- 操作按钮组 -->
          <div class="action-row">
            <button
              type="button"
              class="ghost-button"
              :disabled="submitting"
              @click="goBack"
            >
              <span class="material-symbols-outlined">arrow_back</span>
              <span>上一步</span>
            </button>
            <button
              type="submit"
              class="submit-button"
              :class="{ 'is-loading': submitting }"
              :disabled="!canSubmit"
            >
              <span v-if="submitting" class="spinner" aria-hidden="true"></span>
              <span>{{ submitting ? '重置中…' : '完成重置' }}</span>
            </button>
          </div>
        </form>

        <footer class="auth-footer">
          <p>
            重置完成？
            <button type="button" class="link-button" @click="goLogin">立即登录</button>
          </p>
        </footer>
      </div>
    </section>
  </main>
</template>

<style scoped>
/* =====================================================================
 * 重置密码页 - Darkroom Professional
 *  - 品牌区已抽出到 <BrandPanel>
 *  - 表单卡强化"已完成第 1 步" + "正在第 2 步"的双重指示
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
.step.is-active { color: var(--color-primary-strong); }
.step.is-done   { color: var(--color-text-mute); }

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
.step.is-done .step-num {
  background: var(--color-text-mute);
  border-color: var(--color-text-mute);
  color: #1B1C1A;
}
.step.is-done .step-num .material-symbols-outlined {
  font-size: 14px;
  font-variation-settings: 'FILL' 1, 'wght' 700, 'GRAD' 0, 'opsz' 24;
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

.phone-mask {
  color: var(--color-primary);
  font-weight: 700;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  letter-spacing: 0.04em;
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
.field-box input {
  flex: 1;
  width: 100%;
  border: none;
  background: transparent;
  padding: 1rem 3.5rem 1rem 3rem;
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

/* 密码强度 */
.strength {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  margin-top: 0.25rem;
}
.strength-bar {
  display: inline-block;
  width: 2.25rem;
  height: 4px;
  background: #292a28;
  transition: background-color 0.2s ease;
}
.strength[data-level="1"] .strength-bar:nth-child(-n+1) { background: var(--color-danger); }
.strength[data-level="2"] .strength-bar:nth-child(-n+2) { background: var(--color-primary-strong); }
.strength[data-level="3"] .strength-bar { background: var(--color-success); }
.strength-label {
  margin-left: 0.5rem;
  font-family: var(--font-body);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--color-text-mute);
  text-transform: uppercase;
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

/* 成功提示 */
.success-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.75rem 1rem;
  background: rgba(150, 204, 255, 0.08);
  border: 1px solid rgba(150, 204, 255, 0.4);
  font-family: var(--font-body);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-success);
}
.success-banner .material-symbols-outlined { font-size: 18px; }

/* 操作按钮组 */
.action-row {
  display: flex;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.ghost-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  flex: 0 0 auto;
  padding: 1.125rem 1.25rem;
  background: transparent;
  border: 1px solid var(--color-outline);
  color: var(--color-text-soft);
  font-family: var(--font-body);
  font-size: 0.8125rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  cursor: pointer;
  transition: border-color 0.2s ease, color 0.2s ease, background 0.2s ease;
}
.ghost-button:hover:not(:disabled) {
  border-color: var(--color-text-mute);
  color: var(--color-text);
  background: rgba(255, 255, 255, 0.02);
}
.ghost-button:disabled { cursor: not-allowed; opacity: 0.5; }
.ghost-button .material-symbols-outlined { font-size: 18px; }

.submit-button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  flex: 1 1 auto;
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
  transition: background-color 0.2s ease, color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
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
.submit-button.is-loading { cursor: progress; }

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
  .action-row { flex-direction: column-reverse; }
  .ghost-button { padding: 0.875rem 1rem; }
}
@media (max-width: 479px) {
  .form-panel { padding: 1.5rem 1rem; }
  .auth-card { padding: 0; }
  .auth-tag { right: 0.5rem; padding: 0.4rem 0.75rem; font-size: 0.6rem; }
  .mobile-brand { padding: 0.75rem; }
  .mobile-brand h2 { font-size: 1.25rem; }
  .auth-form { gap: 1.125rem; }
  .field-box input { padding: 0.875rem 3.25rem 0.875rem 2.625rem; font-size: 0.875rem; }
}

@media (prefers-reduced-motion: reduce) {
  :deep(.brand-bg),
  :deep(.brand-status-dot),
  :deep(.brand-top),
  :deep(.brand-mid),
  :deep(.brand-bottom),
  .auth-card,
  .spinner {
    animation: none !important;
    transform: none !important;
  }
}

.submit-button:focus-visible,
.ghost-button:focus-visible,
.icon-button:focus-visible,
.link-button:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px rgba(255, 183, 125, 0.6),
    0 0 0 4px rgba(217, 119, 7, 0.4);
}
</style>
