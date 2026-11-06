import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const viewSource = await readFile(new URL('./FinalEdit.vue', import.meta.url), 'utf8')
const apiSource = await readFile(new URL('../api/project.ts', import.meta.url), 'utf8')

test('final-edit does not call or expose the unimplemented audio-library API', () => {
  assert.doesNotMatch(viewSource, /audioLibrary|AudioLibrary|audio-library/)
  assert.doesNotMatch(apiSource, /audio-library|AudioLibraryAssetDTO|listAudioLibraryAssets|uploadAudioLibraryAsset|attachAudioLibraryAsset/)
})

test('removing the audio library keeps confirmed audio tracks editable', () => {
  assert.match(viewSource, /type AudioTrackKey = 'dialogue' \| 'narration' \| 'music' \| 'sfx'/)
  assert.match(viewSource, /editableAudioTracks/)
  assert.match(viewSource, /updateTrackVolume/)
})
