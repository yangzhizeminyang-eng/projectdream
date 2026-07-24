export const AUTH_TOKEN_STORAGE_KEY = 'projectdream_token'
export const AUTH_USER_STORAGE_KEY = 'projectdream_user'

const API_BASE_URL = `${import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3001/api'}`.replace(
  /\/$/,
  '',
)
const API_CONNECT_RETRY_DELAYS_MS = [300, 800, 1500, 2500, 4000]

interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

export interface AuthUser {
  id: number
  phone: string
  nickname: string
  createdAt: string
}

export interface AuthResult {
  token: string
  user: AuthUser
}

export interface SendCodeResult {
  countdown: number
  expiresIn: number
  devCode?: string
  provider?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function fetchWithConnectRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= API_CONNECT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetch(url, init)
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      lastError = error
      const delayMs = API_CONNECT_RETRY_DELAYS_MS[attempt]
      if (delayMs == null) break
      await sleep(delayMs)
    }
  }
  throw lastError instanceof Error ? lastError : new TypeError('fetch failed')
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response

  try {
    response = await fetchWithConnectRetry(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    })
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('后端连接暂时不可用，请确认服务正在运行')
    }
    throw error
  }

  const payload = (await response.json()) as ApiResponse<T> | { code?: number; message?: string }

  if (!response.ok || ('code' in payload && payload.code !== 0)) {
    throw new Error('message' in payload && payload.message ? payload.message : '请求失败')
  }

  return (payload as ApiResponse<T>).data
}

export function sendSmsCode(phone: string, type: 'login' | 'register' | 'reset') {
  return request<SendCodeResult>('/auth/send-code', {
    method: 'POST',
    body: JSON.stringify({ phone, type }),
  })
}

export function loginWithSms(phone: string, code: string) {
  return request<AuthResult>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone, code }),
  })
}

/**
 * @description 手机号 + 密码登录
 * @param {string} phone 11 位手机号
 * @param {string} password 登录密码
 * @returns {Promise<AuthResult>} 包含 token 与 user 信息
 */
export function loginWithPassword(phone: string, password: string) {
  return request<AuthResult>('/auth/login-password', {
    method: 'POST',
    body: JSON.stringify({ phone, password }),
  })
}

export function registerWithSms(phone: string, code: string, nickname: string, password: string) {
  return request<AuthResult>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ phone, code, nickname, password }),
  })
}

/**
 * @description 重置密码：手机号 + 验证码 + 新密码
 * @param {string} phone 11 位手机号
 * @param {string} code 6 位短信验证码
 * @param {string} newPassword 新密码（至少 6 位）
 * @returns {Promise<{ success: boolean }>} 重置结果
 */
export function resetPassword(phone: string, code: string, newPassword: string) {
  return request<{ success: boolean }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ phone, code, newPassword }),
  })
}

export function checkPhone(phone: string) {
  return request<{ exists: boolean }>(`/auth/check-phone?phone=${encodeURIComponent(phone)}`)
}

export function saveAuthSession(result: AuthResult) {
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, result.token)
  localStorage.setItem(AUTH_USER_STORAGE_KEY, JSON.stringify(result.user))
}

export function getAuthToken(): string {
  return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim() || ''
}

export function getAuthUser(): AuthUser | null {
  const raw = localStorage.getItem(AUTH_USER_STORAGE_KEY)
  if (!raw) return null

  try {
    return JSON.parse(raw) as AuthUser
  } catch {
    localStorage.removeItem(AUTH_USER_STORAGE_KEY)
    return null
  }
}

export function hasAuthSession(): boolean {
  return Boolean(getAuthToken())
}

/**
 * @description 清除本地登录态
 * @returns {void}
 */
export function clearAuthSession(): void {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
  localStorage.removeItem(AUTH_USER_STORAGE_KEY)
}
