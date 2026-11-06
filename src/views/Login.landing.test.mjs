import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const loginSource = readFileSync(new URL('./Login.vue', import.meta.url), 'utf8')
const routerSource = readFileSync(new URL('../router/index.ts', import.meta.url), 'utf8')

test('public workflow navigation scrolls to the matching stages without opening login', () => {
  assert.match(loginSource, /href="#workflow"[^>]*>\s*制作流程/)
  assert.match(loginSource, /id="workflow"/)
  const portalNav = loginSource.match(/<nav class="portal-links"[\s\S]*?<\/nav>/)?.[0] ?? ''
  assert.equal((portalNav.match(/class="portal-link"/g) ?? []).length, 1)
  assert.doesNotMatch(portalNav, /分镜与成片/)
  assert.match(loginSource, /id="storyboard"/)
})

test('only the workbench action opens login and the hero explains that boundary', () => {
  assert.match(loginSource, /class="nav-action"[^>]*aria-label="进入工作台，登录后继续创作"[^>]*@click="openLogin"/)
  assert.match(loginSource, /class="hero-cta" href="#workflow"[\s\S]*?了解制作流程/)
  assert.match(loginSource, /登录后保存并继续创作/)
  assert.match(routerSource, /path: '\/'[\s\S]*?meta: \{ guestOnly: true, title: '产品介绍' \}/)
})

test('the closing workbench invitation is compact, editorial, and responsive', () => {
  assert.match(loginSource, /class="portal-close"[\s\S]*?class="close-inner"[\s\S]*?class="close-copy"[\s\S]*?class="close-action"/)
  assert.match(loginSource, /class="close-description"/)
  assert.match(loginSource, /\.portal-close\s*\{[^}]*background:[\s\S]*?radial-gradient/s)
  assert.match(loginSource, /\.close-inner\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s)
  assert.match(loginSource, /@media \(max-width:\s*820px\)[\s\S]*?\.close-inner\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s)
  const closeStyles = loginSource.match(/\.portal-close\s*\{([^}]*)\}/s)?.[1] ?? ''
  assert.match(closeStyles, /min-height:\s*max\(100vh, 100svh\)/)
  assert.match(closeStyles, /align-items:\s*center/)
  assert.match(loginSource, /\.portal-close\s*\{[^}]*padding:\s*clamp\(/s)
  assert.match(loginSource, /<canvas ref="closeParticleField" class="close-particles" aria-hidden="true"><\/canvas>/)
  assert.match(loginSource, /function mountCloseParticleField\(canvas: HTMLCanvasElement\)/)
  assert.match(loginSource, /new IntersectionObserver\([\s\S]*?canvas/)
  assert.match(loginSource, /closeParticleCleanup = mountCloseParticleField\(closeParticleField\.value\)/)
  assert.match(loginSource, /closeParticleCleanup\?\.\(\)/)
  assert.match(loginSource, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/)
  assert.match(loginSource, /requestAnimationFrame\(/)
  assert.match(loginSource, /document\.hidden/)
  assert.doesNotMatch(loginSource, /close-reel|closeReelObserver|closeReelVisible/)
})

test('the public story journey identifies the sample artwork and all production stages', () => {
  assert.match(loginSource, /演示画面/)
  assert.match(loginSource, /角色设定/)
  assert.match(loginSource, /label: '角色设定'/)
  assert.match(loginSource, /分镜脚本/)
  assert.match(loginSource, /竖屏成片/)
  assert.match(loginSource, /role="progressbar"/)
  assert.match(loginSource, /class="journey-steps" role="group" aria-label="漫剧制作步骤"/)
  assert.match(loginSource, /id="characters"/)
  assert.match(loginSource, /id="finished"/)
})

test('the journey preview metadata follows the selected production stage', () => {
  assert.match(loginSource, /label: '角色设定', meta: '角色资产板 · 五视图'/)
  assert.match(loginSource, /label: '分镜脚本',[^\n]*meta: '镜头节奏'/)
  assert.match(loginSource, /label: '成片镜头',[^\n]*meta: '9:16 · 24 FPS'/)
  assert.match(loginSource, /stage-marker--bottom">\{\{ currentWorkflowFrame\.meta \}\}/)
  assert.doesNotMatch(loginSource, /stage-marker stage-marker--bottom">9:16/)
})

test('the character stage displays the generated character asset board as an image, not a CSS imitation', () => {
  assert.match(loginSource, /characterAssetBoardUrl = '\/images\/landing-character-board-linzixia-v1\.jpg'/)
  assert.match(loginSource, /src: characterAssetBoardUrl, label: '角色设定', meta: '角色资产板 · 五视图'/)
  assert.match(loginSource, /林知夏角色资产板：全身、脸部特写、正面、侧面与背面设定/)
  assert.doesNotMatch(loginSource, /characterReferenceUrl/)
  assert.doesNotMatch(loginSource, /class="character-board"/)
  assert.doesNotMatch(loginSource, /character-asset-pending|storyboard-placeholder/)
  assert.match(loginSource, /stage-frame__character-board/)
  assert.match(loginSource, /storyboard-strip__character/)
  assert.match(loginSource, /\.storyboard-strip figure\.storyboard-strip__character img\s*\{[^}]*object-fit:\s*contain/s)
  assert.match(loginSource, /\.storyboard-strip figcaption\s*\{[^}]*position:\s*static/s)
  assert.match(loginSource, /v-if="activeStage !== 0" class="stage-marker stage-marker--top"/)
  assert.match(loginSource, /v-if="activeStage !== 0" class="stage-marker stage-marker--bottom"/)
})

test('the hero, character asset board, storyboard, and finished frame use distinct intended artwork', () => {
  assert.match(loginSource, /heroImageUrl = '\/images\/login-hero-clean\.webp'/)
  assert.match(loginSource, /alt="漫剧氛围演示画面：夜间工业走廊中，一名戴头灯的女性拿着对讲机观察前方"/)
  assert.match(loginSource, /\.hero-image-wrap\s*\{[^}]*aspect-ratio:\s*1\.78/s)
  assert.match(loginSource, /@media \(max-width:\s*560px\)[\s\S]*?\.hero-image-wrap\s*\{\s*aspect-ratio:\s*1\.78;/)
  assert.match(loginSource, /@keyframes hero-image-breathe[\s\S]*?to\s*\{[^}]*translate3d\(-0\.35%, -0\.45%, 0\)/)
  assert.match(loginSource, /const loginImageUrl = '\/images\/landing-night-room-v1\.webp'/)
  assert.match(loginSource, /characterAssetBoardUrl = '\/images\/landing-character-board-linzixia-v1\.jpg'/)
  assert.match(loginSource, /src: '\/images\/workflow-storyboard-frame\.webp', label: '分镜脚本'/)
  assert.match(loginSource, /src: '\/images\/workflow-film-frame\.webp', label: '成片镜头'/)
  assert.doesNotMatch(loginSource, /heroImageUrl = '\/images\/brand-hero-generated-v1\.png'/)
})

test('landing images use compact responsive assets and keep the hero ahead of below-fold media', () => {
  assert.match(loginSource, /heroImageUrl = '\/images\/login-hero-clean\.webp'/)
  assert.match(loginSource, /class="hero-image"[^>]*fetchpriority="high"[^>]*decoding="async"[^>]*width="1600"[^>]*height="900"/)

  const featureImages = loginSource.match(/<img class="feature-image"[^>]*>/g) ?? []
  assert.equal(featureImages.length, 4)
  for (const image of featureImages) {
    assert.match(image, /\.webp"/)
    assert.match(image, /width="1200" height="674"/)
    assert.match(image, /loading="lazy" decoding="async"/)
  }

  assert.match(loginSource, /workflow-storyboard-frame\.webp/)
  assert.match(loginSource, /workflow-film-frame\.webp/)
  assert.match(loginSource, /:src="currentWorkflowFrame\.src"[^>]*loading="lazy"[^>]*decoding="async"/)
  assert.match(loginSource, /<img :src="frame\.src" alt="" loading="lazy" decoding="async" \/>/)
})

test('the landing page uses a dark, light, dark visual rhythm without changing the hero stage', () => {
  const pageBackgroundRules = loginSource.split('.login-page {').slice(1).map((block) => block.slice(0, block.indexOf('}'))).filter((rule) => rule.includes('background:'))
  assert.equal(pageBackgroundRules.length, 2)
  assert.ok(pageBackgroundRules.every((rule) => /background:\s*#0a0e0d\b/.test(rule)))
  assert.match(loginSource, /\.portal-hero\s*\{[^}]*min-height:\s*calc\(100svh - 4\.75rem\)/s)
  assert.match(loginSource, /\.portal-hero\s*\{[^}]*background:\s*transparent;/s)
  assert.match(loginSource, /\.portal-hero::after\s*\{[^}]*feTurbulence/s)
  assert.match(loginSource, /\.portal-hero::before\s*\{[^}]*radial-gradient\(ellipse at 68% 46%/s)
  assert.match(loginSource, /\.workflow\s*\{[^}]*#f5f2ec/s)
  assert.match(loginSource, /\.portal-close\s*\{[^}]*#121a17/s)
  assert.match(loginSource, /@media \(max-width:\s*820px\)[\s\S]*?\.portal-hero\s*\{[^}]*min-height:\s*calc\(100svh - 4rem\)/s)
  assert.match(loginSource, /\.portal-nav\s*\{[^}]*color:\s*#f0ede5/s)
})

test('the hero background adds restrained stage light and film grain without duplicating the hero image', () => {
  assert.match(loginSource, /radial-gradient\(ellipse at center, #141c1a 0%, #080c0b 72%\)/)
  assert.match(loginSource, /rgba\(84, 132, 158, 0\.06\)/)
  assert.match(loginSource, /rgba\(200, 90, 53, 0\.04\)/)
  assert.match(loginSource, /\.portal-hero::after\s*\{[^}]*opacity:\s*0\.03/s)
  assert.match(loginSource, /\.hero-copy\s*\{[^}]*z-index:\s*1/s)
})

test('the production stage presents the source artwork as framed images on a warm paper surface', () => {
  assert.match(loginSource, /class="stage-reflection"[\s\S]*?aria-hidden="true"/)
  assert.match(loginSource, /\.workflow\s*\{[^}]*#f5f2ec/s)
  assert.match(loginSource, /\.workflow::after\s*\{[^}]*feTurbulence/s)
  assert.match(loginSource, /\.stage-frame > img:not\(\.stage-frame__character-board\)\s*\{[^}]*mask-image:\s*radial-gradient\(ellipse 78% 84%/s)
  assert.match(loginSource, /\.stage-reflection\s*\{[^}]*transform:\s*scaleY\(-1\)/s)
  assert.match(loginSource, /\.stage-reflection\s*\{[^}]*mask-image:\s*linear-gradient/s)
  assert.match(loginSource, /\.stage-frame\s*\{[^}]*border:\s*1px solid rgba\(74, 61, 43, 0\.18\)/s)
  assert.match(loginSource, /\.stage-frame > img\.stage-frame__character-board\s*\{[^}]*mix-blend-mode:\s*multiply/s)
  assert.match(loginSource, /\.storyboard-strip figure\s*\{[^}]*border:\s*1px solid rgba\(74, 61, 43, 0\.14\)/s)
  assert.match(loginSource, /D-CINEMA|STUDIO/)
  assert.match(loginSource, /v-if="activeStage !== 0" class="stage-cinema-specs"/)
  assert.match(loginSource, /\.journey-step h3\s*\{[^}]*#202725/s)
})

test('the hero carries the shared film language without losing readable accessible controls', () => {
  assert.match(loginSource, /class="hero-image-grain visual-grain"/)
  assert.match(loginSource, /class="hero-hud hero-hud--right"[^>]*><span>FD<\/span><b>·<\/b><span>REEL 01<\/span>/)
  assert.match(loginSource, /REC/)
  assert.match(loginSource, /class="hero-timecode"/)
  assert.match(loginSource, /class="hero-image-label"[^>]*><span class="hero-image-label__rule"[^>]*><\/span>/)
  assert.match(loginSource, /class="hero-image-label__note"/)
  assert.match(loginSource, /— AI 漫剧制片系统/)
  assert.match(loginSource, /\.hero-image\s*\{[^}]*animation:\s*hero-image-breathe 20s/s)
  assert.match(loginSource, /\.hero-image\s*\{[^}]*filter:\s*saturate\(0\.85\) contrast\(1\.1\) hue-rotate\(-10deg\) brightness\(0\.88\)/s)
  assert.match(loginSource, /\.hero-image-wrap\s*\{[^}]*box-shadow:\s*0 30px 80px rgba\(0, 0, 0, 0\.5\)/s)
  assert.match(loginSource, /\.hero-image-wrap\s*\{[^}]*mask-image:\s*linear-gradient\(90deg, transparent 0, #000 100px\)/s)
  assert.match(loginSource, /\.hero-copy \.hero-kicker\s*\{[^}]*margin:\s*0 0 1rem/s)
  assert.match(loginSource, /\.hero-copy h1\s*\{[^}]*line-height:\s*1\.03/s)
  assert.match(loginSource, /\.portal-link::after\s*\{[^}]*transform-origin:\s*left center/s)
  assert.doesNotMatch(loginSource, /\.portal-link::after\s*\{\s*content:\s*none;/)
  assert.match(loginSource, /\.portal-nav \.nav-action\s*\{[^}]*border:\s*1px solid rgba\(240, 237, 229, 0\.46\);[^}]*background:\s*transparent/s)
  assert.match(loginSource, /\.hero-cta\s*\{[^}]*background:\s*#1a1f1e/s)
  assert.match(loginSource, /\.hero-cta:hover, \.hero-cta:focus-visible\s*\{[^}]*background:\s*#252d2b/s)
  assert.match(loginSource, /\.hero-cta::before\s*\{/)
  assert.match(loginSource, /\.portal-nav\s*\{[^}]*backdrop-filter:\s*blur\(16px\)/s)
  assert.match(loginSource, /\.hero-caption\s*\{[^}]*writing-mode:\s*vertical-rl/s)
  assert.match(loginSource, /prefers-reduced-motion:\s*reduce/)
})

test('the hero caption stays inside the cinematic frame across tablet and mobile', () => {
  assert.match(loginSource, /alt="漫剧氛围演示画面：夜间工业走廊中，一名戴头灯的女性拿着对讲机观察前方"/)
  assert.match(loginSource, /\.hero-caption\s*\{[^}]*right:\s*0\.8rem;\s*bottom:\s*3rem/s)
  assert.match(loginSource, /\.hero-caption\s*\{[^}]*right:\s*0\.6rem;\s*bottom:\s*2\.8rem/s)
})

test('the hero keeps its signature inside the image and offers a clear scroll affordance', () => {
  assert.match(loginSource, /class="hero-image-wrap"[\s\S]*?class="hero-caption"/)
  assert.match(loginSource, /class="hero-scroll" href="#workflow" aria-label="滚动查看制作流程"/)
  assert.match(loginSource, /<span class="hero-scroll__line" aria-hidden="true"><\/span>/)
  assert.match(loginSource, /<span class="hero-scroll__label" aria-hidden="true">SCROLL<\/span>/)
  assert.match(loginSource, /\.hero-caption\s*\{[^}]*right:\s*1rem;[^}]*bottom:\s*3\.3rem/s)
  assert.match(loginSource, /\.hero-scroll\s*\{[^}]*bottom:\s*0\.65rem;[^}]*left:\s*50%/s)
  assert.match(loginSource, /@media \(max-width:\s*560px\)[\s\S]*?\.hero-scroll\s*\{[^}]*position:\s*static/s)
})

test('the hero uses slow restrained motion and typography contrast for the cinematic direction', () => {
  assert.match(loginSource, /@keyframes hero-image-breathe\s*\{\s*from\s*\{[^}]*scale\(1\)/)
  assert.match(loginSource, /to\s*\{[^}]*scale\(1\.05\)/)
  assert.match(loginSource, /\.hero-copy\s*\{[^}]*animation:\s*reveal-up 800ms/s)
  assert.match(loginSource, /\.hero-copy h1\s*\{[^}]*font-weight:\s*700/s)
  assert.match(loginSource, /\.hero-description\s*\{[^}]*letter-spacing:\s*0\.02em/s)
  assert.match(loginSource, /\.hero-cta:hover::before[\s\S]*?animation:\s*cta-sheen 700ms/)
  assert.match(loginSource, /prefers-reduced-motion:\s*reduce/)
})

test('the cinematic finish keeps image depth, film grain, restrained motion, and projection details', () => {
  assert.match(loginSource, /\.hero-image-wrap\s*\{[^}]*box-shadow:\s*0 30px 80px rgba\(0, 0, 0, 0\.5\)/s)
  assert.match(loginSource, /\.hero-image-wrap::after\s*\{[^}]*linear-gradient\(90deg, rgba\(78, 139, 165, 0\.2\)/s)
  assert.match(loginSource, /\.portal-hero::after\s*\{[^}]*opacity:\s*0\.03/s)
  assert.match(loginSource, /\.portal-close::after\s*\{[^}]*opacity:\s*0\.035/s)
  assert.match(loginSource, /\.feature-card:hover \.feature-image\s*\{[^}]*transform:\s*scale\(1\.02\)/s)
  assert.match(loginSource, /\.portal-nav--light \.nav-action\s*\{[^}]*background:\s*transparent/s)
  assert.match(loginSource, /<p class="close-specs">24 FPS · 9:16 · D-CINEMA<\/p>/)
  assert.match(loginSource, /\.close-specs\s*\{[^}]*JetBrains Mono/s)
  assert.match(loginSource, /prefers-reduced-motion:\s*reduce[\s\S]*?\.feature-image/)
})

test('the production journey uses distinct artwork and its active frame follows the current stage', () => {
  assert.match(loginSource, /const workflowFrames\s*=\s*\[/)
  assert.match(loginSource, /:src="currentWorkflowFrame\.src"/)
  assert.match(loginSource, /v-for="\(frame, index\) in workflowFrames"[\s\S]*?:src="frame\.src"/)
  const framesBlock = loginSource.match(/const workflowFrames\s*=\s*\[([\s\S]*?)\n\]/)?.[1] ?? ''
  const frameSources = [...framesBlock.matchAll(/src:\s*([^,\n]+)/g)].map((match) => match[1].trim())
  assert.equal(frameSources.length, 3)
  assert.equal(new Set(frameSources).size, frameSources.length)
})

test('the hero presents production capabilities before the workflow section', () => {
  assert.match(loginSource, /<section id="top" class="portal-hero"[\s\S]*?<div class="hero-feature-rail" aria-labelledby="feature-title">/)
  assert.match(loginSource, /<h2 id="feature-title">功能亮点<\/h2>/)
  assert.match(loginSource, /class="feature-card feature-card--blueprint"[\s\S]*?故事蓝图[\s\S]*?题材、设定与分集结构逐步成形/)
  assert.match(loginSource, /class="feature-card feature-card--assets"[\s\S]*?项目资产[\s\S]*?角色、场景与道具/)
  assert.match(loginSource, /class="feature-card feature-card--storyboard"[\s\S]*?镜头分镜[\s\S]*?景别、表演节拍与时长/)
  assert.match(loginSource, /class="feature-card feature-card--delivery"[\s\S]*?声画交付[\s\S]*?对白与环境音/)
  assert.equal((loginSource.match(/class="feature-card feature-card--/g) ?? []).length, 4)
  const featureImages = [...loginSource.matchAll(/class="feature-image" src="([^"]+)" alt="([^"]+)"/g)]
  assert.equal(featureImages.length, 4)
  assert.equal(new Set(featureImages.map(([, src]) => src)).size, 4)
  assert.ok(featureImages.every(([, , alt]) => alt.length > 12))
  assert.match(loginSource, /feature-card--blueprint[\s\S]*?shot-landing-feature-story-v1/)
  assert.match(loginSource, /feature-card--assets[\s\S]*?shot-landing-feature-assets-v2/)
  assert.match(loginSource, /feature-card--storyboard[\s\S]*?shot-landing-feature-storyboard-v2/)
  assert.match(loginSource, /feature-card--delivery[\s\S]*?shot-landing-feature-delivery-v1/)
  assert.match(loginSource, /\.hero-feature-rail\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s)
  assert.match(loginSource, /\.hero-feature-grid\s*\{[^}]*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s)
  assert.match(loginSource, /<\/section>\s*<section id="workflow" class="workflow"/)
  assert.doesNotMatch(loginSource, /class="feature-showcase|\.feature-showcase|\.feature-grid/)
  assert.doesNotMatch(loginSource, /class="feature-art|blueprint-flow|asset-art-shelf|shot-art-frames|delivery-timeline/)
  assert.match(loginSource, /\.feature-heading\s*\{[^}]*justify-content:\s*center/s)
  assert.match(loginSource, /\.feature-card\s*\{[^}]*grid-template-rows:\s*auto 1fr/s)
  assert.match(loginSource, /\.feature-image\s*\{[^}]*aspect-ratio:\s*1\.8/s)
  assert.match(loginSource, /@media \(max-width:\s*560px\)[\s\S]*?\.feature-image\s*\{[^}]*aspect-ratio:\s*1\.45/s)
  assert.match(loginSource, /@media \(max-width:\s*560px\)[\s\S]*?\.hero-feature-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s)
})

test('the landing navigation follows the dark-light-dark story sections', () => {
  assert.match(loginSource, /class="portal-nav" :class="\{ 'portal-nav--light': navOnLightSection \}"/)
  assert.match(loginSource, /const navOnLightSection = ref\(false\)/)
  assert.match(loginSource, /pageScrollContainer = document\.querySelector<HTMLElement>\('#app'\)/)
  assert.match(loginSource, /workflow\.getBoundingClientRect\(\)\.top <= navBottom[\s\S]*?close\.getBoundingClientRect\(\)\.top > navBottom/)
  assert.match(loginSource, /\.portal-nav--light\s*\{[^}]*background:\s*rgba\(245, 242, 236, 0\.9\)/s)
  assert.match(loginSource, /\.workflow\s*\{[^}]*linear-gradient\(180deg, #080c0b 0, #f5f2ec 5rem/s)
  assert.match(loginSource, /\.stage-frame > img\.stage-frame__character-board\s*\{[^}]*drop-shadow\(0 10px 30px rgba\(0, 0, 0, 0\.08\)\)/s)
  assert.match(loginSource, /\.stage-marker\s*\{[^}]*background:\s*transparent;[^}]*JetBrains Mono/s)
  assert.match(loginSource, /<h2 id="close-title" data-scroll-reveal="title">从故事开始，<br \/>把这一集做出来。<\/h2>/)
})

test('section titles and their content reveal once as they enter view', () => {
  assert.match(loginSource, /<h2 id="workflow-title" data-scroll-reveal="title">/)
  assert.match(loginSource, /class="journey-stage"[\s\S]*?data-scroll-reveal="content"/)
  assert.match(loginSource, /class="journey-step"[^>]*data-scroll-reveal="step"/)
  assert.match(loginSource, /<h2 id="close-title" data-scroll-reveal="title">/)
  assert.match(loginSource, /new IntersectionObserver\(\(entries, observer\) => \{[\s\S]*?classList\.add\('is-scroll-revealed'\)[\s\S]*?unobserve\(entry\.target\)[\s\S]*?root: pageScrollContainer/)
  assert.match(loginSource, /function scheduleScrollRevealScan\(\): void/)
  assert.match(loginSource, /pageScrollContainer\?\.addEventListener\('scroll', scheduleScrollRevealScan, \{ passive: true \}\)/)
  assert.match(loginSource, /window\.requestAnimationFrame\(\(\) => window\.requestAnimationFrame\(/)
  assert.match(loginSource, /function scheduleRestoredScrollRevealScan\(\): void[\s\S]*?cancelAnimationFrame\(scrollRevealScanFrame\)[\s\S]*?scheduleScrollRevealScan\(\)/)
  assert.match(loginSource, /window\.addEventListener\('pageshow', scheduleRestoredScrollRevealScan\)/)
  assert.match(loginSource, /rootMargin: '-20% 0px -20% 0px', threshold: 0\.2/)
  assert.match(loginSource, /root: pageScrollContainer, rootMargin: '-38% 0px -38% 0px'/)
  assert.match(loginSource, /const revealBandTop = rootBounds\.top \+ rootBounds\.height \* 0\.2/)
  assert.match(loginSource, /const revealBandBottom = rootBounds\.bottom - rootBounds\.height \* 0\.2/)
  assert.match(loginSource, /has-scroll-reveal\s+\[data-scroll-reveal\]/)
  assert.match(loginSource, /prefers-reduced-motion:\s*reduce[\s\S]*?\[data-scroll-reveal\]/)
})

test('landing and login controls do not rely on externally hosted icon-font ligatures', () => {
  assert.doesNotMatch(loginSource, /class="material-symbols-outlined[^\"]*"[^>]*>(?:movie_filter|arrow_outward|south|close|smartphone|password|lock|visibility|visibility_off|error|arrow_forward)</)
  assert.match(loginSource, /icon-glyph--diagonal/)
})

test('the login dialog keeps a cinematic image header and clear premium form states on mobile', () => {
  assert.match(loginSource, /\.input-wrap\s*\{[^}]*border-bottom:\s*1px solid[^}]*background:\s*transparent/s)
  assert.match(loginSource, /\.submit-button:disabled\s*\{[^}]*linear-gradient\(145deg,/s)
  assert.match(loginSource, /\.submit-button:disabled\s*\{[^}]*cursor:\s*not-allowed/s)
  assert.match(loginSource, /\.modal-brand\s*\{[^}]*width:\s*3\.1rem;[^}]*height:\s*3\.1rem/s)
  assert.match(loginSource, /\.modal-brand \.brand-glyph\s*\{[^}]*font-size:\s*1\.55rem/s)
  assert.match(loginSource, /@media \(max-width:\s*560px\)[\s\S]*?\.modal-visual\s*\{[^}]*min-height:\s*13rem/s)
  assert.match(loginSource, /@media \(max-width:\s*560px\)[\s\S]*?\.modal-brand\s*\{[^}]*width:\s*2\.7rem;[^}]*height:\s*2\.7rem/s)
  assert.match(loginSource, /\.login-mode-panel\s*\{[^}]*display:\s*grid;[^}]*gap:\s*1rem/s)
  assert.match(loginSource, /@media \(max-width:\s*560px\)[\s\S]*?\.visual-hud--tr\s*\{\s*display:\s*none;/)
})

test('mobile keeps names and descriptions visible and scroll motion respects reduced motion', () => {
  assert.doesNotMatch(loginSource, /\.nav-action span:first-child\s*\{\s*display:\s*none/)
  assert.doesNotMatch(loginSource, /\.rail-item span:last-child\s*\{\s*display:\s*none/)
  assert.match(loginSource, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(loginSource, /scroll-behavior:\s*smooth/)
})

test('mobile keeps the primary workbench action without crowding the header with desktop navigation', () => {
  assert.match(loginSource, /\.portal-links\s*\{\s*display:\s*none;/)
  assert.doesNotMatch(loginSource, /\.portal-links\s*\{\s*gap:\s*0\.6rem;/)
  assert.match(loginSource, /class="nav-action"[^>]*aria-label="进入工作台，登录后继续创作"/)
})

test('the full public story remains vertically reachable instead of being clipped to the first viewport', () => {
  assert.match(loginSource, /\.login-page\s*\{[^}]*overflow-x:\s*clip;[^}]*overflow-y:\s*visible;/s)
})

test('the mobile story stage does not stay sticky over its step copy', () => {
  assert.match(loginSource, /@media \(max-width:\s*820px\)[\s\S]*?\.journey-stage\s*\{[^}]*position:\s*relative;[^}]*top:\s*auto;/)
})
