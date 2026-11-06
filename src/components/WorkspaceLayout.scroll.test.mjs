import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('workspace shell keeps a fixed dynamic viewport for its scroll container', async () => {
  const source = await readFile(new URL('./WorkspaceLayout.vue', import.meta.url), 'utf8')

  assert.match(source, /class="flex h-screen h-\[100dvh\] flex-col overflow-hidden"/)
  assert.match(source, /selfManagedScroll \? 'overflow-hidden' : 'overflow-y-auto overscroll-y-contain'/)
  assert.match(source, /class="workspace-slot flex min-h-0 flex-1 flex-col"/)
})

test('global scrollbar styling removes native arrow controls from nested scroll regions', async () => {
  const source = await readFile(new URL('../style.css', import.meta.url), 'utf8')

  assert.match(source, /\*::\-webkit\-scrollbar-button/)
  assert.match(source, /display: none;/)
  assert.match(source, /border-radius: 999px;/)
  assert.match(source, /scrollbar-color: rgba\(112, 93, 75, 0\.78\) transparent/)
})

test('AI script uses one page scroll on narrow screens and a stable workspace scroll on desktop', async () => {
  const source = await readFile(new URL('../views/AIScript.vue', import.meta.url), 'utf8')

  assert.match(source, /class="script-workspace flex min-h-0"/)
  assert.match(source, /class="script-content flex min-h-0 flex-1 flex-col/)
  assert.match(source, /script-scene-sidebar[^>]+flex w-\[320px\]/)
  assert.match(source, /overflow-y: auto/)
  assert.match(source, /overflow: visible/)
  assert.match(source, /@media \(max-width: 1023px\)[\s\S]*?height: auto/)
})

test('character workbenches keep horizontal scrolling local to filter controls', async () => {
  const librarySource = await readFile(new URL('../views/CharacterLibrary.vue', import.meta.url), 'utf8')
  const consistencySource = await readFile(new URL('../views/CharacterConsistency.vue', import.meta.url), 'utf8')

  assert.match(librarySource, /character-library-scroll[^>]+overflow-x-hidden overflow-y-auto/)
  assert.match(librarySource, /custom-scrollbar flex items-center gap-2 overflow-x-auto/)
  assert.match(consistencySource, /consistency-content[^>]+overflow-x-hidden overflow-y-auto/)
})

test('final edit separates the editing canvas from the inspector into independent desktop work surfaces', async () => {
  const source = await readFile(new URL('../views/FinalEdit.vue', import.meta.url), 'utf8')

  assert.match(source, /class="final-edit-content min-h-0 flex-1"/)
  assert.match(source, /\.final-edit-content \{[\s\S]*?display: grid;/)
  assert.match(source, /\.final-edit-scroll \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/)
  assert.match(source, /\.fe-preview-panel,\s*[\r\n]+\.fe-section \{[\s\S]*?min-width: 0;/)
  assert.match(source, /\.final-edit-inspector \{[\s\S]*?border: 1px solid rgba\(232, 162, 102, 0\.18\);/)
  assert.match(source, /\.final-edit-inspector \{[\s\S]*?border-radius: 14px;/)
  assert.match(source, /\.final-edit-inspector-scroll \{[\s\S]*?overflow-y: auto;/)
  assert.match(source, /\.final-edit-inspector-scroll \{[\s\S]*?overscroll-behavior: contain;/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.final-edit-content \{[\s\S]*?overflow: hidden;/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.final-edit-scroll \{[\s\S]*?overflow-y: auto;/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.final-edit-inspector \{[\s\S]*?height: 100%;/)
})

test('audio studio keeps the desktop detail inspector readable without waiting for the page bottom', async () => {
  const source = await readFile(new URL('../views/AudioStudio.vue', import.meta.url), 'utf8')

  assert.match(source, /\.audio-page \{[\s\S]*?flex: 0 0 auto;/)
  assert.match(source, /\.audio-page \{[\s\S]*?height: max-content;/)
  assert.match(source, /\.inspector-shell \{[\s\S]*?align-self: start;/)
  assert.match(source, /\.sticky-panel \{[\s\S]*?position: sticky;/)
  assert.match(source, /\.inspector-hero \{[\s\S]*?border: 1px solid rgba\(245, 158, 11, 0\.22\);/)
  assert.match(source, /\.inspector-quick-grid \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.inspector-shell \{[\s\S]*?position: fixed;/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.inspector-shell \{[\s\S]*?top: 80px;/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?--audio-inspector-width: clamp\(360px, 31vw, 480px\);/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.audio-page \{[\s\S]*?padding-right: calc\(var\(--audio-inspector-width\) \+ 20px\);/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.main-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.sticky-panel \{[\s\S]*?height: calc\(100dvh - 96px\);/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.sticky-panel \{[\s\S]*?overflow: hidden;/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.inspector-body \{[\s\S]*?overflow-y: auto;/)
  assert.match(source, /\.sticky-panel \{[\s\S]*?overscroll-behavior: contain;/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.placement-panel \{[\s\S]*?grid-template-columns: minmax\(0, 1\.25fr\) minmax\(92px, 0\.7fr\) auto;/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.inspector-grid \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/)
  assert.match(source, /@media \(min-width: 1280px\)[\s\S]*?\.stack-actions \{[\s\S]*?position: sticky;/)
  assert.match(source, /@media \(min-width: 1024px\) and \(max-width: 1279px\)[\s\S]*?\.main-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(320px, 360px\);/)
  assert.match(source, /@media \(max-width: 1023px\)[\s\S]*?\.sticky-panel \{[\s\S]*?max-height: none;/)
  assert.match(source, /@media \(max-width: 1023px\)[\s\S]*?\.sticky-panel \{[\s\S]*?overflow: visible;/)
})
