<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { loginWithPassword, loginWithSms, saveAuthSession, sendSmsCode } from '@/api/auth'
import CaptchaSlider from '@/components/auth/CaptchaSlider.vue'

type LoginMode = 'sms' | 'password'

const router = useRouter()

const loginOpen = ref(false)
const loginModal = ref<HTMLElement | null>(null)
const returnFocusTarget = ref<HTMLElement | null>(null)
const mode = ref<LoginMode>('sms')
const phone = ref('')
const code = ref('')
const password = ref('')
const showPassword = ref(false)
const countdown = ref(0)
const submitting = ref(false)
const sendingCode = ref(false)
const errorMessage = ref('')
const phoneError = ref('')
const codeError = ref('')
const passwordError = ref('')
const codeHint = ref('')
const captchaToken = ref('')
const activeStage = ref(0)
const navOnLightSection = ref(false)
const closeParticleField = ref<HTMLCanvasElement | null>(null)
const heroImageUrl = '/images/login-hero-clean.webp'
const characterAssetBoardUrl = '/images/landing-character-board-linzixia-v1.jpg'
const loginImageUrl = '/images/landing-night-room-v1.webp'
const workflowFrames = [
  { src: characterAssetBoardUrl, label: '角色设定', meta: '角色资产板 · 五视图', alt: '林知夏角色资产板：全身、脸部特写、正面、侧面与背面设定' },
  { src: '/images/workflow-storyboard-frame.webp', label: '分镜脚本', meta: '镜头节奏', alt: '悬疑漫剧中的双人对峙镜头' },
  { src: '/images/workflow-film-frame.webp', label: '成片镜头', meta: '9:16 · 24 FPS', alt: '悬疑漫剧成片中的双人对峙镜头' },
]
const currentWorkflowFrame = computed(() => workflowFrames[activeStage.value] ?? workflowFrames[0]!)

let countdownTimer: number | undefined
let workflowObserver: IntersectionObserver | undefined
let scrollRevealObserver: IntersectionObserver | undefined
let closeParticleCleanup: (() => void) | undefined
let navThemeFrame = 0
let scrollRevealScanFrame = 0
let pageScrollContainer: HTMLElement | null = null

const normalizedPhone = computed(() => phone.value.replace(/\D/g, ''))
const phoneValid = computed(() => /^1\d{10}$/.test(normalizedPhone.value))
const canSubmit = computed(() => {
  if (submitting.value || !phoneValid.value) return false
  return mode.value === 'sms' ? /^\d{6}$/.test(code.value) : password.value.length >= 6
})

function mountCloseParticleField(canvas: HTMLCanvasElement): () => void {
  const canvasContext = canvas.getContext('2d')
  if (!canvasContext) return () => undefined
  const context = canvasContext

  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
  let width = 0
  let height = 0
  let pixelRatio = 1
  let frameId = 0
  let lastFrame = 0
  let visible = !('IntersectionObserver' in window)

  const colors = [
    'rgba(199, 213, 207, 0.12)',
    'rgba(199, 213, 207, 0.23)',
    'rgba(220, 224, 216, 0.38)',
    'rgba(226, 123, 77, 0.55)',
    'rgba(255, 224, 195, 0.82)',
  ]

  function draw(time: number): void {
    if (!width || !height) return
    context.clearRect(0, 0, width, height)
    const spacing = width < 600 ? 15 : 18
    const paths = Array.from({ length: colors.length }, () => new Path2D())
    const phaseTime = time * 0.00055

    for (let y = spacing / 2; y < height; y += spacing) {
      for (let x = spacing / 2; x < width; x += spacing) {
        const nx = x / width
        const ny = y / height
        const crest = Math.max(0, Math.cos(nx * 8.4 + ny * 2.1 - phaseTime)) ** 12
        const crossWave = Math.max(0, Math.cos(nx * 4.1 - ny * 5.3 + phaseTime * 0.62)) ** 16
        const edgeFade = Math.min(1, ny * 3.2, (1 - ny) * 3.5, nx * 2.8, (1 - nx) * 2.8)
        const intensity = (0.1 + crest * 0.62 + crossWave * 0.28) * Math.max(0, edgeFade)
        const bucket = Math.min(colors.length - 1, Math.floor(intensity * colors.length))
        const radius = 0.62 + intensity * 0.72
        const displacement = Math.sin(nx * 8.4 + ny * 2.1 - phaseTime) * (crest + crossWave) * 2.1
        const dotY = y + displacement
        paths[bucket]!.moveTo(x + radius, dotY)
        paths[bucket]!.arc(x, dotY, radius, 0, Math.PI * 2)
      }
    }

    paths.forEach((path, index) => {
      context.fillStyle = colors[index]!
      context.fill(path)
    })
  }

  function resize(): void {
    const bounds = canvas.getBoundingClientRect()
    width = bounds.width
    height = bounds.height
    pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5)
    canvas.width = Math.round(width * pixelRatio)
    canvas.height = Math.round(height * pixelRatio)
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    draw(0)
  }

  function stop(): void {
    if (!frameId) return
    window.cancelAnimationFrame(frameId)
    frameId = 0
  }

  function animate(time: number): void {
    frameId = 0
    if (!visible || document.hidden || motionPreference.matches) return
    if (time - lastFrame < 33) {
      frameId = window.requestAnimationFrame(animate)
      return
    }
    lastFrame = time
    draw(time)
    frameId = window.requestAnimationFrame(animate)
  }

  function updatePlayback(): void {
    if (visible && !document.hidden && !motionPreference.matches) {
      if (!frameId) frameId = window.requestAnimationFrame(animate)
    } else {
      stop()
    }
  }

  const intersectionObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting)
      updatePlayback()
    }, { threshold: 0.01 })
    : undefined
  const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(resize) : undefined
  const handleVisibilityChange = () => updatePlayback()
  const handleMotionChange = () => {
    if (motionPreference.matches) draw(0)
    updatePlayback()
  }

  intersectionObserver?.observe(canvas)
  resizeObserver?.observe(canvas)
  if (!resizeObserver) window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  motionPreference.addEventListener('change', handleMotionChange)
  resize()

  return () => {
    stop()
    intersectionObserver?.disconnect()
    resizeObserver?.disconnect()
    if (!resizeObserver) window.removeEventListener('resize', resize)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    motionPreference.removeEventListener('change', handleMotionChange)
  }
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, '').slice(0, 11)
}

function formatPhone(value: string): string {
  const normalized = normalizePhone(value)
  return normalized.replace(/^(\d{0,3})(\d{0,4})(\d{0,4}).*$/, (_, first: string, second: string, third: string) =>
    [first, second, third].filter(Boolean).join(' '),
  )
}

function clearErrors(): void {
  errorMessage.value = ''
  phoneError.value = ''
  codeError.value = ''
  passwordError.value = ''
}

function onPhoneInput(value: string): void {
  phone.value = formatPhone(value)
  captchaToken.value = ''
  clearErrors()
}

function onCodeInput(value: string): void {
  code.value = value.replace(/\D/g, '').slice(0, 6)
  codeError.value = ''
  errorMessage.value = ''
}

function onPasswordInput(): void {
  passwordError.value = ''
  errorMessage.value = ''
}

function switchMode(nextMode: LoginMode): void {
  mode.value = nextMode
  clearErrors()
  codeHint.value = ''
}

function openLogin(event?: Event): void {
  returnFocusTarget.value = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null
  loginOpen.value = true
}

function closeLogin(): void {
  loginOpen.value = false
  clearErrors()
}

function getFocusableElements(): HTMLElement[] {
  if (!loginModal.value) return []

  return Array.from(
    loginModal.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  )
}

function handleModalKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return

  const focusableElements = getFocusableElements()
  if (!focusableElements.length) return

  const firstElement = focusableElements.at(0)
  const lastElement = focusableElements.at(-1)
  if (!firstElement || !lastElement) return

  if (event.shiftKey && document.activeElement === firstElement) {
    event.preventDefault()
    lastElement.focus()
  } else if (!event.shiftKey && document.activeElement === lastElement) {
    event.preventDefault()
    firstElement.focus()
  }
}

function goRegister(): void {
  router.push('/register')
}

function goForgot(): void {
  const phoneNumber = normalizedPhone.value
  router.push({ path: '/forgot-password', query: phoneNumber ? { phone: phoneNumber } : {} })
}

function startCountdown(seconds: number): void {
  if (countdownTimer) {
    window.clearInterval(countdownTimer)
  }

  countdown.value = seconds
  countdownTimer = window.setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0 && countdownTimer) {
      window.clearInterval(countdownTimer)
      countdownTimer = undefined
      countdown.value = 0
    }
  }, 1000)
}

async function handleSendCode(): Promise<void> {
  if (sendingCode.value || countdown.value > 0) return

  if (!phoneValid.value) {
    phoneError.value = '请输入正确的 11 位手机号'
    return
  }

  sendingCode.value = true
  clearErrors()

  try {
    if (!captchaToken.value) {
      errorMessage.value = '请先完成滑块验证'
      return
    }
    const result = await sendSmsCode(normalizedPhone.value, 'login', captchaToken.value)
    captchaToken.value = ''
    startCountdown(result.countdown || 60)
    codeHint.value = result.devCode
      ? `开发环境验证码：${result.devCode}`
      : '验证码已发送，请注意查收短信'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '验证码发送失败，请重试'
  } finally {
    sendingCode.value = false
  }
}

async function handleLogin(event: Event): Promise<void> {
  event.preventDefault()

  if (!canSubmit.value) {
    if (!phoneValid.value) phoneError.value = '请输入正确的 11 位手机号'
    if (mode.value === 'sms' && !/^\d{6}$/.test(code.value)) codeError.value = '请输入 6 位短信验证码'
    if (mode.value === 'password' && password.value.length < 6) passwordError.value = '密码至少 6 位'
    return
  }

  submitting.value = true
  clearErrors()

  try {
    const result =
      mode.value === 'sms'
        ? await loginWithSms(normalizedPhone.value, code.value)
        : await loginWithPassword(normalizedPhone.value, password.value)

    saveAuthSession(result)
    router.push('/dashboard')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '登录失败，请重试'
  } finally {
    submitting.value = false
  }
}

onUnmounted(() => {
  if (countdownTimer) window.clearInterval(countdownTimer)
  workflowObserver?.disconnect()
  scrollRevealObserver?.disconnect()
  closeParticleCleanup?.()
  pageScrollContainer?.removeEventListener('scroll', scheduleNavThemeUpdate)
  pageScrollContainer?.removeEventListener('scroll', scheduleScrollRevealScan)
  window.removeEventListener('pageshow', scheduleRestoredScrollRevealScan)
  if (navThemeFrame) window.cancelAnimationFrame(navThemeFrame)
  if (scrollRevealScanFrame) window.cancelAnimationFrame(scrollRevealScanFrame)
})

function scheduleNavThemeUpdate(): void {
  if (navThemeFrame) return
  navThemeFrame = window.requestAnimationFrame(() => {
    navThemeFrame = 0
    const nav = document.querySelector<HTMLElement>('.portal-nav')
    const workflow = document.querySelector<HTMLElement>('#workflow')
    const close = document.querySelector<HTMLElement>('.portal-close')
    if (!nav || !workflow || !close) return

    const navHeight = nav.offsetHeight
    const navBottom = nav.getBoundingClientRect().bottom
    navOnLightSection.value = workflow.getBoundingClientRect().top <= navBottom
      && close.getBoundingClientRect().top > navBottom
  })
}

function scheduleScrollRevealScan(): void {
  if (scrollRevealScanFrame) return

  scrollRevealScanFrame = window.requestAnimationFrame(() => {
    scrollRevealScanFrame = 0
    const rootBounds = pageScrollContainer?.getBoundingClientRect()
    if (!rootBounds) return
    const revealBandTop = rootBounds.top + rootBounds.height * 0.2
    const revealBandBottom = rootBounds.bottom - rootBounds.height * 0.2

    document.querySelectorAll<HTMLElement>('[data-scroll-reveal]:not(.is-scroll-revealed)').forEach((target) => {
      const bounds = target.getBoundingClientRect()
      const visibleInRevealBand = Math.max(0, Math.min(bounds.bottom, revealBandBottom) - Math.max(bounds.top, revealBandTop))
      if (visibleInRevealBand / Math.max(1, bounds.height) < 0.2) return
      target.classList.add('is-scroll-revealed')
      scrollRevealObserver?.unobserve(target)
    })
  })
}

function scheduleRestoredScrollRevealScan(): void {
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (scrollRevealScanFrame) window.cancelAnimationFrame(scrollRevealScanFrame)
    scrollRevealScanFrame = 0
    scheduleScrollRevealScan()
  }))
}

onMounted(() => {
  pageScrollContainer = document.querySelector<HTMLElement>('#app')
  pageScrollContainer?.addEventListener('scroll', scheduleNavThemeUpdate, { passive: true })
  pageScrollContainer?.addEventListener('scroll', scheduleScrollRevealScan, { passive: true })
  window.addEventListener('pageshow', scheduleRestoredScrollRevealScan)
  scheduleNavThemeUpdate()
  if (closeParticleField.value) {
    closeParticleCleanup = mountCloseParticleField(closeParticleField.value)
  }
  if (!('IntersectionObserver' in window)) return

  workflowObserver = new IntersectionObserver((entries) => {
    const visibleStage = entries
      .filter((entry) => entry.isIntersecting)
      .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]

    const stage = Number((visibleStage?.target as HTMLElement | undefined)?.dataset.stage)
    if (Number.isInteger(stage)) activeStage.value = stage
  }, { root: pageScrollContainer, rootMargin: '-38% 0px -38% 0px', threshold: [0, 0.2, 0.5, 0.8, 1] })

  document.querySelectorAll<HTMLElement>('.journey-step').forEach((step) => workflowObserver?.observe(step))

  const revealTargets = document.querySelectorAll<HTMLElement>('[data-scroll-reveal]')
  if (!revealTargets.length) return

  document.querySelector<HTMLElement>('.login-page')?.classList.add('has-scroll-reveal')
  scrollRevealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return
      entry.target.classList.add('is-scroll-revealed')
      observer.unobserve(entry.target)
    })
  }, { root: pageScrollContainer, rootMargin: '-20% 0px -20% 0px', threshold: 0.2 })

  revealTargets.forEach((target) => scrollRevealObserver?.observe(target))
  scheduleRestoredScrollRevealScan()
})

watch(loginOpen, async (open) => {
  await nextTick()

  if (open) {
    getFocusableElements()[0]?.focus()
  } else {
    returnFocusTarget.value?.focus()
    returnFocusTarget.value = null
  }
})
</script>

<template>
  <main class="login-page" aria-label="帧心帧意产品介绍" @keydown.esc="closeLogin">
    <header class="portal-nav" :class="{ 'portal-nav--light': navOnLightSection }">
      <a class="brand-lockup" href="#top" aria-label="帧心帧意首页">
        <span class="brand-mark" aria-hidden="true">
          <span class="brand-glyph">帧</span>
        </span>
        <span class="brand-copy">
          <strong>帧心帧意</strong>
          <small>PROJECTDREAM / STUDIO</small>
        </span>
      </a>

      <nav class="portal-links" aria-label="产品导航">
        <a class="portal-link" href="#workflow">制作流程</a>
      </nav>

      <button class="nav-action" type="button" aria-label="进入工作台，登录后继续创作" @click="openLogin">
        <span>进入工作台</span>
        <span class="icon-glyph icon-glyph--diagonal" aria-hidden="true">↗</span>
      </button>
    </header>

    <section id="top" class="portal-hero" aria-labelledby="portal-title">
      <div class="hero-image-wrap">
        <img class="hero-image" :src="heroImageUrl" alt="漫剧氛围演示画面：夜间工业走廊中，一名戴头灯的女性拿着对讲机观察前方" fetchpriority="high" decoding="async" width="1600" height="900" />
        <span class="hero-image-wash" aria-hidden="true"></span>
        <span class="hero-image-grain visual-grain" aria-hidden="true"></span>
        <span class="hero-frame-corners" aria-hidden="true"></span>
        <span class="hero-hud hero-hud--left" aria-hidden="true"><i class="rec-dot"></i><span>REC</span><span class="hero-timecode">00:00:12:04</span></span>
        <span class="hero-hud hero-hud--right" aria-hidden="true"><span>FD</span><b>·</b><span>REEL 01</span></span>
        <span class="hero-image-label"><span class="hero-image-label__rule" aria-hidden="true"></span><span class="hero-image-label__note"><i aria-hidden="true"></i> 漫剧画面演示 · 非真实项目案例</span></span>
        <p class="hero-caption">一段故事，正在成为一集漫剧。</p>
      </div>
      <div class="hero-copy">
        <p class="hero-kicker">— AI 漫剧制片系统</p>
        <h1 id="portal-title">让故事先成形，<br /><em>再成片</em>。</h1>
        <p class="hero-description">从角色、分镜到声音与竖屏成片，让每个镜头都接得上故事。</p>
        <a class="hero-cta" href="#workflow">
          <span>了解制作流程</span>
          <span class="cta-icon" aria-hidden="true">
            <span class="icon-glyph" aria-hidden="true">↓</span>
          </span>
        </a>
      </div>
      <div class="hero-feature-rail" aria-labelledby="feature-title">
        <header class="feature-heading">
          <span class="feature-heading__rule" aria-hidden="true"></span>
          <div class="feature-heading__copy">
            <h2 id="feature-title">功能亮点</h2>
            <p>从故事设定到声画交付</p>
          </div>
          <span class="feature-heading__rule" aria-hidden="true"></span>
        </header>
        <div class="hero-feature-grid">
          <article class="feature-card feature-card--blueprint">
            <img class="feature-image" src="/images/shot-landing-feature-story-v1-v1-c1-45c88f76a59b.webp" alt="暖色台灯下摊开的故事手稿，呈现从灵感发展剧情的创作氛围" width="1200" height="674" loading="lazy" decoding="async" />
            <div class="feature-copy"><div class="feature-copy__title"><span class="feature-index">01 / STORY</span><h3>故事蓝图</h3></div><p>题材、设定与分集结构逐步成形。</p></div>
          </article>
          <article class="feature-card feature-card--assets">
            <img class="feature-image" src="/images/shot-landing-feature-assets-v2-v1-c1-0f8f4b9e9be4.webp" alt="角色档案桌上的人物肖像、服装布料与红色发卡道具参考" width="1200" height="674" loading="lazy" decoding="async" />
            <div class="feature-copy"><div class="feature-copy__title"><span class="feature-index">02 / ASSETS</span><h3>项目资产</h3></div><p>角色、场景与道具集中管理，供镜头调用。</p></div>
          </article>
          <article class="feature-card feature-card--storyboard">
            <img class="feature-image" src="/images/shot-landing-feature-storyboard-v2-v1-c1-3c692901c31a.webp" alt="剪辑台上按远景、中景、特写顺序排列的电影分镜照片" width="1200" height="674" loading="lazy" decoding="async" />
            <div class="feature-copy"><div class="feature-copy__title"><span class="feature-index">03 / SHOTS</span><h3>镜头分镜</h3></div><p>景别、表演节拍与时长，逐镜推进叙事。</p></div>
          </article>
          <article class="feature-card feature-card--delivery">
            <img class="feature-image" src="/images/shot-landing-feature-delivery-v1-v1-c1-131661165bbd.webp" alt="后期工作室里剪辑师在监视器上检查短片画面与声音波形" width="1200" height="674" loading="lazy" decoding="async" />
            <div class="feature-copy"><div class="feature-copy__title"><span class="feature-index">04 / DELIVERY</span><h3>声画交付</h3></div><p>视频、对白与环境音进入剪辑和质检。</p></div>
          </article>
        </div>
      </div>
      <a class="hero-scroll" href="#workflow" aria-label="滚动查看制作流程">
        <span class="hero-scroll__line" aria-hidden="true"></span>
        <span class="hero-scroll__arrow" aria-hidden="true">↓</span>
        <span class="hero-scroll__label" aria-hidden="true">SCROLL</span>
      </a>
    </section>

    <section id="workflow" class="workflow" aria-labelledby="workflow-title">
      <header class="workflow-heading">
        <h2 id="workflow-title" data-scroll-reveal="title">从一个角色，<br />走到一集成片。</h2>
        <p data-scroll-reveal="content">故事、画面、声音在同一条制作脉络里逐步成形。</p>
      </header>

      <div class="journey-layout">
        <div
          class="journey-stage"
          :class="`journey-stage--${activeStage}`"
          data-scroll-reveal="content"
          role="group"
          aria-label="漫剧制作流程演示画面"
        >
          <div class="stage-frame">
            <span
              v-if="activeStage !== 0"
              class="stage-reflection"
              :style="{ backgroundImage: `url('${currentWorkflowFrame.src}')` }"
              aria-hidden="true"
            ></span>
            <Transition name="frame-reveal" mode="out-in">
              <img
                :key="activeStage"
                :class="{ 'stage-frame__character-board': activeStage === 0 }"
                :src="currentWorkflowFrame.src"
                :alt="currentWorkflowFrame.alt"
                loading="lazy"
                decoding="async"
              />
            </Transition>
            <span v-if="activeStage !== 0" class="stage-image-shade"></span>
            <span v-if="activeStage !== 0" class="stage-marker stage-marker--top">{{ currentWorkflowFrame.label }}<i aria-hidden="true"></i></span>
            <span v-if="activeStage !== 0" class="stage-marker stage-marker--bottom">{{ currentWorkflowFrame.meta }}</span>
            <span v-if="activeStage !== 0" class="stage-cinema-specs" aria-label="画面规格：每秒24帧，竖屏9比16">24 FPS · 9:16 · STUDIO</span>
          </div>
          <div class="storyboard-strip" aria-hidden="true">
            <figure
              v-for="(frame, index) in workflowFrames"
              :key="frame.label"
              :class="{ 'is-current': activeStage === index, 'storyboard-strip__character': index === 0 }"
            >
              <img :src="frame.src" alt="" loading="lazy" decoding="async" />
              <figcaption>{{ frame.label }}</figcaption>
            </figure>
          </div>
          <div class="stage-progress" role="progressbar" :aria-valuenow="activeStage + 1" aria-valuemin="1" aria-valuemax="3" :aria-label="`制作流程第 ${activeStage + 1} 步，共 3 步`">
            <span :style="{ '--stage-progress-number': (activeStage + 1) / 3 }"></span>
          </div>
          <p class="stage-note">流程演示素材 · 不代表真实项目数据</p>
        </div>

        <div class="journey-steps" role="group" aria-label="漫剧制作步骤">
          <article id="characters" class="journey-step" :class="{ 'is-active': activeStage === 0 }" data-stage="0" data-scroll-reveal="step">
            <span class="step-count">01 / 03</span>
            <h3>先把角色立住</h3>
            <p>整理角色形象与故事设定，让人物在不同镜头里保持连贯。</p>
            <span class="step-output">角色设定 · 可复用资产</span>
          </article>
          <article id="storyboard" class="journey-step" :class="{ 'is-active': activeStage === 1 }" data-stage="1" data-scroll-reveal="step">
            <span class="step-count">02 / 03</span>
            <h3>再让分镜接上情绪</h3>
            <p>把剧本拆成镜头，逐格安排景别、动作与对白。</p>
            <span class="step-output">分镜脚本 · 9:16 / 24 FPS</span>
          </article>
          <article id="finished" class="journey-step" :class="{ 'is-active': activeStage === 2 }" data-stage="2" data-scroll-reveal="step">
            <span class="step-count">03 / 03</span>
            <h3>最后汇成一集</h3>
            <p>将画面、对白、音效与字幕放回同一条制作时间线，准备交付。</p>
            <span class="step-output">画面 + 声音 + 字幕</span>
          </article>
        </div>
      </div>
    </section>

    <section class="portal-close" aria-labelledby="close-title">
      <canvas ref="closeParticleField" class="close-particles" aria-hidden="true"></canvas>
      <div class="close-inner">
        <div class="close-copy">
          <p class="close-eyebrow"><span class="close-line" aria-hidden="true"></span> 下一场，从这里开始</p>
          <h2 id="close-title" data-scroll-reveal="title">从故事开始，<br />把这一集做出来。</h2>
          <p class="close-description" data-scroll-reveal="content">把角色、分镜与声音，继续推进到属于你的成片。</p>
        </div>
        <div class="close-action" data-scroll-reveal="content">
          <span class="close-index">PROJECTDREAM / STUDIO</span>
          <button class="nav-action nav-action--close" type="button" aria-label="进入工作台，登录后继续创作" @click="openLogin">
            <span>进入工作台</span>
            <span class="icon-glyph icon-glyph--diagonal" aria-hidden="true">↗</span>
          </button>
          <p class="close-note">登录后保存并继续创作</p>
          <p class="close-specs">24 FPS · 9:16 · D-CINEMA</p>
        </div>
      </div>
    </section>

    <div v-if="loginOpen" class="login-scrim" aria-hidden="true" @click="closeLogin"></div>

    <section
      v-if="loginOpen"
      ref="loginModal"
      class="login-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-title"
      @keydown="handleModalKeydown"
    >
        <button class="modal-close" type="button" aria-label="关闭登录窗口" @click="closeLogin">
          <span class="icon-glyph" aria-hidden="true">×</span>
        </button>

        <aside class="modal-visual" aria-label="帧心帧意 成片视觉">
          <div class="visual-image" :style="{ '--hero-image': `url('${loginImageUrl}')` }"></div>
          <div class="visual-shade"></div>
          <div class="visual-grain" aria-hidden="true"></div>
          <div class="visual-glow" aria-hidden="true"></div>

          <div class="visual-hud visual-hud--tl" aria-hidden="true">
            <span class="rec-dot"></span>
            <span class="hud-text">REC</span>
            <span class="hud-sep"></span>
            <span class="hud-text hud-mono">00:00:12:04</span>
          </div>
          <div class="visual-hud visual-hud--tr" aria-hidden="true">
            <span class="hud-text hud-mono">FD · REEL 01</span>
          </div>

          <div class="visual-content">
            <span class="visual-tag">PROJECTDREAM / STUDIO</span>
            <h2>从故事蓝图<br />走向竖屏成片。</h2>
            <p>登录后继续你的漫剧创作。</p>
            <div class="visual-meta">
              <span>故事装置</span>
              <span>9:16 · 24 FPS</span>
            </div>
          </div>
          <span class="visual-frame visual-frame--tl" aria-hidden="true"></span>
          <span class="visual-frame visual-frame--br" aria-hidden="true"></span>
        </aside>

        <div class="modal-form-panel">
          <div class="modal-form-header">
            <div class="modal-brand" aria-hidden="true">
              <span class="brand-glyph">帧</span>
            </div>
            <p class="modal-kicker">进入帧心帧意</p>
            <h2 id="login-title">欢迎回来</h2>
            <p>登录后继续你的漫剧创作。</p>
          </div>

          <div class="login-tabs" role="tablist" aria-label="登录方式">
            <button
              class="login-tab"
              :class="{ 'is-active': mode === 'sms' }"
              type="button"
              role="tab"
              :aria-selected="mode === 'sms'"
              @click="switchMode('sms')"
            >
              验证码登录
            </button>
            <button
              class="login-tab"
              :class="{ 'is-active': mode === 'password' }"
              type="button"
              role="tab"
              :aria-selected="mode === 'password'"
              @click="switchMode('password')"
            >
              密码登录
            </button>
          </div>

          <form class="login-form" novalidate @submit="handleLogin">
            <div :key="mode" class="login-mode-panel">
                <label class="form-field">
                  <span>手机号</span>
                  <div class="input-wrap" :class="{ 'has-error': phoneError }">
                    <span class="input-glyph" aria-hidden="true">☎</span>
                    <input
                      :value="phone"
                      type="text"
                      inputmode="tel"
                      autocomplete="tel"
                      placeholder="请输入手机号"
                      maxlength="13"
                      @input="onPhoneInput(($event.target as HTMLInputElement).value)"
                    />
                  </div>
                  <small v-if="phoneError" key="phone-error" class="field-error error-message">{{ phoneError }}</small>
                </label>

                <label v-if="mode === 'sms'" class="form-field">
                  <span>短信验证码</span>
                  <div class="input-wrap input-wrap--code" :class="{ 'has-error': codeError }">
                    <span class="input-glyph" aria-hidden="true">#</span>
                    <input
                      :value="code"
                      type="text"
                      inputmode="numeric"
                      autocomplete="one-time-code"
                      placeholder="请输入 6 位验证码"
                      maxlength="6"
                      @input="onCodeInput(($event.target as HTMLInputElement).value)"
                    />
                    <button
                      class="code-button"
                      type="button"
                      :disabled="!phoneValid || countdown > 0 || sendingCode"
                      @click="handleSendCode"
                    >
                      {{ sendingCode ? '发送中' : countdown > 0 ? `${countdown}s 后重发` : '获取验证码' }}
                    </button>
                  </div>
                  <small v-if="codeError" key="code-error" class="field-error error-message">{{ codeError }}</small>
                  <small v-else-if="codeHint" key="code-hint" class="field-hint error-message">{{ codeHint }}</small>
                </label>
                <CaptchaSlider
                  v-if="mode === 'sms'"
                  :phone="normalizedPhone"
                  @verified="captchaToken = $event"
                />

                <label v-else class="form-field">
                  <div class="field-heading">
                    <span>登录密码</span>
                    <button type="button" class="text-action" @click="goForgot">忘记密码</button>
                  </div>
                  <div class="input-wrap" :class="{ 'has-error': passwordError }">
                    <span class="input-glyph" aria-hidden="true">▣</span>
                    <input
                      v-model="password"
                      :type="showPassword ? 'text' : 'password'"
                      autocomplete="current-password"
                      placeholder="请输入密码"
                      @input="onPasswordInput"
                    />
                    <button
                      type="button"
                      class="input-action"
                      :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                      @click="showPassword = !showPassword"
                    >
                      <span class="icon-glyph" aria-hidden="true">{{ showPassword ? '◉' : '◎' }}</span>
                    </button>
                  </div>
                  <small v-if="passwordError" key="password-error" class="field-error error-message">{{ passwordError }}</small>
                </label>
            </div>

            <p v-if="errorMessage" key="form-error" class="form-error error-message" role="alert">
              <span class="icon-glyph" aria-hidden="true">!</span>
              <span>{{ errorMessage }}</span>
            </p>

            <button class="submit-button" type="submit" :disabled="!canSubmit">
              <span>{{ submitting ? '登录中' : '登录并进入工作台' }}</span>
              <span v-if="submitting" class="button-spinner" aria-hidden="true"></span>
              <span v-else class="cta-icon cta-icon--dark" aria-hidden="true">
                <span class="icon-glyph" aria-hidden="true">→</span>
              </span>
            </button>
          </form>

          <p class="agreement-copy">登录即表示你同意帧心帧意的服务协议与隐私政策。</p>

          <p class="register-prompt">
            还没有账号？
            <button type="button" class="text-action text-action--strong" @click="goRegister">立即注册</button>
          </p>
        </div>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  --ink: #f2f3ed;
  --muted: rgba(242, 243, 237, 0.68);
  --faint: rgba(242, 243, 237, 0.46);
  --line: rgba(220, 232, 221, 0.17);
  --accent: #e27b4d;
  --accent-strong: #a94729;
  --paper: #f3f4ee;
  --paper-ink: #17191b;
  --paper-muted: #717475;
  position: relative;
  min-height: 100dvh;
  overflow: clip;
  isolation: isolate;
  background: #0a0e0d;
  color: var(--paper-ink);
  font-family: 'Noto Sans SC', 'Noto Sans', 'Microsoft YaHei', sans-serif;
}

.scene-backdrop,
.scene-backdrop-image,
.scene-backdrop-vignette,
.scene-backdrop-grain {
  position: absolute;
  inset: 0;
}

.scene-backdrop {
  z-index: -3;
  overflow: hidden;
  background: #070a0c;
  display: none;
}

.scene-backdrop-image {
  background:
    linear-gradient(90deg, rgba(7, 10, 12, 0.55), rgba(7, 10, 12, 0.12) 46%, rgba(7, 10, 12, 0.02) 66%, rgba(7, 10, 12, 0.4)),
    var(--hero-image) center 40% / cover no-repeat;
  filter: saturate(0.92) contrast(1.06) brightness(0.86);
  transform: scale(1.02);
}

.scene-backdrop-vignette {
  background:
    linear-gradient(180deg, rgba(4, 7, 9, 0.66) 0%, transparent 24%, transparent 63%, rgba(4, 7, 9, 0.94) 100%),
    radial-gradient(circle at 42% 48%, transparent 12%, rgba(4, 7, 9, 0.4) 74%);
}

.scene-backdrop-grain {
  opacity: 0.04;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.32'/%3E%3C/svg%3E");
  mix-blend-mode: soft-light;
  pointer-events: none;
}

.portal-nav {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2rem;
  width: min(100% - 5rem, 1440px);
  margin: 0 auto;
  padding: 1.5rem 0;
}

.brand-lockup,
.portal-link,
.nav-action,
.hero-cta,
  .icon-glyph,
  .brand-glyph,
  .input-glyph,
.modal-close,
.login-tab,
.code-button,
.input-action,
.submit-button,
.text-action {
  font: inherit;
}

.brand-lockup {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.brand-mark {
  display: inline-grid;
  place-items: center;
  width: 2.2rem;
  height: 2.2rem;
  border: 1px solid rgba(230, 154, 69, 0.76);
  color: var(--accent);
  background: rgba(10, 13, 15, 0.36);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}

.brand-mark .material-symbols-outlined { font-size: 1.25rem; }
.brand-glyph { color: var(--accent); font-family: 'Noto Serif SC', 'Songti SC', serif; font-size: 1.25rem; font-weight: 700; line-height: 1; }
.icon-glyph { display: inline-grid; place-items: center; font-family: Arial, sans-serif; font-size: 1.15rem; font-weight: 500; line-height: 1; }
.icon-glyph--diagonal { font-size: 1.05rem; }

.brand-copy {
  display: grid;
  gap: 0.18rem;
}

.brand-copy strong {
  color: #fffaf1;
  font-family: 'Noto Serif SC', 'Songti SC', serif;
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.brand-copy small,
.hero-kicker,
.visual-tag,
.rail-label {
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.brand-copy small { color: rgba(242, 243, 237, 0.72); }

.portal-links {
  display: flex;
  align-items: center;
  gap: clamp(1.25rem, 3vw, 3rem);
}

.portal-link {
  position: relative;
  padding: 0.65rem 0;
  border: 0;
  color: rgba(244, 242, 236, 0.62);
  background: transparent;
  font-size: 0.8rem;
  cursor: pointer;
  transition: color 180ms ease;
}

.portal-link::after {
  position: absolute;
  right: 0;
  bottom: 0.2rem;
  left: 0;
  height: 1px;
  background: var(--accent);
  content: '';
  transform: scaleX(0);
  transform-origin: left center;
  transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
}

.portal-link:hover,
.portal-link:focus-visible,
.portal-link.is-active { color: #fffaf1; }
.portal-link:hover::after,
.portal-link:focus-visible::after,
.portal-link.is-active::after { transform: scaleX(1); }

.nav-action,
.hero-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  border: 1px solid rgba(255, 255, 255, 0.72);
  color: #17191b;
  background: #f8f7f3;
  cursor: pointer;
  transition: transform 260ms cubic-bezier(0.32, 0.72, 0, 1), background-color 220ms ease, box-shadow 260ms cubic-bezier(0.32, 0.72, 0, 1);
}

.nav-action {
  min-height: 2.55rem;
  padding: 0.35rem 1rem 0.35rem 1.15rem;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 700;
}

.nav-action .material-symbols-outlined { font-size: 1rem; }

.nav-action:hover,
.hero-cta:hover,
.nav-action:focus-visible,
.hero-cta:focus-visible {
  background: #fff;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.24);
  transform: translateY(-2px);
}

.portal-hero {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  min-height: calc(100dvh - 11rem);
  width: min(100% - 5rem, 1440px);
  margin: 0 auto;
  padding: 3rem 0 8rem;
}

.hero-copy {
  width: min(34rem, 60vw);
  animation: reveal-up 800ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.hero-kicker {
  margin: 0 0 1.4rem;
  color: var(--accent);
}

.hero-copy h1 {
  max-width: 10ch;
  margin: 0;
  color: #fffaf1;
  font-family: 'Noto Serif SC', 'Songti SC', serif;
  font-size: clamp(3rem, 5.8vw, 5.8rem);
  font-weight: 600;
  letter-spacing: -0.04em;
  line-height: 1.03;
  text-wrap: balance;
}

.hero-copy h1 em {
  color: #f0ba7a;
  font-style: normal;
}

.hero-description {
  max-width: 35rem;
  margin: 1.65rem 0 0;
  color: rgba(244, 242, 236, 0.74);
  font-size: 1rem;
  line-height: 1.8;
}

.hero-cta {
  min-height: 3.1rem;
  margin-top: 2.1rem;
  padding: 0.6rem 0.65rem 0.6rem 1.35rem;
  border-color: var(--accent);
  border-radius: 999px;
  color: #fffaf1;
  background: var(--accent-strong);
  font-size: 0.86rem;
  font-weight: 700;
}

.hero-cta:hover,
.hero-cta:focus-visible { background: var(--accent-strong); }
.cta-icon { display: inline-grid; place-items: center; width: 1.9rem; height: 1.9rem; border-radius: 50%; color: #fffaf1; background: rgba(255, 255, 255, 0.18); }
.cta-icon .icon-glyph { font-size: 1.02rem; transition: transform 260ms cubic-bezier(0.32, 0.72, 0, 1); }
.hero-cta:hover .cta-icon .icon-glyph,
.hero-cta:focus-visible .cta-icon .icon-glyph { transform: translate(2px, -2px); }

.hero-caption {
  position: absolute;
  right: 0;
  bottom: 8.5rem;
  display: flex;
  align-items: flex-start;
  gap: 0.8rem;
  color: rgba(244, 242, 236, 0.66);
  animation: reveal-up 900ms cubic-bezier(0.16, 1, 0.3, 1) 120ms both;
}

.caption-copy {
  display: grid;
  gap: 0.26rem;
  text-align: right;
}

.hero-caption strong,
.hero-caption small { font-size: 0.66rem; letter-spacing: 0.12em; }
.hero-caption strong { color: #fffaf1; }
.hero-caption small { color: var(--faint); }
.caption-line { width: 3.8rem; height: 1px; margin-top: 0.32rem; background: var(--accent); }

.capability-rail {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: minmax(17rem, 1.3fr) repeat(3, minmax(11rem, 1fr)) auto;
  align-items: stretch;
  border-top: 1px solid var(--line);
  background: rgba(7, 10, 12, 0.5);
  backdrop-filter: blur(14px);
}

.rail-intro,
.rail-item,
.rail-end {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 5.9rem;
  padding: 1rem 1.5rem;
  border-right: 1px solid var(--line);
}

.rail-intro {
  display: grid;
  align-content: center;
  gap: 0.35rem;
}

.rail-label { color: var(--accent); }
.rail-intro strong { font-size: 0.88rem; font-weight: 500; color: #fffaf1; }
.rail-item .material-symbols-outlined { color: var(--accent); font-size: 1.35rem; }
.rail-item span:last-child { display: grid; gap: 0.26rem; }
.rail-item strong { color: rgba(255, 250, 241, 0.9); font-size: 0.75rem; font-weight: 600; }
.rail-item small { color: var(--faint); font-size: 0.66rem; }
.rail-end { border-right: 0; color: rgba(244, 242, 236, 0.68); font-size: 0.68rem; white-space: nowrap; }
.status-dot { width: 0.45rem; height: 0.45rem; border-radius: 50%; background: #76d29b; box-shadow: 0 0 0 4px rgba(118, 210, 155, 0.14); }

.login-page {
  overflow-x: clip;
  overflow-y: visible;
  background: #0a0e0d;
  scroll-behavior: smooth;
  scrollbar-color: rgba(226, 123, 77, 0.58) #0a0e0d;
}

.portal-nav { width: min(100% - 5rem, 1440px); color: #f0ede5; }
.brand-lockup { color: inherit; text-decoration: none; }
.portal-links { gap: clamp(1.5rem, 4vw, 4rem); }
.portal-link { display: inline-flex; color: rgba(240, 237, 229, 0.7); text-decoration: none; }
.portal-link::after { background: #c85a35; }
.portal-link:hover, .portal-link:focus-visible { color: #fffaf1; }
.brand-copy strong { color: #f0ede5; }
.brand-copy small { color: rgba(240, 237, 229, 0.54); }
.portal-nav .nav-action { border: 1px solid rgba(240, 237, 229, 0.46); color: #f0ede5; background: transparent; }
.portal-nav .nav-action:hover, .portal-nav .nav-action:focus-visible { border-color: #f0ede5; color: #0a0e0d; background: #f0ede5; box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28); }
.portal-nav, .portal-nav .portal-link, .portal-nav .brand-copy strong, .portal-nav .brand-copy small, .portal-nav .nav-action { transition: color 220ms ease, background-color 220ms ease, border-color 220ms ease, box-shadow 220ms ease; }
.portal-nav.portal-nav--light { border-bottom-color: rgba(74, 61, 43, 0.13); color: #202725; background: rgba(245, 242, 236, 0.9); box-shadow: 0 8px 24px rgba(47, 41, 31, 0.06); }
.portal-nav--light .portal-link { color: #4c5751; }
.portal-nav--light .portal-link:hover, .portal-nav--light .portal-link:focus-visible { color: #202725; }
.portal-nav--light .brand-copy strong { color: #202725; }
.portal-nav--light .brand-copy small { color: #69736d; }
.portal-nav--light .nav-action { border-color: rgba(32, 39, 37, 0.5); color: #202725; background: transparent; }
.portal-nav--light .nav-action:hover, .portal-nav--light .nav-action:focus-visible { border-color: #202725; color: #f5f2ec; background: #202725; box-shadow: 0 8px 20px rgba(47, 41, 31, 0.15); }

.portal-hero {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(20rem, 1.05fr);
  grid-template-rows: minmax(18rem, 1fr) auto;
  align-items: center;
  gap: clamp(2rem, 7vw, 8rem);
  row-gap: clamp(1.75rem, 4vh, 2.75rem);
  width: min(100% - 5rem, 1440px);
  min-height: calc(100svh - 4.75rem);
  box-sizing: border-box;
  margin: 0 auto;
  padding: 2rem 0 3rem;
  background: transparent;
}

.portal-hero::before {
  position: absolute;
  z-index: 0;
  inset: 0;
  background:
    radial-gradient(ellipse at 68% 46%, rgba(84, 132, 158, 0.06), transparent 46%),
    radial-gradient(ellipse at 88% 88%, rgba(200, 90, 53, 0.04), transparent 32%),
    radial-gradient(ellipse at center, #141c1a 0%, #080c0b 72%);
  content: '';
  pointer-events: none;
}

.portal-hero::after {
  position: absolute;
  z-index: 0;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.4'/%3E%3C/svg%3E");
  opacity: 0.03;
  mix-blend-mode: soft-light;
  pointer-events: none;
}

.hero-image-wrap {
  position: relative;
  z-index: 1;
  grid-column: 2;
  grid-row: 1;
  width: 100%;
  aspect-ratio: 1.78;
  overflow: hidden;
  background: #16201d;
  animation: reveal-up 1000ms cubic-bezier(0.16, 1, 0.3, 1) both;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5);
  -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 100px);
  mask-image: linear-gradient(90deg, transparent 0, #000 100px);
}

.hero-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 50% center;
  filter: saturate(0.85) contrast(1.1) hue-rotate(-10deg) brightness(0.88);
  transform: scale(1);
  animation: hero-image-breathe 20s cubic-bezier(0.25, 0.6, 0.15, 1) alternate infinite;
}

.hero-image-wrap::after {
  position: absolute;
  z-index: 1;
  inset: 0;
  background: linear-gradient(90deg, rgba(78, 139, 165, 0.2), rgba(78, 139, 165, 0.07) 12%, transparent 38%);
  content: '';
  pointer-events: none;
}

.hero-image-wash {
  position: absolute;
  z-index: 1;
  inset: 0;
  background: linear-gradient(0deg, rgba(8, 13, 12, 0.48), transparent 25%);
  pointer-events: none;
}

.hero-image-grain { z-index: 2; opacity: 0.09; }

.hero-frame-corners {
  position: absolute;
  z-index: 3;
  inset: 0.9rem;
  background:
    linear-gradient(rgba(255, 250, 241, 0.8), rgba(255, 250, 241, 0.8)) left top / 1.35rem 1px no-repeat,
    linear-gradient(rgba(255, 250, 241, 0.8), rgba(255, 250, 241, 0.8)) left top / 1px 1.35rem no-repeat,
    linear-gradient(rgba(255, 250, 241, 0.8), rgba(255, 250, 241, 0.8)) right top / 1.35rem 1px no-repeat,
    linear-gradient(rgba(255, 250, 241, 0.8), rgba(255, 250, 241, 0.8)) right top / 1px 1.35rem no-repeat,
    linear-gradient(rgba(255, 250, 241, 0.8), rgba(255, 250, 241, 0.8)) left bottom / 1.35rem 1px no-repeat,
    linear-gradient(rgba(255, 250, 241, 0.8), rgba(255, 250, 241, 0.8)) left bottom / 1px 1.35rem no-repeat,
    linear-gradient(rgba(255, 250, 241, 0.8), rgba(255, 250, 241, 0.8)) right bottom / 1.35rem 1px no-repeat,
    linear-gradient(rgba(255, 250, 241, 0.8), rgba(255, 250, 241, 0.8)) right bottom / 1px 1.35rem no-repeat;
  pointer-events: none;
}

.hero-hud {
  position: absolute;
  z-index: 4;
  top: 1.3rem;
  min-height: 1.25rem;
  display: flex;
  align-items: center;
  gap: 0.58rem;
  white-space: nowrap;
  color: rgba(255, 250, 241, 0.9);
  font: 600 0.62rem/1.2 'JetBrains Mono', 'SF Mono', ui-monospace, monospace;
  letter-spacing: 0.1em;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.55);
}
.hero-hud--left { left: 1.45rem; justify-content: flex-start; }
.hero-hud--right { right: 1.45rem; justify-content: flex-end; }
.hero-hud b { color: #c85a35; font-weight: 700; }
.hero-hud .rec-dot { width: 0.42rem; height: 0.42rem; }
.hero-timecode { font-variant-numeric: tabular-nums; }

.hero-image-label {
  position: absolute;
  z-index: 4;
  right: 1rem;
  left: 1rem;
  bottom: 1.35rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 0;
  color: #fffaf1;
  background: transparent;
  font: 500 0.62rem/1.4 'JetBrains Mono', 'SF Mono', ui-monospace, monospace;
  letter-spacing: 0.045em;
  text-shadow: 0 1px 9px rgba(0, 0, 0, 0.7);
  line-height: 1.4;
}

.hero-image-label__rule { width: 2.25rem; height: 1px; background: #c85a35; }
.hero-image-label__note { display: inline-flex; align-items: center; gap: 0.58rem; }

.hero-image-label i,
.stage-marker--top i {
  display: inline-block;
  width: 0.42rem;
  height: 0.42rem;
  margin: 0;
  border-radius: 50%;
  background: #c85a35;
  box-shadow: 0 0 0 3px rgba(200, 90, 53, 0.2);
}

.hero-copy { position: relative; z-index: 1; grid-column: 1; grid-row: 1; width: 100%; animation: hero-copy-in 800ms cubic-bezier(0.16, 1, 0.3, 1) 100ms both; }
.hero-copy .hero-kicker { margin: 0 0 1rem; color: #e27b4d; font: 600 0.68rem/1.5 'JetBrains Mono', 'SF Mono', ui-monospace, monospace; letter-spacing: 0.1em; }
.hero-copy h1 { position: relative; max-width: 12ch; padding-left: 0.9rem; color: #fffaf1; font-size: clamp(3.5rem, 5.3vw, 5.25rem); font-weight: 700; line-height: 1.03; }
.hero-copy h1::before { position: absolute; top: 0.22em; left: 0; width: 2px; height: 1.4rem; background: #c85a35; content: ''; }
.hero-copy h1 em { display: inline-block; border-bottom: 2px solid #c85a35; color: #f0ba7a; font-size: 1.08em; font-style: normal; }
.hero-description { max-width: 29rem; margin-top: 1.45rem; color: rgba(240, 237, 229, 0.74); font-size: 1rem; letter-spacing: 0.02em; line-height: 1.9; }
.hero-cta { position: relative; isolation: isolate; overflow: hidden; margin-top: 2rem; border-color: rgba(240, 237, 229, 0.18); color: #fffaf1; background: #1a1f1e; text-decoration: none; }
.hero-cta::before { position: absolute; z-index: 0; inset: -40% auto -40% -70%; width: 36%; transform: skewX(-22deg); background: linear-gradient(90deg, transparent, rgba(255,255,255,.15), transparent); content: ''; }
.hero-cta > * { position: relative; z-index: 1; }
.hero-cta:hover::before, .hero-cta:focus-visible::before { animation: cta-sheen 700ms ease-out; }
.hero-cta:hover, .hero-cta:focus-visible { border-color: rgba(240, 237, 229, 0.3); background: #252d2b; }
.hero-cta .cta-icon { color: #fffaf1; background: rgba(255, 255, 255, 0.1); }
.hero-cta:hover .cta-icon, .hero-cta:focus-visible .cta-icon { color: #fffaf1; background: rgba(200, 90, 53, 0.42); }
.hero-caption {
  position: absolute;
  z-index: 2;
  right: 1rem;
  bottom: 3.3rem;
  margin: 0;
  color: rgba(255, 250, 241, 0.86);
  font: 500 0.67rem/1.6 'JetBrains Mono', 'SF Mono', ui-monospace, monospace;
  letter-spacing: 0.045em;
  writing-mode: vertical-rl;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.72);
  animation: none;
}
.hero-caption::before { display: block; width: 1px; height: 2.35rem; margin: 0 auto 0.65rem; background: #c85a35; content: ''; }

.hero-scroll {
  position: absolute;
  bottom: 0.65rem;
  left: 50%;
  z-index: 2;
  display: grid;
  justify-items: center;
  gap: 0.22rem;
  color: rgba(240, 237, 229, 0.56);
  font: 600 0.56rem/1 'JetBrains Mono', 'SF Mono', ui-monospace, monospace;
  letter-spacing: 0.12em;
  text-decoration: none;
  transform: translateX(-50%);
}
.hero-scroll__line { width: 1px; height: 1rem; background: linear-gradient(#c85a35, rgba(200, 90, 53, 0.08)); }
.hero-scroll__arrow { color: #e27b4d; font: 1rem/0.85 'Noto Sans SC', sans-serif; transition: transform 220ms ease; }
.hero-scroll__label { margin-top: 0.1rem; }
.hero-scroll:hover .hero-scroll__arrow, .hero-scroll:focus-visible .hero-scroll__arrow { transform: translateY(2px); }
.hero-scroll:focus-visible { outline: 2px solid #e27b4d; outline-offset: 4px; }

.workflow {
  position: relative;
  isolation: isolate;
  padding: 7rem max(2.5rem, calc((100% - 1280px) / 2)) 8rem;
  background:
    linear-gradient(180deg, #080c0b 0, #f5f2ec 5rem, transparent 5.1rem),
    radial-gradient(ellipse 46% 38% at 88% 8%, rgba(190, 91, 53, 0.055), transparent 76%),
    radial-gradient(ellipse 62% 48% at 4% 70%, rgba(110, 137, 129, 0.055), transparent 78%),
    linear-gradient(180deg, #f5f2ec 0%, #f1eee7 58%, #ece8df 100%);
  border-top: 0;
}

.workflow::after {
  position: absolute;
  z-index: -1;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.4'/%3E%3C/svg%3E");
  opacity: 0.026;
  content: '';
  pointer-events: none;
}

.workflow-heading { display: flex; align-items: end; justify-content: space-between; gap: 3rem; max-width: 1280px; margin: 0 auto 4rem; }
.workflow-heading h2, .portal-close h2 { margin: 0; color: #fffaf1; font-family: 'Noto Serif SC', 'Songti SC', serif; font-size: clamp(2.4rem, 4.5vw, 4.5rem); font-weight: 500; line-height: 1.22; text-wrap: balance; }
.workflow-heading h2 { color: #202725; }
.workflow-heading p { max-width: 31ch; margin: 0 0 0.45rem; color: #58625d; font-size: 0.98rem; line-height: 1.8; }

.journey-layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(20rem, 0.9fr); align-items: start; gap: clamp(3rem, 8vw, 8rem); max-width: 1280px; margin: 0 auto; }
.journey-stage { position: sticky; top: 12vh; display: grid; grid-template-rows: auto auto; align-content: start; gap: 1.35rem; min-width: 0; height: fit-content; padding: clamp(0.8rem, 1.6vw, 1.35rem); background: transparent; }
.stage-frame { position: relative; box-sizing: border-box; width: 100%; min-height: 0; aspect-ratio: 16 / 9; overflow: visible; padding: clamp(0.3rem, 0.65vw, 0.55rem); border: 1px solid rgba(74, 61, 43, 0.18); background: rgba(255, 255, 255, 0.38); box-shadow: 0 24px 56px rgba(47, 41, 31, 0.14), 0 3px 10px rgba(47, 41, 31, 0.08); }
.stage-frame::before { position: absolute; z-index: 0; inset: -8% -5% -4%; border-radius: 50%; background: radial-gradient(ellipse at 52% 46%, rgba(103, 156, 180, 0.11), rgba(46, 69, 72, 0.06) 40%, transparent 73%); filter: blur(30px); content: ''; pointer-events: none; }
.stage-frame > img { position: relative; z-index: 1; display: block; width: 100%; height: 100%; object-fit: cover; object-position: center; filter: saturate(0.9) brightness(0.94) drop-shadow(0 18px 28px rgba(47, 41, 31, 0.18)); }
.stage-frame > img:not(.stage-frame__character-board) { -webkit-mask-image: radial-gradient(ellipse 78% 84% at 50% 48%, #000 56%, rgba(0, 0, 0, 0.72) 76%, transparent 100%); mask-image: radial-gradient(ellipse 78% 84% at 50% 48%, #000 56%, rgba(0, 0, 0, 0.72) 76%, transparent 100%); }
.stage-frame > img.stage-frame__character-board { filter: drop-shadow(0 10px 30px rgba(0, 0, 0, 0.08)); mix-blend-mode: multiply; }
.stage-reflection { position: absolute; z-index: 0; top: calc(100% - 1px); right: 8%; left: 8%; height: 24%; transform: scaleY(-1); transform-origin: top; background-position: center bottom; background-size: cover; filter: blur(5px) saturate(0.7); opacity: 0.1; -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.6), transparent 92%); mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.6), transparent 92%); pointer-events: none; }
.stage-image-shade { position: absolute; z-index: 2; inset: 0; background: radial-gradient(ellipse 78% 84% at 50% 48%, transparent 48%, rgba(9, 14, 13, 0.12) 72%, rgba(9, 14, 13, 0.56) 100%), linear-gradient(180deg, rgba(5, 8, 10, 0.12), transparent 28%, transparent 70%, rgba(5, 8, 10, 0.34)); -webkit-mask-image: radial-gradient(ellipse 78% 84% at 50% 48%, #000 56%, rgba(0, 0, 0, 0.72) 76%, transparent 100%); mask-image: radial-gradient(ellipse 78% 84% at 50% 48%, #000 56%, rgba(0, 0, 0, 0.72) 76%, transparent 100%); pointer-events: none; }
.stage-cinema-specs { position: absolute; z-index: 3; top: 0.8rem; right: 0.8rem; color: #fffaf1; font: 600 0.58rem/1.4 'JetBrains Mono', 'SF Mono', ui-monospace, monospace; text-shadow: 0 1px 8px rgba(0, 0, 0, 0.75); }
.stage-marker { position: absolute; z-index: 3; left: 0.7rem; padding: 0; border: 0; color: #9d492d; background: transparent; font: 600 0.68rem/1.4 'JetBrains Mono', 'SF Mono', ui-monospace, monospace; letter-spacing: 0.035em; text-shadow: 0 1px 0 rgba(245, 242, 236, 0.88); }
.stage-marker--top { top: 0.7rem; }
.stage-marker--top i { margin-left: 0.45rem; vertical-align: 0.04rem; }
.stage-marker--bottom { bottom: 0.7rem; max-width: calc(100% - 1.4rem); line-height: 1.4; }
.storyboard-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.65rem; }
.storyboard-strip figure { display: grid; grid-template-rows: minmax(0, 1fr) auto; min-width: 0; margin: 0; overflow: hidden; border: 1px solid rgba(74, 61, 43, 0.14); background: #e9e4da; opacity: 0.7; transition: opacity 420ms cubic-bezier(0.16, 0.72, 0, 1), border-color 420ms cubic-bezier(0.16, 0.72, 0, 1); outline: 1px solid transparent; outline-offset: 2px; }
.storyboard-strip img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; object-position: center; filter: saturate(0.72) brightness(0.7); transition: filter 420ms ease, transform 600ms cubic-bezier(0.16, 0.72, 0, 1); }
.storyboard-strip figure.storyboard-strip__character { background: #f5f2ec; }
.storyboard-strip figure.storyboard-strip__character img { object-fit: contain; background: #f5f2ec; mix-blend-mode: multiply; }
.storyboard-strip figure.storyboard-strip__character.is-current img { transform: none; }
.storyboard-strip figure.is-current { opacity: 1; border-color: rgba(169, 78, 47, 0.42); outline-color: rgba(169, 78, 47, 0.42); }
.storyboard-strip figure.is-current img { filter: saturate(0.92) brightness(0.92); transform: scale(1.035); }
.storyboard-strip figcaption { position: static; min-width: 0; padding: 0.38rem 0.45rem 0.42rem; color: #3f4944; background: #e9e4da; font-size: 0.66rem; line-height: 1.35; }
.storyboard-strip figure.storyboard-strip__character figcaption { color: #3f4944; background: #f5f2ec; }
.frame-reveal-enter-active, .frame-reveal-leave-active { transition: opacity 260ms ease, transform 260ms ease; }
.frame-reveal-enter-from { opacity: 0; transform: scale(1.025); }
.frame-reveal-leave-to { opacity: 0; transform: scale(0.985); }
.stage-progress { position: absolute; right: clamp(1rem, 2vw, 2rem); bottom: 0.62rem; left: clamp(1rem, 2vw, 2rem); height: 2px; background: rgba(32, 39, 37, 0.18); }
.stage-progress span { display: block; width: 100%; height: 100%; background: var(--accent); transform: scaleX(var(--stage-progress-number, 0.333)); transform-origin: left; transition: transform 600ms cubic-bezier(0.16, 1, 0.3, 1); }
.stage-note { position: absolute; right: clamp(1rem, 2vw, 2rem); bottom: -1.65rem; left: clamp(1rem, 2vw, 2rem); margin: 0; color: #69736d; font-size: 0.73rem; line-height: 1.4; }
.journey-steps { min-width: 0; }
.journey-step { display: flex; flex-direction: column; justify-content: center; min-height: 68vh; padding: 3rem 0; opacity: 0.84; transition: opacity 500ms cubic-bezier(0.16, 1, 0.3, 1); scroll-margin-top: 8rem; }
.journey-step:first-child { min-height: 64vh; }
.journey-step:last-child { min-height: 68vh; }
.journey-step[data-stage="0"] { --step-order: 1; }
.journey-step[data-stage="1"] { --step-order: 2; }
.journey-step[data-stage="2"] { --step-order: 3; }
.journey-step h3 { margin: 1rem 0 0; color: #202725; font-family: 'Noto Serif SC', 'Songti SC', serif; font-size: clamp(2rem, 3vw, 3rem); font-weight: 500; line-height: 1.3; text-wrap: balance; }
.journey-step p { max-width: 34ch; margin: 1.1rem 0 0; color: #58625d; font-size: 0.98rem; line-height: 1.9; }
.step-count { color: #a94e2f; font-variant-numeric: tabular-nums; font-size: 0.78rem; }
.step-output { width: fit-content; margin-top: 1.65rem; padding-top: 0.7rem; border-top: 1px solid rgba(169, 78, 47, 0.42); color: #984429; font-size: 0.8rem; }

.hero-feature-rail { position: relative; z-index: 1; display: grid; grid-column: 1 / -1; grid-row: 2; gap: 1.35rem; width: 100%; }
.feature-heading { display: flex; align-items: center; justify-content: center; gap: clamp(0.8rem, 2vw, 1.5rem); width: min(100%, 34rem); margin: 0 auto; text-align: center; }
.feature-heading__copy { display: grid; gap: 0.28rem; flex: 0 0 auto; }
.feature-heading__rule { width: min(13vw, 8rem); height: 1px; background: linear-gradient(90deg, transparent, rgba(240, 220, 180, 0.32)); }
.feature-heading__rule:last-child { transform: scaleX(-1); }
.feature-heading h2 { margin: 0; color: #fffaf1; font-family: 'Noto Serif SC', 'Songti SC', serif; font-size: 1.18rem; font-weight: 500; line-height: 1.35; }
.feature-heading p { margin: 0; color: rgba(240, 237, 229, 0.68); font-size: 0.68rem; line-height: 1.5; }
.hero-feature-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-items: start; gap: clamp(0.8rem, 1.7vw, 1.45rem); min-width: 0; }
.feature-card { display: grid; grid-template-rows: auto 1fr; gap: 0.75rem; min-width: 0; color: #f4f1e8; }
.feature-image { display: block; width: 100%; aspect-ratio: 1.8; border: 1px solid rgba(240, 220, 180, 0.18); border-radius: 4px; object-fit: cover; background: #1a211e; box-shadow: 0 18px 42px rgba(0, 0, 0, 0.28); filter: saturate(0.86) contrast(1.04); transition: transform 550ms cubic-bezier(0.16, 0.72, 0, 1), filter 400ms ease, border-color 400ms ease; }
.feature-card:hover .feature-image { transform: scale(1.02); border-color: rgba(200, 90, 53, 0.72); filter: saturate(1) contrast(1.04); }
.feature-copy { min-width: 0; padding: 0 0.08rem; }
.feature-copy__title { display: flex; align-items: baseline; gap: 0.58rem; }
.feature-index { flex: 0 0 auto; color: #d49a6b; font: 600 0.55rem/1.3 'JetBrains Mono', 'SF Mono', ui-monospace, monospace; letter-spacing: 0.06em; }
.feature-copy h3 { margin: 0; color: #f5f1e8; font-family: 'Noto Serif SC', 'Songti SC', serif; font-size: 1.05rem; font-weight: 500; line-height: 1.4; }
.feature-copy p { max-width: 32ch; margin: 0.28rem 0 0; color: rgba(241, 238, 225, 0.76); font-size: 0.7rem; line-height: 1.6; }

.portal-close {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: grid;
  align-items: center;
  box-sizing: border-box;
  min-height: max(100vh, 100svh);
  padding: clamp(3.5rem, 6vw, 5rem) max(2.5rem, calc((100% - 1280px) / 2));
  border-top: 1px solid rgba(240, 237, 229, 0.1);
  background:
    radial-gradient(ellipse 54% 145% at 87% 100%, rgba(190, 91, 53, 0.1), transparent 72%),
    radial-gradient(ellipse 70% 140% at 12% 0%, rgba(83, 137, 164, 0.09), transparent 76%),
    linear-gradient(115deg, #121a17, #18211e 52%, #111815);
}
.portal-close::after {
  position: absolute;
  z-index: -1;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.4'/%3E%3C/svg%3E");
  opacity: 0.035;
  content: '';
  pointer-events: none;
}
.close-particles { position: absolute; right: 0; bottom: 0; z-index: 0; display: block; width: 100%; height: min(52vh, 26rem); opacity: 0.88; pointer-events: none; mask-image: linear-gradient(180deg, transparent 0%, #000 24%, #000 82%, transparent 100%); }
.close-inner { position: relative; z-index: 1; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: clamp(2.5rem, 7vw, 7rem); row-gap: clamp(2rem, 5vh, 3.75rem); width: 100%; max-width: 1280px; margin: 0 auto; }
.close-copy { min-width: 0; }
.close-eyebrow { display: flex; align-items: center; gap: 0.75rem; margin: 0 0 1.15rem; color: #e98e63; font: 600 0.68rem/1.5 'JetBrains Mono', 'SF Mono', ui-monospace, monospace; letter-spacing: 0.08em; }
.portal-close .close-line { width: 2.2rem; height: 1px; margin: 0; background: var(--accent); }
.portal-close h2 { font-size: clamp(2.2rem, 4.1vw, 3.8rem); line-height: 1.2; }
.close-description { max-width: 42ch; margin: 1.15rem 0 0; color: rgba(240, 237, 229, 0.64); font-size: 0.94rem; line-height: 1.8; }
.close-action { display: grid; justify-items: start; gap: 0.9rem; min-width: 15rem; padding: 0.4rem 0 0.4rem clamp(2rem, 4vw, 4rem); border-left: 1px solid rgba(240, 237, 229, 0.16); }
.has-scroll-reveal [data-scroll-reveal]:not(.journey-step) { opacity: 0; transform: translateY(20px); transition: opacity 640ms cubic-bezier(0.16, 1, 0.3, 1), transform 640ms cubic-bezier(0.16, 1, 0.3, 1); }
.has-scroll-reveal [data-scroll-reveal="content"]:not(.journey-step) { transition-delay: 100ms; }
.has-scroll-reveal [data-scroll-reveal]:not(.journey-step).is-scroll-revealed { opacity: 1; transform: translateY(0); }
.has-scroll-reveal .journey-step[data-scroll-reveal] > * { opacity: 0; transform: translateY(20px); transition: opacity 560ms cubic-bezier(0.16, 1, 0.3, 1), transform 560ms cubic-bezier(0.16, 1, 0.3, 1); }
.has-scroll-reveal .journey-step.is-scroll-revealed > * { opacity: 1; transform: translateY(0); }
.has-scroll-reveal .journey-step.is-scroll-revealed > :nth-child(2) { transition-delay: 70ms; }
.has-scroll-reveal .journey-step.is-scroll-revealed > :nth-child(3) { transition-delay: 130ms; }
.has-scroll-reveal .journey-step.is-scroll-revealed > :nth-child(4) { transition-delay: 190ms; }
.close-index { color: rgba(240, 237, 229, 0.42); font: 500 0.59rem/1.4 'JetBrains Mono', 'SF Mono', ui-monospace, monospace; letter-spacing: 0.12em; }
.close-note { margin: 0; color: rgba(240, 237, 229, 0.58); font-size: 0.78rem; line-height: 1.5; }
.close-specs { margin: 0.25rem 0 0; color: rgba(233, 205, 169, 0.72); font: 500 0.6rem/1.5 'JetBrains Mono', 'SF Mono', ui-monospace, monospace; letter-spacing: 0.08em; }
.nav-action--close { min-height: 3rem; }

.journey-step.is-active { opacity: 1; }

@keyframes hero-image-breathe {
  from { transform: scale(1) translate3d(0, 0, 0); }
  to { transform: scale(1.05) translate3d(-0.35%, -0.45%, 0); }
}

@keyframes hero-copy-in {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes cta-sheen {
  to { transform: translateX(430%) skewX(-22deg); }
}

.login-scrim {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: rgba(4, 6, 8, 0.58);
  backdrop-filter: blur(13px) saturate(0.7);
  animation: scrim-in 280ms ease both;
}

.login-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 11;
  display: grid;
  grid-template-columns: minmax(18rem, 0.96fr) minmax(22rem, 1.04fr);
  width: min(72rem, calc(100% - 4rem));
  min-height: 38rem;
  overflow: hidden;
  border: 1px solid rgba(240, 220, 180, 0.22);
  border-radius: 1.25rem;
  background: var(--paper);
  box-shadow:
    0 40px 120px rgba(0, 0, 0, 0.55),
    0 12px 40px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.25);
  color: var(--paper-ink);
  transform: translate(-50%, -50%);
  animation: login-modal-in 420ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.modal-close {
  position: absolute;
  top: 0.9rem;
  right: 0.9rem;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 2.35rem;
  height: 2.35rem;
  border: 1px solid rgba(23, 25, 27, 0.12);
  border-radius: 50%;
  color: rgba(23, 25, 27, 0.66);
  background: rgba(248, 247, 243, 0.72);
  cursor: pointer;
  transition: background-color 220ms ease, color 220ms ease, transform 260ms cubic-bezier(0.32, 0.72, 0, 1);
}

.modal-close:hover,
.modal-close:focus-visible {
  color: var(--paper-ink);
  background: #fff;
  transform: rotate(5deg);
}

.modal-close .material-symbols-outlined { font-size: 1.1rem; }

.modal-visual {
  position: relative;
  min-height: 38rem;
  overflow: hidden;
  color: #fffaf1;
  background: #0b1216;
  animation: modal-visual-in 560ms cubic-bezier(0.16, 1, 0.3, 1) 70ms both;
}

.visual-image,
.visual-shade,
.visual-grain,
.visual-glow {
  position: absolute;
  inset: 0;
}

.visual-image {
  background: var(--hero-image) 70% center / cover no-repeat;
  filter: saturate(0.82) contrast(1.08) brightness(0.82);
  animation: visual-kenburns 22s cubic-bezier(0.25, 0.6, 0.15, 1) alternate infinite;
}

.visual-shade {
  background:
    linear-gradient(180deg, rgba(5, 8, 10, 0.32) 0%, rgba(5, 8, 10, 0.2) 38%, rgba(5, 8, 10, 0.82) 100%),
    linear-gradient(90deg, rgba(5, 8, 10, 0.28), transparent 60%);
}

.visual-grain {
  opacity: 0.09;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.4'/%3E%3C/svg%3E");
  mix-blend-mode: overlay;
  pointer-events: none;
}

.visual-glow {
  background:
    radial-gradient(ellipse 60% 40% at 18% 108%, rgba(226, 123, 77, 0.32), transparent 60%),
    radial-gradient(ellipse 40% 30% at 90% 0%, rgba(120, 160, 200, 0.12), transparent 65%);
  pointer-events: none;
}

.visual-hud {
  position: absolute;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: rgba(255, 250, 241, 0.85);
  font-size: 0.62rem;
  letter-spacing: 0.18em;
}

.visual-hud--tl { top: 1.4rem; left: 1.6rem; }
.visual-hud--tr { top: 1.4rem; right: 1.6rem; }
.hud-mono { font-family: 'JetBrains Mono', 'SF Mono', ui-monospace, monospace; font-size: 0.6rem; }
.hud-sep { width: 1px; height: 0.7rem; background: rgba(255, 250, 241, 0.3); }
.rec-dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: #ff5a4d;
  box-shadow: 0 0 0 3px rgba(255, 90, 77, 0.18), 0 0 10px rgba(255, 90, 77, 0.6);
  animation: rec-blink 1.6s ease-in-out infinite;
}

.visual-content {
  position: absolute;
  right: 2rem;
  bottom: 2.2rem;
  left: 2rem;
  z-index: 2;
}

.visual-tag {
  color: #f0ba7a;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}
.visual-content h2 {
  margin: 0.9rem 0 0;
  font-family: 'Noto Serif SC', 'Songti SC', serif;
  font-size: clamp(1.9rem, 2.6vw, 2.9rem);
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.12;
  text-shadow: 0 2px 24px rgba(0, 0, 0, 0.4);
}

.visual-content p { max-width: 26ch; margin: 0.9rem 0 0; color: rgba(255, 250, 241, 0.72); font-size: 0.78rem; line-height: 1.7; }
.visual-meta { display: flex; justify-content: space-between; gap: 1rem; margin-top: 1.8rem; padding-top: 0.85rem; border-top: 1px solid rgba(255, 250, 241, 0.22); color: rgba(255, 250, 241, 0.65); font-size: 0.6rem; letter-spacing: 0.16em; text-transform: uppercase; }
.visual-frame { position: absolute; z-index: 2; width: 2.2rem; height: 2.2rem; border-color: rgba(240, 186, 122, 0.85); border-style: solid; }
.visual-frame--tl { top: 3.2rem; left: 1.6rem; border-width: 1px 0 0 1px; }
.visual-frame--br { right: 1.6rem; bottom: 1.6rem; border-width: 0 1px 1px 0; }

.modal-form-panel { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding: 4rem clamp(2rem, 5vw, 4.5rem) 3rem; background: linear-gradient(180deg, #f7f3ec 0%, #f3eee5 100%); animation: modal-form-in 560ms cubic-bezier(0.16, 1, 0.3, 1) 170ms both; }
.modal-form-header { margin-bottom: 1.8rem; }
.modal-brand { display: grid; place-items: center; width: 3.1rem; height: 3.1rem; margin-bottom: 1.4rem; border: 1px solid rgba(182, 83, 50, 0.22); border-radius: 0.85rem; color: #fff; background: linear-gradient(145deg, #2a2f33 0%, #17191b 100%); box-shadow: 0 12px 26px rgba(23, 25, 27, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.12); }
.modal-brand .brand-glyph { color: #efb47e; font-size: 1.55rem; text-shadow: 0 1px 12px rgba(226, 123, 77, 0.28); }
.modal-brand .material-symbols-outlined { font-size: 1.25rem; }
.modal-kicker { margin: 0 0 0.55rem; color: #b65332; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; }
.modal-form-header h2 { margin: 0; color: var(--paper-ink); font-family: 'Noto Serif SC', 'Songti SC', serif; font-size: clamp(1.9rem, 2.8vw, 2.6rem); font-weight: 600; letter-spacing: -0.03em; line-height: 1.15; }
.modal-form-header > p:last-child { margin: 0.7rem 0 0; color: #7a7873; font-size: 0.82rem; line-height: 1.6; }

.login-tabs { display: flex; gap: 1.6rem; margin-bottom: 1.6rem; border-bottom: 1px solid rgba(23, 25, 27, 0.12); }
.login-tab { position: relative; padding: 0 0 0.8rem; border: 0; color: #8a8883; background: transparent; font-size: 0.82rem; cursor: pointer; transition: color 180ms ease; }
.login-tab::after { position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; background: #b65332; content: ''; transform: scaleX(0); transition: transform 260ms cubic-bezier(0.32, 0.72, 0, 1); }
.login-tab.is-active { color: var(--paper-ink); font-weight: 700; }
.login-tab.is-active::after { transform: scaleX(1); }

.login-form { display: grid; gap: 1.15rem; }
.form-field { display: grid; gap: 0.5rem; min-width: 0; }
.form-field > span, .field-heading > span { color: #5a5853; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.04em; }
.field-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.input-wrap { position: relative; display: flex; align-items: center; min-height: 3rem; overflow: visible; border: 0; border-bottom: 1px solid rgba(23, 25, 27, 0.24); border-radius: 0; background: transparent; transition: border-color 220ms ease, box-shadow 260ms cubic-bezier(0.32, 0.72, 0, 1); }
.input-wrap::after {
  position: absolute;
  right: 0; bottom: -1px; left: 0;
  height: 1.5px;
  background: linear-gradient(90deg, #b65332, #e27b4d);
  content: '';
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 320ms cubic-bezier(0.16, 1, 0.3, 1);
}
.input-wrap:focus-within { border-bottom-color: transparent; box-shadow: 0 6px 18px -10px rgba(182, 83, 50, 0.35); }
.input-wrap:focus-within::after { transform: scaleX(1); }
.input-wrap.has-error { border-bottom-color: #c7594c; }
.input-wrap.has-error::after { background: #c7594c; transform: scaleX(1); }
.input-glyph { display: inline-grid; place-items: center; flex: 0 0 auto; width: 1.1rem; margin-left: 0.1rem; color: #a8a59e; font-family: Arial, sans-serif; font-size: 0.85rem; transition: color 220ms ease; }
.input-wrap:focus-within .input-glyph { color: #b65332; }
.input-wrap input { min-width: 0; flex: 1; height: 3rem; padding: 0 0.7rem; border: 0; outline: 0; color: var(--paper-ink); background: transparent; font: inherit; font-size: 0.9rem; }
.input-wrap input::placeholder { color: #a8a59e; }
.input-wrap input:-webkit-autofill { -webkit-box-shadow: 0 0 0 100px #f7f3ec inset; -webkit-text-fill-color: var(--paper-ink); border-radius: 0; }
.input-wrap--code .input-glyph { margin-right: 0.05rem; }
.code-button { align-self: stretch; padding: 0 0.9rem; border: 0; border-left: 1px solid rgba(23, 25, 27, 0.1); color: #b65332; background: transparent; font-size: 0.72rem; font-weight: 700; white-space: nowrap; cursor: pointer; transition: color 180ms ease; }
.code-button:hover:not(:disabled) { color: #8a3d24; }
.code-button:disabled { color: #b0ada6; cursor: not-allowed; }
.input-action { display: grid; place-items: center; width: 2.6rem; height: 2.6rem; margin-right: 0.1rem; padding: 0; border: 0; color: #a8a59e; background: transparent; cursor: pointer; }
.input-action:hover, .input-action:focus-visible { color: var(--paper-ink); }
.input-action .icon-glyph { font-size: 1.05rem; }
.field-error { color: #b0453a; font-size: 0.68rem; }
.field-hint { color: #8a6b43; font-size: 0.68rem; }
.form-error { display: flex; align-items: center; gap: 0.4rem; margin: 0; padding: 0.7rem 0.8rem; border-radius: 0.6rem; color: #a8463d; background: rgba(199, 89, 76, 0.08); font-size: 0.72rem; line-height: 1.45; }
.form-error .icon-glyph { font-size: 1rem; }

.submit-button { position: relative; display: flex; align-items: center; justify-content: center; gap: 0.6rem; min-height: 3.3rem; margin-top: 0.5rem; padding: 0 0.8rem 0 1.2rem; border: 0; border-radius: 0.8rem; color: #fffaf1; background: linear-gradient(145deg, #23282b 0%, #17191b 100%); font-size: 0.84rem; font-weight: 700; letter-spacing: 0.02em; cursor: pointer; overflow: hidden; transition: transform 260ms cubic-bezier(0.32, 0.72, 0, 1), box-shadow 320ms cubic-bezier(0.16, 1, 0.3, 1); }
.submit-button::before {
  position: absolute;
  inset: 0;
  background: linear-gradient(120deg, transparent 30%, rgba(255, 255, 255, 0.12) 50%, transparent 70%);
  content: '';
  transform: translateX(-100%);
  transition: transform 600ms cubic-bezier(0.16, 1, 0.3, 1);
}
.submit-button:hover:not(:disabled), .submit-button:focus-visible { box-shadow: 0 14px 30px -10px rgba(23, 25, 27, 0.45); transform: translateY(-2px); }
.submit-button:hover:not(:disabled)::before { transform: translateX(100%); }
.submit-button:active:not(:disabled) { transform: translateY(0) scale(0.99); }
.submit-button:disabled { color: rgba(255, 250, 241, 0.74); background: linear-gradient(145deg, #626a67 0%, #444b49 100%); cursor: not-allowed; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08); }
.submit-button:disabled .cta-icon--dark { color: rgba(255, 250, 241, 0.72); background: rgba(255, 255, 255, 0.08); }
.cta-icon--dark { display: inline-grid; place-items: center; width: 1.9rem; height: 1.9rem; border-radius: 50%; color: #fffaf1; background: rgba(255, 255, 255, 0.14); transition: background 220ms ease, transform 260ms cubic-bezier(0.32, 0.72, 0, 1); }
.submit-button:hover:not(:disabled) .cta-icon--dark { background: rgba(226, 123, 77, 0.35); transform: translateX(2px); }
.button-spinner { width: 0.95rem; height: 0.95rem; border: 2px solid rgba(255, 255, 255, 0.36); border-top-color: #fff; border-radius: 50%; animation: spin 700ms linear infinite; }
.agreement-copy { margin: 1.2rem 0 0; color: #8a8780; font-size: 0.65rem; line-height: 1.6; }
.register-prompt { margin: auto 0 0; padding-top: 1.8rem; color: #6e6b66; font-size: 0.75rem; text-align: center; }
.text-action { padding: 0; border: 0; color: #b65332; background: transparent; cursor: pointer; }
.text-action:hover, .text-action:focus-visible { color: #8a3d24; text-decoration: underline; text-underline-offset: 0.18em; }
.text-action--strong { margin-left: 0.25rem; font-weight: 700; }

.portal-link:focus-visible, .brand-lockup:focus-visible, .nav-action:focus-visible, .hero-cta:focus-visible, .modal-close:focus-visible, .login-tab:focus-visible, .code-button:focus-visible, .input-action:focus-visible, .submit-button:focus-visible, .text-action:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

@keyframes reveal-up { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
@keyframes spin { to { transform: rotate(360deg); } }
.login-mode-panel { display: grid; gap: 1rem; animation: tab-panel-in 220ms cubic-bezier(0.16, 1, 0.3, 1) both; }
.error-message { animation: error-in 160ms cubic-bezier(0.16, 1, 0.3, 1) both; }

@keyframes modal-visual-in {
  from { opacity: 0; transform: translateX(-14px); }
  to { opacity: 1; transform: translateX(0); }
}

@keyframes modal-form-in {
  from { opacity: 0; transform: translateX(14px); }
  to { opacity: 1; transform: translateX(0); }
}

@keyframes scrim-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes login-modal-in {
  from { opacity: 0; transform: translate(-50%, -46%) scale(0.98); }
  to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}

@keyframes tab-panel-in {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes error-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes visual-kenburns {
  from { transform: scale(1.0) translate(0, 0); }
  to { transform: scale(1.08) translate(-1.5%, -1%); }
}

@keyframes rec-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}

@media (max-width: 1100px) {
  .portal-nav, .portal-hero { width: min(100% - 3rem, 900px); }
  .portal-links { gap: 1.2rem; }
  .capability-rail { grid-template-columns: minmax(13rem, 1.2fr) repeat(3, minmax(10rem, 1fr)); }
  .rail-end { display: none; }
  .login-modal { grid-template-columns: minmax(15rem, 0.9fr) minmax(20rem, 1.1fr); }
  .modal-form-panel { padding-right: 3rem; padding-left: 3rem; }
}

@media (max-width: 820px) {
  .portal-nav { width: calc(100% - 2rem); padding-top: 1rem; }
  .portal-links { display: none; }
  .nav-action { min-height: 2.35rem; padding-inline: 0.85rem; }
  .portal-hero { width: calc(100% - 2rem); min-height: calc(100dvh - 8rem); padding-top: 2rem; }
  .hero-copy { width: min(31rem, 100%); }
  .hero-copy h1 { font-size: clamp(2.8rem, 11vw, 4.4rem); }
  .hero-caption { right: 1rem; bottom: 7.3rem; }
  .capability-rail { grid-template-columns: repeat(3, 1fr); }
  .rail-intro { grid-column: 1 / -1; min-height: 3.4rem; border-bottom: 1px solid var(--line); }
  .rail-item { min-height: 4.9rem; padding: 0.85rem 0.8rem; }
  .rail-item .material-symbols-outlined { font-size: 1.1rem; }
  .rail-item strong { font-size: 0.68rem; }
  .rail-item small { display: none; }
  .login-modal { width: calc(100% - 2rem); min-height: 0; max-height: calc(100dvh - 2rem); overflow-y: auto; }
  .modal-visual { min-height: 20rem; }
  .modal-form-panel { padding: 3rem 2rem 2rem; }
  .register-prompt { margin-top: 1.6rem; }
}

@media (max-width: 560px) {
  .brand-copy small { font-size: 0.55rem; }
  .login-modal { display: block; width: calc(100% - 1rem); max-height: calc(100dvh - 1rem); border-radius: 1.15rem; }
  .modal-visual { min-height: 13rem; }
  .visual-content { right: 1.35rem; bottom: 1.3rem; left: 1.35rem; }
  .visual-content h2 { margin-top: 0.4rem; font-size: 1.4rem; }
  .visual-content p, .visual-meta { display: none; }
  .modal-visual::after { opacity: 0.08; }
  .visual-hud--tr { display: none; }
  .visual-frame--tl { top: 1rem; left: 1rem; }
  .visual-frame--br { right: 1rem; bottom: 1rem; }
  .modal-form-panel { padding: 2rem 1.25rem 1.4rem; }
  .modal-form-header { margin-bottom: 1.4rem; }
  .modal-brand { width: 2.7rem; height: 2.7rem; margin-bottom: 1rem; }
  .modal-form-header h2 { font-size: 2rem; }
  .login-tabs { margin-bottom: 1.25rem; }
  .input-wrap { min-height: 3rem; }
  .input-wrap input { height: 2.9rem; }
  .code-button { padding-inline: 0.65rem; font-size: 0.65rem; }
  .agreement-copy { margin-top: 1rem; }
}

@media (max-width: 820px) {
  .portal-nav, .portal-hero { width: calc(100% - 2rem); }
  .portal-nav { gap: 0.8rem; }
  .brand-lockup { gap: 0.55rem; }
  .brand-mark { flex: 0 0 2.2rem; }
  .brand-copy small { font-size: 0.52rem; letter-spacing: 0.08em; }
  .portal-links { display: flex; gap: 1rem; }
  .portal-link { font-size: 0.75rem; white-space: nowrap; }
  .nav-action { flex: 0 0 auto; min-height: 2.5rem; padding: 0.35rem 0.8rem; white-space: nowrap; }
  .portal-hero { grid-template-columns: minmax(0, 1fr); gap: 1.25rem; min-height: calc(100svh - 4rem); padding: 1.5rem 0 3.5rem; }
  .hero-image-wrap { grid-column: 1; grid-row: 1; aspect-ratio: 1.35; }
  .hero-copy { grid-column: 1; grid-row: 2; }
  .hero-copy h1 { font-size: clamp(3rem, 9vw, 4.5rem); }
  .hero-caption { right: 0.8rem; bottom: 3rem; font-size: 0.62rem; }
  .hero-scroll { position: static; grid-column: 1; justify-self: center; margin-top: 0.3rem; transform: none; }
  .workflow { padding: 5.5rem 1.25rem 6rem; }
  .workflow-heading { display: block; margin-bottom: 2rem; }
  .workflow-heading p { margin-top: 1.1rem; }
  .journey-layout { grid-template-columns: minmax(0, 1fr); gap: 1.25rem; }
  .journey-stage { position: relative; top: auto; z-index: auto; grid-template-columns: minmax(0, 1fr); height: fit-content; padding: 0.75rem; }
  .stage-note { bottom: -1.45rem; }
  .journey-step, .journey-step:first-child, .journey-step:last-child { min-height: 52vh; padding: 3rem 0; }
  .journey-step.is-active { opacity: 1; }
  .portal-hero { grid-template-rows: auto auto auto auto; gap: 1.25rem; min-height: 0; padding: 1.5rem 0 3.5rem; }
  .hero-feature-rail { grid-column: 1; grid-row: 3; gap: 1.1rem; }
  .hero-feature-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem 0.8rem; }
  .hero-scroll { grid-row: 4; }
  .portal-close { padding: 3.75rem 1.25rem; }
  .close-inner { grid-template-columns: minmax(0, 1fr); gap: 2rem; }
  .close-action { grid-template-columns: auto 1fr; align-items: center; gap: 0.45rem 1rem; min-width: 0; padding: 1.35rem 0 0; border-top: 1px solid rgba(240, 237, 229, 0.16); border-left: 0; }
  .close-index { grid-column: 1 / -1; }
  .close-note, .close-specs { justify-self: start; }
  .close-particles { height: min(38vh, 18rem); opacity: 0.72; }
}

@media (max-width: 560px) {
  .portal-nav { width: calc(100% - 1.5rem); gap: 0.55rem; padding: 0.85rem 0; }
  .brand-copy small { display: none; }
  .portal-links { display: none; }
  .portal-link { font-size: 0.69rem; }
  .nav-action { min-height: 2.45rem; padding-inline: 0.68rem; font-size: 0.72rem; }
  .nav-action .material-symbols-outlined { font-size: 0.9rem; }
  .portal-hero { width: calc(100% - 1.5rem); padding-top: 0.5rem; padding-bottom: 2rem; }
  .hero-image-wrap { aspect-ratio: 1.78; }
  .hero-copy h1 { font-size: clamp(2.65rem, 12vw, 3.75rem); }
  .hero-description { max-width: 30ch; font-size: 0.9rem; }
  .hero-caption { right: 0.6rem; bottom: 2.8rem; font-size: 0.58rem; }
  .workflow { padding: 2.75rem 0.9rem 5rem; }
  .hero-feature-grid { gap: 0.9rem 0.55rem; }
  .feature-card { gap: 0.55rem; }
  .feature-image { aspect-ratio: 1.45; }
  .feature-heading { gap: 0.65rem; }
  .feature-heading__rule { width: 12vw; }
  .feature-heading h2 { font-size: 1rem; }
  .feature-heading p { font-size: 0.61rem; }
  .feature-copy__title { gap: 0.42rem; flex-wrap: wrap; }
  .feature-index { font-size: 0.48rem; }
  .feature-copy h3 { font-size: 0.9rem; }
  .feature-copy p { margin-top: 0.2rem; font-size: 0.62rem; }
  .workflow-heading h2 { font-size: 2.35rem; }
  .workflow-heading p { max-width: 32ch; font-size: 0.9rem; }
  .journey-stage { grid-template-columns: minmax(0, 1fr); gap: 0.55rem; padding: 0.55rem; }
  .stage-frame { max-height: 100%; }
  .storyboard-strip { gap: 0.4rem; }
  .storyboard-strip img { aspect-ratio: 4 / 3; }
  .storyboard-strip figcaption { padding: 0.3rem 0.25rem; font-size: 0.58rem; }
  .stage-marker { left: 0.5rem; font-size: 0.66rem; }
  .stage-marker--top { top: 0.5rem; }
  .stage-marker--bottom { bottom: 0.5rem; }
  .journey-step, .journey-step:first-child, .journey-step:last-child { min-height: 48vh; padding: 2.75rem 0; }
  .journey-step h3 { font-size: 2rem; }
  .journey-step p { font-size: 0.9rem; }
  .stage-note { bottom: -1.45rem; font-size: 0.7rem; }
}

@media (max-width: 360px) {
  .portal-nav { width: calc(100% - 1.25rem); }
}

.portal-nav {
  position: sticky;
  top: 0;
  z-index: 8;
  width: 100%;
  box-sizing: border-box;
  padding: 1rem max(2.5rem, calc((100% - 1440px) / 2));
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(10, 14, 13, 0.76);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}

@media (max-width: 1100px) {
  .portal-nav { padding-right: 1.5rem; padding-left: 1.5rem; }
}

@media (max-width: 820px) {
  .portal-nav { width: 100%; padding: 0.8rem 1rem; }
}

@media (max-width: 560px) {
  .portal-nav { width: 100%; padding: 0.75rem 0.75rem; }
  .portal-close { padding-right: 1rem; padding-left: 1rem; }
  .close-particles { height: min(34vh, 14rem); opacity: 0.66; }
}

@media (prefers-reduced-motion: reduce) {
  .login-page { scroll-behavior: auto; }
  .hero-image, .hero-copy, .hero-caption, .button-spinner, .visual-image, .rec-dot { animation: none !important; }
  .portal-nav, .nav-action, .hero-cta, .hero-cta::before, .hero-scroll__arrow, .feature-card, .feature-image, .storyboard-strip img, .modal-close, .submit-button,
  .login-scrim, .login-modal, .modal-visual, .modal-form-panel,
  .login-mode-panel, .error-message, .stage-frame img, .storyboard-strip,
  .journey-stage, .journey-step, .stage-progress span, .input-wrap::after, .submit-button::before {
    animation: none !important;
    transition: none !important;
  }
  .has-scroll-reveal [data-scroll-reveal],
  .has-scroll-reveal .journey-step[data-scroll-reveal] > * {
    opacity: 1 !important;
    transform: none !important;
    transition: none !important;
  }
}

:global(html),
:global(body),
:global(#app) {
  width: 100%;
  min-height: 100%;
  overflow-x: hidden;
}
</style>
