import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./StudioIdea.vue', import.meta.url), 'utf8')

test('创作页提供六种画幅比例与比例示意类', () => {
  for (const ratio of ['9:16', '16:9', '21:9', '3:4', '4:3', '1:1']) {
    assert.match(source, new RegExp(`value: '${ratio.replace(':', '\\:')}'`))
  }
  assert.match(source, /ratio-cinema/)
  assert.match(source, /ratio-poster/)
  assert.match(source, /ratio-classic/)
})

test('创作页允许 1 到 50 集的自定义集数', () => {
  assert.match(source, /min="1"/)
  assert.match(source, /max="50"/)
  assert.match(source, /readEpisodeCount[\s\S]*parsed >= 1 && parsed <= 50/)
  assert.doesNotMatch(source, /return \[1, 3, 6, 10, 12\]\.includes\(parsed\) \? parsed : null/)
})

test('风格库按真人、2D、3D 分类并使用图片资源', () => {
  assert.match(source, /const styleGroups = \['全部', '真人', '2D', '3D'\]/)
  assert.match(source, /image: '\/images\/styles\//)
  assert.match(source, /:src="option\.image"/)
  assert.doesNotMatch(source, /style-cold \{ background-image:linear-gradient/)
})

test('创作页弹层会根据视口空间自动向上展开并保留内部滚动', () => {
  assert.match(source, /updateMenuPlacement/)
  assert.match(source, /getBoundingClientRect\(\)/)
  assert.match(source, /bottomSpace < panelHeight \+ 24/)
  assert.match(source, /class=\"\{ 'is-open-up': menuPlacement === 'up' \}/)
  assert.match(source, /\.composer-menu\.is-open-up \{[\s\S]*?bottom:calc\(100% \+ \.75rem\)/)
  assert.match(source, /max-height:min\(26rem,calc\(100dvh - 3rem\)\)/)
})
