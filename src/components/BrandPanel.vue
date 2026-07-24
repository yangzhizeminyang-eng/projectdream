<!--
  @file BrandPanel - 登录/注册/找回/重置页统一品牌区
  @description
    - 设计语言：Darkroom Professional（深炭灰 + 燃烧橙 + 青铜描边）
    - 三段式：顶部 brand-top（logo + 系统状态）/ 中部 brand-mid（宣言 + 元数据）/ 底部 brand-bottom（工具集 + 版本号）
    - 装饰大数字（mega） + 边角技术刻度（brutalist 细节） + 网格 mask + 顶部底部 vignette
    - 多视口（1024/1280/1440/1920+）内部排版自适应：字体与间距使用 clamp
    - props 接收 episode 编号（01/02/03/04） 与 meta 信息，便于四页复用
  @author PanelFlow Studio
-->
<script setup lang="ts">
/**
 * @file <script setup> 段定义 props
 */
import { computed } from 'vue'

/**
 * @description 品牌区 props
 * @property {string} episode - 章节编号，如 "01"
 * @property {string} label - 章节名称，如“登录”
 * @property {string} release - 版本号，默认 v2.4.0
 * @property {string} studio - 工作室代号，默认 AUTEUR
 * @property {string} latitude - 默认 34.05°N
 * @property {string} longitude - 默认 118.24°E
 * @property {string} version - 底部版本号，默认 Auteur Studio v2.4
 * @property {string} bgImage - 背景图 URL；不传则用内置默认
 */
interface Props {
  episode: string
  label: string
  release?: string
  studio?: string
  latitude?: string
  longitude?: string
  version?: string
  bgImage?: string
}

const props = withDefaults(defineProps<Props>(), {
  release: 'v2.4.0',
  studio: '主创片场',
  latitude: '34.05°N',
  longitude: '118.24°E',
  version: '梦绘片场 v2.4',
  bgImage:
    'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=A%20cinematic%20low-angle%20wide%20shot%20of%20a%20high-tech%20AI%20film%20production%20studio.%20Darkroom%20professional%20aesthetic%20with%20deep%20charcoal%20tones%20and%20sharp%20burning%20orange%20lighting%20accents.%20A%20backlit%20transparent%20storyboard%20table%20glows%20with%20digital%20sketches.%20Floating%20holographic%20film%20reels%20and%20advanced%20video%20editing%20workstations%20with%20multiple%20monitors%20in%20the%20background.%20Atmospheric%20smoke%20and%20anamorphic%20lens%20flares.%20High-contrast%2C%20moody%2C%20disciplined%20auteur%20atmosphere.&image_size=landscape_16_9',
})

/** 背景图 inline style */
const bgStyle = computed(() => ({ backgroundImage: `url('${props.bgImage}')` }))
</script>

<template>
  <section class="brand-panel" aria-label="PanelFlow 品牌区">
    <!-- 1. 背景图（漂浮动效） -->
    <div class="brand-bg" :style="bgStyle" role="presentation" aria-hidden="true"></div>

    <!-- 2. 暗色叠加（保证文字可读） -->
    <div class="brand-overlay" role="presentation" aria-hidden="true"></div>

    <!-- 2.1 顶部/底部 vignette（增强暗房层次） -->
    <div class="brand-vignette" role="presentation" aria-hidden="true"></div>

    <!-- 2.2 中央辉光（突出宣言） -->
    <div class="brand-glow" role="presentation" aria-hidden="true"></div>

    <!-- 3. 网格细线（科技质感） -->
    <div class="brand-grid" role="presentation" aria-hidden="true"></div>

    <!-- 4. 边角技术刻度（brutalist 细节） -->
    <span class="brand-corner brand-corner--tl" aria-hidden="true"></span>
    <span class="brand-corner brand-corner--tr" aria-hidden="true"></span>
    <span class="brand-corner brand-corner--bl" aria-hidden="true"></span>
    <span class="brand-corner brand-corner--br" aria-hidden="true"></span>

    <!-- 5. 内容层：顶 / 中 / 底三段 -->
    <div class="brand-content">
      <!-- 顶部：品牌行 + 系统状态 -->
      <header class="brand-top">
        <div class="brand-mark" aria-hidden="true">
          <span class="material-symbols-outlined">movie_filter</span>
        </div>
        <h2 class="brand-name">PanelFlow</h2>
        <span class="brand-divider" aria-hidden="true"></span>
        <span class="brand-status" aria-hidden="true">
          <span class="brand-status-dot"></span>
          <span>系统在线</span>
        </span>
      </header>

      <!-- 中部：宣言 + 元数据 -->
      <div class="brand-mid">
        <span class="brand-eyebrow" aria-hidden="true">— 第 {{ episode }} 章 / {{ label }}</span>
        <p class="brand-headline">
          开启 AI <br />叙事新纪元
        </p>
        <span class="brand-bar" aria-hidden="true"></span>
        <p class="brand-desc">
          专为专业创作者打造的电影级 AI 分镜与视效创作平台。将灵感转化为精准的视觉语言，重塑叙事效率。
        </p>

        <dl class="brand-meta" aria-label="系统参数">
          <div class="brand-meta-item">
            <dt>版本</dt>
            <dd>{{ release }}</dd>
          </div>
          <div class="brand-meta-item">
            <dt>片场</dt>
            <dd>{{ studio }}</dd>
          </div>
          <div class="brand-meta-item">
            <dt>纬度</dt>
            <dd>{{ latitude }}</dd>
          </div>
          <div class="brand-meta-item">
            <dt>经度</dt>
            <dd>{{ longitude }}</dd>
          </div>
        </dl>
      </div>

      <!-- 底部：工具集 + 版本号 -->
      <footer class="brand-bottom">
        <div class="brand-tools" aria-hidden="true">
          <div class="brand-tool" title="分镜">
            <span class="material-symbols-outlined">auto_stories</span>
          </div>
          <div class="brand-tool" title="镜头">
            <span class="material-symbols-outlined">videocam</span>
          </div>
          <div class="brand-tool" title="剪辑">
            <span class="material-symbols-outlined">movie_edit</span>
          </div>
          <div class="brand-tool" title="生成">
            <span class="material-symbols-outlined">auto_awesome</span>
          </div>
        </div>
        <span class="brand-version">{{ version }}</span>
      </footer>
    </div>

    <!-- 6. 装饰大数字（带"已编号"前缀） -->
    <div class="brand-mega" aria-hidden="true">
      <span class="brand-mega-prefix">№</span>
      <span class="brand-mega-num">{{ episode }}</span>
    </div>

    <!-- 7. 顶部 / 底部刻度条（brutalist 装饰） -->
    <div class="brand-tick brand-tick--top" aria-hidden="true"></div>
    <div class="brand-tick brand-tick--bottom" aria-hidden="true"></div>
  </section>
</template>

<style scoped>
/* =====================================================================
 * BrandPanel - Darkroom Professional 品牌区
 * 4 个页面共用样式语言；内部 scoped；外部容器需设置 .auth-shell
 * 优化记录：
 *  - 新增顶部/底部 vignette 暗角
 *  - 新增中央辉光突出宣言
 *  - 新增顶部/底部刻度条
 *  - 重构响应式断点：1024/1280/1440/1920 内部排版自适应
 * ===================================================================== */

/* ---------- 设计 Token（与四页保持一致） ---------- */
.brand-panel {
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
  --font-display: 'Playfair Display', 'Noto Serif SC', serif;
  --font-body: 'Noto Sans', 'Noto Sans SC', sans-serif;

  position: relative;
  display: none;
  width: 50%;
  overflow: hidden;
  border-right: 1px solid var(--color-outline);
  flex-shrink: 0;
  isolation: isolate;
  background: var(--color-bg);
  min-height: 100vh;
  min-height: 100dvh;
}

@media (min-width: 1024px) {
  .brand-panel { display: flex; }
}

/* ---------- 1. 背景图（漂浮动效） ---------- */
.brand-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  background-position: center;
  background-size: cover;
  filter: grayscale(0.4) contrast(1.08) brightness(0.6) sepia(0.08);
  animation: plateDrift 60s ease-in-out infinite alternate;
  will-change: transform;
}

@keyframes plateDrift {
  from { transform: scale(1.05) translate3d(0, 0, 0); }
  to   { transform: scale(1.12) translate3d(-1.4%, -1.0%, 0); }
}

/* ---------- 2. 暗色叠加 ---------- */
.brand-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(
    to right,
    rgba(18, 20, 18, 0.92) 0%,
    rgba(18, 20, 18, 0.45) 50%,
    rgba(18, 20, 18, 0.92) 100%
  );
  pointer-events: none;
}

/* ---------- 2.1 顶部 / 底部 vignette ---------- */
.brand-vignette {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background:
    linear-gradient(
      180deg,
      rgba(18, 20, 18, 0.55) 0%,
      rgba(18, 20, 18, 0) 28%,
      rgba(18, 20, 18, 0) 72%,
      rgba(18, 20, 18, 0.55) 100%
    );
}

/* ---------- 2.2 中央辉光（突出宣言） ---------- */
.brand-glow {
  position: absolute;
  z-index: 1;
  top: 40%;
  left: 50%;
  width: 60rem;
  height: 28rem;
  max-width: 110%;
  transform: translate(-50%, -50%);
  background: radial-gradient(
    ellipse at center,
    rgba(217, 119, 6, 0.12) 0%,
    rgba(217, 119, 6, 0.05) 35%,
    transparent 70%
  );
  filter: blur(8px);
  pointer-events: none;
}

/* ---------- 3. 网格细线 ---------- */
.brand-grid {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(255, 183, 125, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 183, 125, 0.05) 1px, transparent 1px);
  background-size: 80px 80px;
  background-position: -1px -1px;
  mask-image: radial-gradient(ellipse at center, black 30%, transparent 80%);
  -webkit-mask-image: radial-gradient(ellipse at center, black 30%, transparent 80%);
}

/* ---------- 4. 边角技术刻度 ---------- */
.brand-corner {
  position: absolute;
  z-index: 5;
  width: 18px;
  height: 18px;
  border: 1px solid var(--color-primary);
  pointer-events: none;
  opacity: 0.7;
}
.brand-corner--tl { top: 1.25rem; left: 1.25rem; border-right: none; border-bottom: none; }
.brand-corner--tr { top: 1.25rem; right: 1.25rem; border-left: none; border-bottom: none; }
.brand-corner--bl { bottom: 1.25rem; left: 1.25rem; border-right: none; border-top: none; }
.brand-corner--br { bottom: 1.25rem; right: 1.25rem; border-left: none; border-top: none; }

/* ---------- 7. 顶部 / 底部刻度条（brutalist） ---------- */
.brand-tick {
  position: absolute;
  z-index: 5;
  left: 1.25rem;
  right: 1.25rem;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--color-primary) 20%,
    var(--color-primary) 80%,
    transparent 100%
  );
  opacity: 0.35;
  pointer-events: none;
}
.brand-tick--top    { top: 1.25rem; }
.brand-tick--bottom { bottom: 1.25rem; }

/* ---------- 5. 内容层 ---------- */
.brand-content {
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  width: 100%;
  height: 100%;
  padding: clamp(2.25rem, 4.5vw, 5rem) clamp(1.75rem, 3vw, 5rem);
  gap: clamp(1.25rem, 2.5vw, 2rem);
}

/* 顶部 logo + 状态 */
.brand-top {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  animation: rise 800ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border: 1px solid var(--color-primary);
  background: rgba(255, 183, 125, 0.08);
  color: var(--color-primary);
  flex-shrink: 0;
  box-shadow: 0 0 18px rgba(255, 183, 125, 0.12);
}
.brand-mark .material-symbols-outlined {
  font-size: 22px;
  font-variation-settings: 'FILL' 1, 'wght' 500, 'GRAD' 0, 'opsz' 24;
}

.brand-name {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.5rem;
  letter-spacing: -0.01em;
  color: var(--color-primary);
  line-height: 1;
}

.brand-divider {
  display: inline-block;
  width: 1px;
  height: 1.25rem;
  background: var(--color-outline);
  margin: 0 0.25rem;
}

.brand-status {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-body);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--color-text-mute);
}

.brand-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4ade80;
  box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.18);
  animation: pulse 2.4s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.18); }
  50%      { box-shadow: 0 0 0 6px rgba(74, 222, 128, 0.05); }
}

/* 中部：宣言 + 元数据 */
.brand-mid {
  max-width: 38rem;
  animation: rise 1000ms cubic-bezier(0.16, 1, 0.3, 1) 100ms both;
}

.brand-eyebrow {
  display: inline-block;
  margin: 0 0 1.25rem;
  font-family: var(--font-body);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--color-primary-strong);
}

.brand-headline {
  margin: 0 0 1.5rem;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(2.25rem, 3.4vw, 3.5rem);
  line-height: 1.08;
  letter-spacing: -0.02em;
  color: var(--color-text);
  text-wrap: balance;
}

.brand-bar {
  display: block;
  width: 5rem;
  height: 2px;
  background: linear-gradient(
    90deg,
    var(--color-primary-strong) 0%,
    var(--color-primary) 100%
  );
  margin-bottom: 1.5rem;
  box-shadow: 0 0 12px rgba(217, 119, 6, 0.35);
}

.brand-desc {
  margin: 0 0 2rem;
  max-width: 30rem;
  font-family: var(--font-body);
  font-size: 1.0625rem;
  font-weight: 400;
  line-height: 1.65;
  color: var(--color-text-soft);
}

.brand-meta {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1.25rem 1.5rem;
  margin: 0;
  padding: 1.25rem 0 0;
  border-top: 1px solid var(--color-outline);
}

.brand-meta-item { margin: 0; min-width: 0; }
.brand-meta-item dt {
  margin: 0 0 0.375rem;
  font-family: var(--font-body);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--color-text-mute);
  white-space: nowrap;
}
.brand-meta-item dd {
  margin: 0;
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 0.875rem;
  letter-spacing: 0.02em;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 底部：工具集 + 版本号 */
.brand-bottom {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  animation: rise 1000ms cubic-bezier(0.16, 1, 0.3, 1) 200ms both;
}

.brand-tools { display: flex; margin-left: 0; }

.brand-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  border: 1px solid var(--color-outline);
  background: rgba(26, 28, 26, 0.65);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  color: var(--color-text-soft);
  margin-right: -0.875rem;
  transition: transform 0.2s ease, border-color 0.2s ease, color 0.2s ease, background 0.2s ease;
  position: relative;
}
.brand-tool:hover {
  transform: translateY(-3px);
  border-color: var(--color-text-mute);
  color: var(--color-primary);
  background: rgba(35, 36, 32, 0.85);
  z-index: 1;
}
.brand-tool .material-symbols-outlined {
  font-size: 20px;
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}

.brand-version {
  font-family: var(--font-body);
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--color-text-mute);
}

@keyframes rise {
  from { opacity: 0; transform: translate3d(0, 18px, 0); }
  to   { opacity: 1; transform: translate3d(0, 0, 0); }
}

/* ---------- 6. 装饰大数字 ---------- */
.brand-mega {
  position: absolute;
  bottom: clamp(0.5rem, 1.5vw, 1.5rem);
  right: clamp(1rem, 2vw, 2rem);
  z-index: 4;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  user-select: none;
  pointer-events: none;
  line-height: 0.85;
}

.brand-mega-prefix {
  font-family: var(--font-body);
  font-weight: 700;
  font-size: clamp(1.25rem, 2vw, 2.25rem);
  letter-spacing: 0.1em;
  color: var(--color-text-mute);
  opacity: 0.5;
  transform: translateY(-0.6em);
}

.brand-mega-num {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(6rem, 10vw, 12rem);
  letter-spacing: -0.05em;
  color: transparent;
  background: linear-gradient(
    180deg,
    rgba(41, 42, 40, 0.95) 0%,
    rgba(41, 42, 40, 0.6) 60%,
    rgba(41, 42, 40, 0.25) 100%
  );
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  text-shadow: 0 1px 0 rgba(255, 183, 125, 0.04);
}

/* ---------- 响应式断点 ---------- */

/* 大屏 ≥1920：充足空间，放大 padding */
@media (min-width: 1920px) {
  .brand-content { padding: 5rem 5rem; gap: 2rem; }
  .brand-meta { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}

/* 1440-1919：标准桌面 */
@media (min-width: 1440px) and (max-width: 1919px) {
  .brand-content { padding: 3.5rem 3.5rem; }
}

/* 1280-1439：紧凑桌面，关键平衡点 */
@media (min-width: 1280px) and (max-width: 1439px) {
  .brand-content { padding: 3rem 2.75rem; gap: 1.5rem; }
  .brand-headline { font-size: clamp(2.25rem, 3.4vw, 2.75rem); }
  .brand-desc { font-size: 1rem; }
  .brand-meta {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.875rem 1.25rem;
  }
  .brand-mega-num { font-size: clamp(6rem, 9vw, 9rem); }
}

/* 1024-1279：桌面最低端，最关键适配点 */
@media (min-width: 1024px) and (max-width: 1279px) {
  .brand-content { padding: 2.25rem 2.25rem; gap: 1.25rem; }
  .brand-headline { font-size: 2.125rem; line-height: 1.1; }
  .brand-eyebrow { margin-bottom: 1rem; }
  .brand-desc { font-size: 0.9375rem; line-height: 1.55; margin-bottom: 1.5rem; }
  .brand-meta {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem 1rem;
    padding-top: 1rem;
  }
  .brand-meta-item dt { font-size: 0.5625rem; letter-spacing: 0.16em; }
  .brand-meta-item dd { font-size: 0.8125rem; }
  .brand-mid { max-width: 100%; }
  .brand-mega-num { font-size: clamp(5.5rem, 8vw, 7.5rem); }
  .brand-mega-prefix { font-size: 1.25rem; }
  .brand-corner { width: 14px; height: 14px; }
  .brand-tick { left: 2.25rem; right: 2.25rem; }
}

@media (max-width: 1023px) {
  .brand-panel { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .brand-bg,
  .brand-status-dot,
  .brand-top,
  .brand-mid,
  .brand-bottom {
    animation: none !important;
    transform: none !important;
  }
}
</style>
