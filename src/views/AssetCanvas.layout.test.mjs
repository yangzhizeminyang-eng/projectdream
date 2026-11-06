import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./AssetCanvas.vue', import.meta.url), 'utf8')
const cardSource = await readFile(new URL('../components/canvas/AssetNodeCard.vue', import.meta.url), 'utf8')

test('asset canvas uses one grouped layout source instead of a second entity regrouping algorithm', () => {
  assert.match(source, /canvas\.value\?\.groups/)
  assert.match(source, /One source of truth/)
  assert.match(source, /TYPE_LAYOUT_ORDER/)
})

test('tidy layout places character, scene and prop sections in stable order', () => {
  assert.match(source, /character.*scene.*prop.*material/s)
  assert.match(source, /TYPE_SECTION_GAP/)
})

test('tidy layout persists every node exactly once with a stable card size', () => {
  assert.match(source, /for \(const position of autoLayoutNodes\.value\)/)
  assert.match(source, /width: NODE_DEFAULT_WIDTH/)
  assert.match(source, /height: NODE_DEFAULT_HEIGHT/)
  assert.doesNotMatch(source, /Promise\.all\(\s*autoLayoutNodes\.value\.map/)
})

test('asset cards reserve a separate media and metadata region', () => {
  assert.match(cardSource, /flex: 0 0 62%/)
  assert.match(cardSource, /\.ac-node__meta \{[\s\S]*?z-index: 2;/)
  assert.match(cardSource, /'is-prop'/)
})

test('asset group labels stay inside their own frame instead of floating over adjacent cards', () => {
  assert.match(source, /\.ac-group__label/)
  assert.match(source, /top: 10px;/)
  assert.match(source, /max-width: calc\(100% - 24px\)/)
  assert.match(source, /GROUP_HEADER_HEIGHT = 88/)
  assert.match(source, /overflow-wrap: anywhere/)
  assert.match(source, /white-space: normal/)
  assert.doesNotMatch(source, /transform: translateY\(-50%\);/)
})

test('asset group labels render above node cards and cannot cover their image region', () => {
  assert.match(source, /\.ac-group \{[\s\S]*?z-index: 3;/)
  assert.match(source, /\.ac-group \{[\s\S]*?background: transparent;/)
  assert.match(source, /\.ac-group__label \{[\s\S]*?max-height: 96px;/)
  assert.match(source, /\.ac-group__label \{[\s\S]*?overflow: hidden;/)
  assert.match(cardSource, /\.ac-node__media \{[\s\S]*?overflow: hidden;/)
  assert.match(cardSource, /\.ac-node__meta \{[\s\S]*?flex: 1 1 auto;/)
})

test('group generation validates real image records before claiming success', () => {
  assert.match(source, /generatedImageCount/)
  assert.match(source, /当前记录 \$\{currentImageCount\} 张/)
  assert.match(source, /服务器没有返回任何可展示的图片记录/)
})

test('initial canvas load normalizes parser-created default coordinates once', () => {
  assert.match(source, /shouldNormalizeInitialLayout/)
  assert.match(source, /await autoArrangeCanvas\(\)/)
  assert.match(source, /hasDefaultCascade/)
})
