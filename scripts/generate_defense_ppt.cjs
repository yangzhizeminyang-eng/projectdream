const fs = require('fs')
const path = require('path')
const pptxgen = require('pptxgenjs')
const sharp = require('sharp')
const JSZip = require('jszip')
const SHAPES = new pptxgen().ShapeType

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, '项目开发文档')
const outFile = path.join(outDir, 'ProjectDream_项目答辩PPT.pptx')

const img = (...parts) => path.join(root, '项目开发文档', '截图', ...parts)

const P = {
  bg: '0D0F0D',
  surface: '121412',
  panel: '171816',
  panel2: '1B1C1A',
  border: '554336',
  border2: '8D6F4A',
  accent: 'D97706',
  accent2: 'FFB77D',
  text: 'F4EDE5',
  muted: 'C7B39A',
  faint: 'A38C7C',
  green: '86EFAC',
  red: 'FCA5A5',
  white: 'FFFFFF',
  black: '000000',
}

const W = 13.333
const H = 7.5
const fontHead = 'Microsoft YaHei'
const fontBody = 'Microsoft YaHei'
const fontMono = 'Courier New'

function shadow() {
  return { type: 'outer', color: '000000', opacity: 0.28, blur: 1, angle: 45, distance: 2 }
}

function addBg(slide, dark = true) {
  slide.background = { color: dark ? P.bg : P.surface }
  slide.addShape(SHAPES.rect, {
    x: 0,
    y: 0,
    w: W,
    h: H,
    fill: { color: dark ? P.bg : P.surface },
    line: { color: dark ? P.bg : P.surface },
  })
  slide.addShape(SHAPES.arc, {
    x: 10.8,
    y: -0.4,
    w: 2.4,
    h: 2.4,
    adjustPoint: 0.18,
    line: { color: P.border, transparency: 28, width: 1 },
    rotate: 35,
  })
  slide.addShape(SHAPES.arc, {
    x: -0.8,
    y: 5.8,
    w: 2.2,
    h: 2.2,
    adjustPoint: 0.18,
    line: { color: P.border, transparency: 30, width: 1 },
    rotate: 20,
  })
}

function addFooter(slide, n, label = 'ProjectDream 答辩汇报') {
  slide.addText(label, {
    x: 0.55,
    y: 7.06,
    w: 4.6,
    h: 0.2,
    fontFace: fontBody,
    fontSize: 7,
    color: P.faint,
    margin: 0,
  })
  slide.addText(String(n).padStart(2, '0'), {
    x: 12.08,
    y: 6.95,
    w: 0.7,
    h: 0.28,
    fontFace: fontMono,
    fontSize: 10,
    bold: true,
    color: P.accent2,
    align: 'center',
    margin: 0,
  })
}

function title(slide, text, sub) {
  slide.addText(text, {
    x: 0.65,
    y: 0.48,
    w: 8.2,
    h: 0.58,
    fontFace: fontHead,
    fontSize: 27,
    bold: true,
    color: P.text,
    margin: 0,
    fit: 'shrink',
  })
  if (sub) {
    slide.addText(sub, {
      x: 0.68,
      y: 1.13,
      w: 8,
      h: 0.25,
      fontFace: fontBody,
      fontSize: 9,
      color: P.muted,
      margin: 0,
      fit: 'shrink',
    })
  }
}

function chip(slide, text, x, y, w, color = P.accent2) {
  slide.addShape(SHAPES.roundRect, {
    x,
    y,
    w,
    h: 0.32,
    rectRadius: 0.04,
    fill: { color: P.panel },
    line: { color, transparency: 25, width: 0.8 },
  })
  slide.addText(text, {
    x: x + 0.08,
    y: y + 0.075,
    w: w - 0.16,
    h: 0.12,
    fontFace: fontBody,
    fontSize: 7,
    bold: true,
    color,
    align: 'center',
    margin: 0,
    fit: 'shrink',
  })
}

function card(slide, x, y, w, h, opts = {}) {
  slide.addShape(SHAPES.rect, {
    x,
    y,
    w,
    h,
    fill: { color: opts.fill || P.panel, transparency: opts.transparency || 0 },
    line: { color: opts.line || P.border, transparency: opts.lineTransparency || 0, width: 0.8 },
    shadow: opts.shadow ? shadow() : undefined,
  })
}

function heading(slide, text, x, y, w = 4.6) {
  slide.addText(text, {
    x,
    y,
    w,
    h: 0.3,
    fontFace: fontHead,
    fontSize: 14,
    bold: true,
    color: P.accent2,
    margin: 0,
  })
}

function paragraph(slide, lines, x, y, w, options = {}) {
  const arr = Array.isArray(lines) ? lines : [lines]
  slide.addText(
    arr.map((line, index) => ({
      text: line,
      options: {
        bullet: options.bullet || false,
        breakLine: index < arr.length - 1,
        paraSpaceAfter: options.paraSpaceAfter ?? 4,
      },
    })),
    {
      x,
      y,
      w,
      h: options.h || 1.6,
      fontFace: fontBody,
      fontSize: options.fontSize || 11,
      color: options.color || P.text,
      margin: options.margin ?? 0.04,
      breakLine: false,
      fit: 'shrink',
    },
  )
}

async function imageBox(slide, imagePath, x, y, w, h, opts = {}) {
  card(slide, x, y, w, h, { fill: opts.fill || P.black, line: opts.line || P.border2, shadow: opts.shadow !== false })
  if (!fs.existsSync(imagePath)) return
  const meta = await sharp(imagePath).metadata()
  const ratio = meta.width / meta.height
  const boxRatio = w / h
  let iw = w
  let ih = h
  let ix = x
  let iy = y
  if (ratio > boxRatio) {
    iw = w
    ih = w / ratio
    iy = y + (h - ih) / 2
  } else {
    ih = h
    iw = h * ratio
    ix = x + (w - iw) / 2
  }
  slide.addImage({ path: imagePath, x: ix, y: iy, w: iw, h: ih })
}

function stat(slide, value, label, x, y, w) {
  card(slide, x, y, w, 0.95, { fill: P.panel2, line: P.border })
  slide.addText(value, {
    x: x + 0.12,
    y: y + 0.12,
    w: w - 0.24,
    h: 0.35,
    fontFace: fontMono,
    fontSize: 21,
    bold: true,
    color: P.accent2,
    align: 'center',
    margin: 0,
  })
  slide.addText(label, {
    x: x + 0.12,
    y: y + 0.58,
    w: w - 0.24,
    h: 0.2,
    fontFace: fontBody,
    fontSize: 7.5,
    color: P.muted,
    align: 'center',
    margin: 0,
    fit: 'shrink',
  })
}

function codeBlock(slide, code, x, y, w, h, size = 8.4) {
  card(slide, x, y, w, h, { fill: '090A09', line: P.border2, shadow: true })
  slide.addText(code, {
    x: x + 0.18,
    y: y + 0.16,
    w: w - 0.36,
    h: h - 0.32,
    fontFace: fontMono,
    fontSize: size,
    color: P.text,
    margin: 0,
    breakLine: false,
    fit: 'shrink',
  })
}

function flowNode(slide, n, label, x, y, w = 1.18) {
  slide.addShape(SHAPES.roundRect, {
    x,
    y,
    w,
    h: 0.72,
    rectRadius: 0.04,
    fill: { color: P.panel2 },
    line: { color: P.border2, width: 0.8 },
  })
  slide.addText(String(n).padStart(2, '0'), {
    x: x + 0.08,
    y: y + 0.1,
    w: 0.28,
    h: 0.18,
    fontFace: fontMono,
    fontSize: 7,
    bold: true,
    color: P.accent2,
    margin: 0,
  })
  slide.addText(label, {
    x: x + 0.12,
    y: y + 0.36,
    w: w - 0.24,
    h: 0.18,
    fontFace: fontBody,
    fontSize: 8,
    bold: true,
    color: P.text,
    align: 'center',
    margin: 0,
    fit: 'shrink',
  })
}

function arrow(slide, x, y, w = 0.32) {
  slide.addShape(SHAPES.rightArrow, {
    x,
    y,
    w,
    h: 0.15,
    fill: { color: P.accent, transparency: 8 },
    line: { color: P.accent, transparency: 10 },
  })
}

async function addTransitions(pptxPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath))
  const files = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]))
  for (let i = 0; i < files.length; i += 1) {
    const file = zip.file(files[i])
    let xml = await file.async('string')
    xml = xml.replace(/<p:transition[\s\S]*?<\/p:transition>/, '')
    const transitions = ['fade', 'push', 'wipe']
    const effect = transitions[i % transitions.length]
    const body =
      effect === 'push'
        ? '<p:push dir="l"/>'
        : effect === 'wipe'
          ? '<p:wipe dir="l"/>'
          : '<p:fade/>'
    const transition = `<p:transition spd="med" advClick="1">${body}</p:transition>`
    if (xml.includes('<p:timing')) {
      xml = xml.replace('<p:timing', `${transition}<p:timing`)
    } else if (xml.includes('<p:extLst')) {
      xml = xml.replace('<p:extLst', `${transition}<p:extLst`)
    } else {
      xml = xml.replace('</p:sld>', `${transition}</p:sld>`)
    }
    zip.file(files[i], xml)
  }
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  fs.writeFileSync(pptxPath, data)
}

async function main() {
  const pptx = new pptxgen()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'ProjectDream'
  pptx.subject = 'ProjectDream 项目答辩'
  pptx.title = 'ProjectDream 项目答辩PPT'
  pptx.company = '帧心帧意'
  pptx.lang = 'zh-CN'
  pptx.theme = {
    headFontFace: fontHead,
    bodyFontFace: fontBody,
    lang: 'zh-CN',
  }
  pptx.defineLayout({ name: 'LAYOUT_WIDE', width: W, height: H })

  let n = 1

  {
    const s = pptx.addSlide()
    addBg(s)
    s.addText('帧心帧意', { x: 0.7, y: 0.55, w: 2.2, h: 0.36, fontFace: fontHead, fontSize: 15, bold: true, color: P.accent2, margin: 0 })
    s.addText('ProjectDream', { x: 0.72, y: 1.7, w: 5.6, h: 0.65, fontFace: fontMono, fontSize: 32, bold: true, color: P.text, margin: 0 })
    s.addText('AI 漫剧工作台项目答辩', { x: 0.74, y: 2.48, w: 5.5, h: 0.34, fontFace: fontHead, fontSize: 17, color: P.accent2, margin: 0 })
    paragraph(s, '从故事想法到可导出成片：总纲、剧本、角色、分镜、静帧、视频、音频、任务中心与 FFmpeg 导出闭环。', 0.76, 3.12, 5.35, { h: 0.82, fontSize: 12, color: P.muted })
    chip(s, 'Vue 3', 0.76, 4.25, 0.78)
    chip(s, 'Node.js', 1.68, 4.25, 0.9)
    chip(s, 'MySQL', 2.73, 4.25, 0.78)
    chip(s, 'FFmpeg', 3.66, 4.25, 0.9)
    chip(s, 'AI Provider', 4.72, 4.25, 1.2)
    await imageBox(s, img('混合成片落地', '05-完整成片画面.png'), 6.55, 0.76, 5.95, 5.25, { shadow: true })
    stat(s, '12+', '核心功能模块', 0.76, 5.42, 1.55)
    stat(s, '79', '自动化测试通过', 2.48, 5.42, 1.55)
    stat(s, 'MP4', '最终交付格式', 4.2, 5.42, 1.55)
    addFooter(s, n++)
    s.addNotes('开场先说明项目定位：不是单点 AI 生成，而是完整的 AI 漫剧生产工作台。')
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '目录', 'CONTENTS · 答辩内容导览')
    const rows = [
      ['01', '项目介绍', '项目背景、目标与技术栈'],
      ['02', '核心业务流程', '从故事到成片的完整链路'],
      ['03', '重点模块', '角色一致性、素材生成、任务中心、导出'],
      ['04', '精彩代码展示', '异步任务与时间线计算'],
      ['05', '问题与解决方案', '真实开发中遇到的关键问题'],
      ['06', '项目收获与演示', '能力沉淀和现场演示顺序'],
    ]
    rows.forEach((row, i) => {
      const y = 1.65 + i * 0.76
      card(s, 0.78, y, 11.8, 0.52, { fill: P.panel, line: i % 2 ? P.border : P.border2 })
      s.addText(row[0], { x: 1.05, y: y + 0.13, w: 0.55, h: 0.18, fontFace: fontMono, fontSize: 10, bold: true, color: P.accent2, margin: 0 })
      s.addText(row[1], { x: 1.78, y: y + 0.1, w: 2.3, h: 0.2, fontFace: fontHead, fontSize: 12, bold: true, color: P.text, margin: 0 })
      s.addText(row[2], { x: 4.35, y: y + 0.12, w: 6.9, h: 0.18, fontFace: fontBody, fontSize: 9.5, color: P.muted, margin: 0 })
    s.addShape(SHAPES.chevron, { x: 11.95, y: y + 0.16, w: 0.18, h: 0.18, fill: { color: P.accent }, line: { color: P.accent } })
    })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '项目介绍', '一个面向 AI 漫剧生产的项目级工作台')
    await imageBox(s, img('项目模块', '01-项目总览.png'), 7.0, 1.0, 5.7, 3.35)
    heading(s, '项目目标', 0.78, 1.22)
    paragraph(s, [
      '把“故事想法”转换为“可导出的短片成片”。',
      '将 AI 生成拆成可确认、可编辑、可回跳的生产节点。',
      '解决角色漂移、任务耗时、素材错位和导出不稳定问题。',
    ], 0.88, 1.72, 5.55, { bullet: true, h: 1.15, fontSize: 11 })
    heading(s, '技术栈', 0.78, 3.35)
    paragraph(s, [
      '前端：Vue 3 + TypeScript + Vite + Tailwind CSS',
      '后端：Node.js 原生 HTTP 服务 + MySQL 8',
      'AI：OpenAI-compatible 文本、Agnes 图片/视频、DashScope TTS',
      '媒体：FFmpeg 合成导出，本地 .codex-runtime 持久化',
    ], 0.88, 3.84, 5.85, { bullet: true, h: 1.35, fontSize: 10.3 })
    stat(s, '闭环', '故事到 MP4', 7.0, 4.7, 1.45)
    stat(s, '可追踪', '任务状态', 8.68, 4.7, 1.45)
    stat(s, '可复用', '角色资产', 10.36, 4.7, 1.45)
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '核心业务流程', '从创意输入到成片导出的主链路')
    const labels = ['项目', '总纲', '场景', '剧本', '角色库', '分镜', '静帧', '视频', '音频', '剪辑', '导出']
    labels.forEach((label, i) => {
      const x = 0.65 + (i % 6) * 2.08
      const y = i < 6 ? 1.65 : 3.35
      flowNode(s, i + 1, label, x, y, 1.22)
      if (i % 6 !== 5 && i < labels.length - 1) arrow(s, x + 1.34, y + 0.29, 0.34)
    })
    card(s, 1.0, 5.35, 11.25, 0.84, { fill: P.panel2, line: P.border2 })
    paragraph(s, '设计思路：AI 不直接产出最终结果，而是每一步先生成候选，再由用户确认主版本，最后进入时间线和导出。', 1.28, 5.62, 10.65, { h: 0.25, fontSize: 11.2, color: P.text })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '系统架构', '前端工作台 + 后端能力层 + AI/媒体服务')
    const boxes = [
      ['前端工作台', 'Vue 3 / TS / 路由 / 工作区上下文', 0.82, 1.55],
      ['后端 API', 'Node.js 原生 HTTP / 鉴权 / 业务路由', 4.55, 1.55],
      ['MySQL', '项目、角色、分镜、资产、任务、导出记录', 8.28, 1.55],
      ['AI Provider', '文本、图片、视频、TTS、口型同步', 2.72, 4.15],
      ['媒体处理', 'FFmpeg / 本地素材持久化 / Range 播放', 6.45, 4.15],
    ]
    boxes.forEach(([a, b, x, y]) => {
      card(s, x, y, 3.0, 1.1, { fill: P.panel, line: P.border2, shadow: true })
      s.addText(a, { x: x + 0.18, y: y + 0.18, w: 2.6, h: 0.22, fontFace: fontHead, fontSize: 13, bold: true, color: P.accent2, margin: 0 })
      paragraph(s, b, x + 0.18, y + 0.55, 2.55, { h: 0.28, fontSize: 8.3, color: P.muted })
    })
    const arrows = [
      [3.9, 2.0, 0.42], [7.62, 2.0, 0.42], [5.78, 3.35, 0.42],
    ]
    arrows.forEach(([x, y, w]) => arrow(s, x, y, w))
    s.addShape(SHAPES.downArrow, { x: 5.65, y: 2.65, w: 0.28, h: 0.56, fill: { color: P.accent }, line: { color: P.accent } })
    s.addShape(SHAPES.downArrow, { x: 7.82, y: 2.65, w: 0.28, h: 0.56, fill: { color: P.accent }, line: { color: P.accent } })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '重点模块一：文本生产链路', '总纲、场景拆解、单场剧本')
    await imageBox(s, img('故事总纲模块', '01-故事总纲页.png'), 0.75, 1.2, 5.75, 3.15)
    await imageBox(s, img('单场景剧本模块', '01-单场景剧本页.png'), 6.85, 1.2, 5.75, 3.15)
    const items = [
      ['总纲', '建立故事设定、三幕结构、整体风格'],
      ['场景', '把长故事拆成可生产的场次'],
      ['剧本', '形成可被分镜继续拆解的单场文本'],
    ]
    items.forEach(([a, b], i) => {
      card(s, 1.0 + i * 4.12, 5.05, 3.35, 0.78, { fill: P.panel2, line: P.border })
      s.addText(a, { x: 1.2 + i * 4.12, y: 5.21, w: 0.7, h: 0.2, fontFace: fontHead, fontSize: 12, bold: true, color: P.accent2, margin: 0 })
      paragraph(s, b, 1.88 + i * 4.12, 5.17, 2.2, { h: 0.26, fontSize: 8.2, color: P.muted })
    })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '重点模块二：角色一致性闭环', '角色库、定妆图、声线与改名同步')
    await imageBox(s, img('角色库模块', '02-角色详情页.png'), 0.76, 1.08, 5.75, 3.55)
    await imageBox(s, img('角色库模块', '03-角色详情下半区.png'), 6.9, 1.08, 5.65, 3.55)
    card(s, 0.9, 5.12, 11.45, 0.92, { fill: P.panel2, line: P.border2 })
    paragraph(s, [
      '角色不是临时文本，而是长期资产：name / gender / age_group / appearance / reference_image_url / voice_profile_key。',
      '静帧生成前先检查角色库绑定、性别年龄和定妆图，缺失时直接阻断，避免生成错误资产。',
    ], 1.14, 5.32, 10.95, { h: 0.38, fontSize: 9.5, color: P.text })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '重点模块三：分镜到多模态素材', '分镜、静帧、视频、音频逐层确认')
    await imageBox(s, img('分镜编辑模块', '05-导演关键帧模式.png'), 0.66, 1.1, 3.95, 2.35)
    await imageBox(s, img('静帧生成模块', '04-两帧模式结果页.png'), 4.78, 1.1, 3.95, 2.35)
    await imageBox(s, img('视频生成模块', '04-两帧视频生成页.png'), 8.9, 1.1, 3.75, 2.35)
    const desc = [
      ['导演关键帧', '把动作镜头拆成起始帧和结束帧，稳定图生视频输入。'],
      ['候选确认', 'AI 结果进入 image_assets/video_assets，用户确认后再回写分镜。'],
      ['音频绑定', '对白必须绑定角色和分镜，后续才能进入口型同步和导出。'],
    ]
    desc.forEach(([a, b], i) => {
      card(s, 0.9 + i * 4.12, 4.35, 3.45, 1.15, { fill: P.panel2, line: P.border })
      heading(s, a, 1.12 + i * 4.12, 4.58, 2.4)
      paragraph(s, b, 1.12 + i * 4.12, 4.95, 2.95, { h: 0.28, fontSize: 8.8, color: P.muted })
    })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '重点模块四：任务中心与成片导出', '把长耗时生成变成可追踪、可恢复、可交付')
    await imageBox(s, img('任务中心模块', '01-入口页.png'), 0.72, 1.02, 3.78, 2.55)
    await imageBox(s, img('成片编辑模块', '05-视频时间线编辑.png'), 4.78, 1.02, 3.78, 2.55)
    await imageBox(s, img('合成与导出模块', '02-导出执行与结果.png'), 8.84, 1.02, 3.78, 2.55)
    paragraph(s, [
      '任务中心：queued / running / success / failed / canceled，支持失败重试和服务重启恢复。',
      '成片编辑：确认视频、静帧兜底、音频轨开关和音量配置统一保存为草稿。',
      '导出模块：读取草稿、校验完整性、FFmpeg 合成视频/音频/字幕，输出 MP4。',
    ], 1.0, 4.15, 11.2, { bullet: true, h: 1.0, fontSize: 10.4, color: P.text })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '精彩代码一：异步生成任务', '解决图片/视频/口型同步等待过久和刷新丢失问题')
    codeBlock(s, `async function createGenerationJob({ projectId, jobType, sourceId, request }) {
  const [activeRows] = await db.execute(
    \`SELECT * FROM generation_jobs
     WHERE project_id = ? AND job_type = ? AND source_id = ?
       AND status IN ('queued', 'running')
     ORDER BY id DESC LIMIT 1\`,
    [projectId, jobType, sourceId],
  )
  if (activeRows[0]) {
    queueGenerationJob(Number(activeRows[0].id))
    return generationJobRow(activeRows[0])
  }

  const jobKey = \`\${jobType}-\${sourceId}-\${randomUUID()}\`
  await db.execute(
    \`INSERT INTO generation_jobs
       (job_key, project_id, job_type, source_id, status, progress_percent, request_json)
     VALUES (?, ?, ?, ?, 'queued', 0, ?)\`,
    [jobKey, projectId, jobType, sourceId, JSON.stringify(request || {})],
  )
}`, 0.75, 1.25, 7.25, 4.95, 7.2)
    heading(s, '代码亮点', 8.35, 1.35, 3.2)
    paragraph(s, [
      '同一来源对象已有活跃任务时复用，避免重复创建供应商任务。',
      '任务先入库再执行，页面刷新后仍可轮询。',
      '失败信息写回数据库，任务中心可展示和重试。',
    ], 8.45, 1.88, 3.95, { bullet: true, h: 1.35, fontSize: 10.4, color: P.text })
    card(s, 8.45, 4.28, 3.8, 1.05, { fill: P.panel2, line: P.border2 })
    s.addText('状态流转', { x: 8.68, y: 4.48, w: 1.0, h: 0.2, fontFace: fontHead, fontSize: 10, bold: true, color: P.accent2, margin: 0 })
    paragraph(s, 'queued -> running -> success / failed / canceled', 9.55, 4.48, 2.38, { h: 0.2, fontSize: 8.2, color: P.muted })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '精彩代码二：成片时间线', '让视频片段、对白、旁白落在正确位置')
    codeBlock(s, `export function buildMediaTimeline(clips = []) {
  const entries = []
  const byStoryboardId = new Map()
  const bySceneId = new Map()
  let cursor = 0

  for (const [index, clip] of clips.entries()) {
    if (clip?.enabled === false) continue
    const durationSeconds = Math.max(0.25, positiveNumber(clip?.durationSeconds, 4))
    const entry = {
      index,
      storyboardId: Number(clip?.storyboardId) || null,
      sceneId: Number(clip?.sceneId) || null,
      startSeconds: cursor,
      endSeconds: cursor + durationSeconds,
      durationSeconds,
    }
    entries.push(entry)
    if (entry.storyboardId) byStoryboardId.set(entry.storyboardId, entry)
    cursor = entry.endSeconds
  }
  return { entries, byStoryboardId, bySceneId, durationSeconds: cursor }
}`, 0.72, 1.15, 7.32, 5.18, 7.1)
    heading(s, '为什么重要', 8.35, 1.28, 3.2)
    paragraph(s, [
      '每个镜头都有 startSeconds / endSeconds。',
      '音频优先按 storyboardId 定位，避免旧音频从 0 秒混入片头。',
      '导出前按时间线校验素材完整性。',
      '过长对白可生成 FFmpeg atempo 链做适度压缩。',
    ], 8.45, 1.82, 3.82, { bullet: true, h: 1.85, fontSize: 10.1, color: P.text })
    await imageBox(s, img('混合成片落地', '04-音频轨与导出校验.png'), 8.48, 4.45, 3.72, 1.58, { shadow: true })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '问题与解决方案', '真实开发中最影响闭环稳定性的几个问题')
    const rows = [
      ['AI 角色字段缺失', 'SQL bind 不能接收 undefined', '入库前统一把空值转为 null 或默认值'],
      ['角色生成漂移', '图片模型容易换脸、换服装', '角色库 + 定妆图 + 生成前一致性校验'],
      ['长任务体验差', '图片/视频等待时间长，刷新后状态丢失', 'generation_jobs 持久化 + 轮询 + 任务恢复'],
      ['音频错位', '旧音频从片头混入或对白和镜头不齐', 'storyboardId 优先定位 + 严格导出规则'],
      ['导出不稳定', '远程素材过期、缺素材也可能导出', '导出前本地化素材 + 完整性校验'],
    ]
    rows.forEach((r, i) => {
      const y = 1.42 + i * 0.82
      card(s, 0.72, y, 11.9, 0.58, { fill: i % 2 ? P.panel2 : P.panel, line: P.border })
      s.addText(r[0], { x: 0.98, y: y + 0.16, w: 2.1, h: 0.18, fontFace: fontHead, fontSize: 9.5, bold: true, color: P.accent2, margin: 0, fit: 'shrink' })
      s.addText(r[1], { x: 3.35, y: y + 0.16, w: 3.55, h: 0.18, fontFace: fontBody, fontSize: 8.6, color: P.text, margin: 0, fit: 'shrink' })
      s.addText(r[2], { x: 7.2, y: y + 0.16, w: 4.82, h: 0.18, fontFace: fontBody, fontSize: 8.6, color: P.muted, margin: 0, fit: 'shrink' })
    })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '项目完成后的收获', '从“会调用 AI”到“能设计生产系统”')
    const gains = [
      ['工程闭环意识', '从输入、生成、确认、追踪到导出，每一步都要能落库和回查。'],
      ['AI 结果治理', '模型输出不稳定，需要 parser、校验、候选确认和失败重试兜底。'],
      ['媒体时间线理解', '视频、音频、字幕必须通过统一时间轴对齐。'],
      ['部署与排障能力', '本地和云端环境差异、Docker、MySQL、FFmpeg、文件持久化都要考虑。'],
    ]
    gains.forEach(([a, b], i) => {
      const x = 0.86 + (i % 2) * 5.82
      const y = 1.45 + Math.floor(i / 2) * 1.75
      card(s, x, y, 5.25, 1.22, { fill: P.panel2, line: P.border2, shadow: true })
      s.addText(`0${i + 1}`, { x: x + 0.18, y: y + 0.22, w: 0.5, h: 0.22, fontFace: fontMono, fontSize: 12, bold: true, color: P.accent2, margin: 0 })
      s.addText(a, { x: x + 0.82, y: y + 0.2, w: 3.8, h: 0.22, fontFace: fontHead, fontSize: 12, bold: true, color: P.text, margin: 0 })
      paragraph(s, b, x + 0.82, y + 0.58, 3.95, { h: 0.3, fontSize: 8.9, color: P.muted })
    })
    await imageBox(s, img('真实数据联调基线', '05-成片编辑-视频与旁白轨.png'), 1.2, 5.1, 10.95, 1.25, { shadow: true })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    title(s, '项目演示', '现场演示建议按一条主线走')
    const steps = [
      ['1', '项目总览', '进入工作台，说明项目容器和进度'],
      ['2', '角色库', '展示 AI 同步角色、定妆图和声线绑定'],
      ['3', '分镜编辑', '展示角色绑定、导演关键帧、多人对白拆分'],
      ['4', '静帧/视频/音频', '展示候选确认和任务中心状态'],
      ['5', '成片编辑', '展示镜头顺序、音频轨和校验'],
      ['6', '导出结果', '播放最终 MP4 或展示导出历史'],
    ]
    steps.forEach((r, i) => {
      const x = 0.85 + (i % 2) * 5.88
      const y = 1.35 + Math.floor(i / 2) * 1.42
      card(s, x, y, 5.35, 0.9, { fill: P.panel, line: P.border })
      s.addText(r[0], { x: x + 0.18, y: y + 0.2, w: 0.38, h: 0.2, fontFace: fontMono, fontSize: 11, bold: true, color: P.accent2, margin: 0 })
      s.addText(r[1], { x: x + 0.75, y: y + 0.18, w: 1.65, h: 0.2, fontFace: fontHead, fontSize: 10.5, bold: true, color: P.text, margin: 0 })
      paragraph(s, r[2], x + 2.2, y + 0.18, 2.85, { h: 0.28, fontSize: 8.2, color: P.muted })
    })
    card(s, 1.0, 6.0, 11.25, 0.48, { fill: P.panel2, line: P.border2 })
    paragraph(s, '备用策略：如果现场网络或模型接口不稳定，直接展示已生成截图和导出 MP4，重点讲清楚链路和工程设计。', 1.22, 6.15, 10.8, { h: 0.18, fontSize: 9.2, color: P.text })
    addFooter(s, n++)
  }

  {
    const s = pptx.addSlide()
    addBg(s)
    await imageBox(s, img('混合成片落地', '05-完整成片画面.png'), 0.75, 0.62, 5.35, 5.9, { shadow: true })
    s.addText('总结', { x: 6.65, y: 1.05, w: 2.2, h: 0.45, fontFace: fontHead, fontSize: 24, bold: true, color: P.accent2, margin: 0 })
    s.addText('ProjectDream 的价值不是“生成一次结果”，而是把 AI 内容生产变成可管理、可追踪、可交付的工程系统。', {
      x: 6.7,
      y: 1.85,
      w: 5.25,
      h: 0.85,
      fontFace: fontHead,
      fontSize: 17,
      bold: true,
      color: P.text,
      margin: 0,
      fit: 'shrink',
    })
    paragraph(s, [
      '完整跑通：故事 -> 角色 -> 分镜 -> 素材 -> 时间线 -> 导出',
      '核心难点：角色一致性、长任务调度、音频时间线、导出校验',
      '后续方向：独立 Worker、对象存储、批量生产和自动质检',
    ], 6.78, 3.05, 4.95, { bullet: true, h: 1.15, fontSize: 11, color: P.muted })
    s.addText('Q&A', { x: 6.75, y: 5.38, w: 2.0, h: 0.45, fontFace: fontMono, fontSize: 22, bold: true, color: P.accent2, margin: 0 })
    addFooter(s, n++)
  }

  await pptx.writeFile({ fileName: outFile })
  await addTransitions(outFile)
  console.log(outFile)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
