import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPropAssetViewPrompt,
  normalizePropAssets,
  normalizePropAsset,
  PROP_VIEW_KEYS,
} from './asset-props.mjs'

test('normalizes Agent prop output into a concrete generation prompt', () => {
  const prop = normalizePropAsset({
    name: '离职协议',
    purpose: '阻止唐宁签字',
    material: '有轻微折痕的米白色A4纸',
    details: '右下角有公司编号和装订孔',
  })
  assert.equal(prop.name, '离职协议')
  assert.match(prop.prompt, /米白色A4纸/)
  assert.match(prop.prompt, /右下角有公司编号/)
  assert.match(prop.prompt, /无人物/)
  assert.match(prop.prompt, /完整展示从最左边缘到最右边缘/)
  assert.match(prop.prompt, /安全边距/)
  assert.match(prop.prompt, /禁止微距/)
  assert.match(prop.prompt, /正面三分之四视角/)
  assert.match(prop.prompt, /占画布约60%至75%/)
  assert.match(prop.prompt, /纯白或干净中性无缝背景/)
  assert.match(prop.prompt, /不是角色立绘、场景概念图/)
  assert.match(prop.prompt, /屏幕、标签、按钮和接口不得出现可读文字/)
  assert.match(prop.prompt, /空白暗屏或无文字抽象界面/)
  assert.match(prop.prompt, /供应商水印/)
})

test('prop master image keeps plot-defining identity and visible state while remaining an isolated white-background asset', () => {
  const prop = normalizePropAsset({
    name: '唐宁的办公显示器',
    purpose: '承载她发现的异常邮件线索',
    narrativeRole: '邮件出现前后刷新状态，成为调查转折的视觉证据',
    owner: '唐宁',
    appearance: '24英寸黑色窄边框办公显示器，矩形底座，右下角有一道细划痕',
    visualState: '屏幕亮起，呈现暗色邮件客户端布局，正文保持不可读抽象纹理',
    scriptEvidence: '剧本写到唐宁刷新收件箱并发现一封新邮件；没有给出显示器品牌',
    material: '磨砂黑色塑料外壳与防眩光玻璃屏幕',
  })

  assert.match(prop.prompt, /承载她发现的异常邮件线索/u)
  assert.match(prop.prompt, /邮件出现前后刷新状态/u)
  assert.match(prop.prompt, /唐宁/u)
  assert.match(prop.prompt, /右下角有一道细划痕/u)
  assert.match(prop.prompt, /屏幕亮起，呈现暗色邮件客户端布局/u)
  assert.match(prop.prompt, /没有给出显示器品牌/u)
  assert.match(prop.prompt, /纯白或干净中性无缝背景/u)
  assert.match(prop.prompt, /不描述剧情场景和操作动作/u)
  assert.doesNotMatch(prop.prompt, /完整邮件正文/u)
})

test('deduplicates props while preserving distinct Agent assets', () => {
  const props = normalizePropAssets(['手机', { name: '手机', details: '黑色玻璃机身' }, '电脑'])
  assert.deepEqual(props.map((item) => item.name), ['手机', '电脑'])
})

test('prop view prompt is isolated and has a stable four-angle contract', () => {
  const prompt = buildPropAssetViewPrompt({ prop: { name: '咖啡杯垫' }, viewKey: 'back' })
  assert.match(prompt, /严格90度侧面|背面完整视角|背部结构/u)
  assert.match(prompt, /道具占画布约60%至75%/)
  assert.match(prompt, /禁止微距、局部特写、裁切/)
  assert.match(prompt, /屏幕、标签和按钮不得出现可读文字/)
  assert.doesNotMatch(prompt, /人物动作|对白|角色服装/u)
  assert.deepEqual(PROP_VIEW_KEYS, ['front', 'side', 'back', 'top'])
})

test('prop base skill defaults to one complete object instead of a character-like full-body sheet', () => {
  const prop = normalizePropAsset({ name: '红色发卡', details: '蝴蝶结根部有一道细斜划痕' })
  assert.match(prop.prompt, /单件(?:剧情专属)?道具基础资产/u)
  assert.doesNotMatch(prop.prompt, /从头顶到鞋底|单人站立|角色基础正面全身图/)
})
