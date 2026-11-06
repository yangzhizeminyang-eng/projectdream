import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./AudioStudio.vue', import.meta.url), 'utf8')

test('audio studio voice progress is scoped to dialogue speakers, not all project characters', () => {
  assert.match(source, /buildVoiceBindingSummary\(voiceCast\.value, storyboards\.value\)/)
  assert.match(source, /voiceBindingSummary\.speakerNames/)
  assert.match(source, /voiceBindingSummary\.total/)
  assert.match(source, /项目未出声/)
  assert.match(source, /speakerNames\.includes\(item\.character\.name\)/)
})

test('a locked custom recording is shown as ready without demanding a catalog preview', () => {
  assert.match(source, /item\.character\.referenceAudioUrl/)
  assert.match(source, /参考音频已锁定/)
  assert.doesNotMatch(source, /item\.selectedProfile \? `\$\{item\.selectedProfile\.voiceId\} · \$\{item\.selectedProfile\.modelName\}` : '需要试听确认'/)
})
