import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const serverSource = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')
const selectionSource = await readFile(new URL('./services/episode-export-selection.mjs', import.meta.url), 'utf8')
const draftSource = await readFile(new URL('./services/final-edit-draft.mjs', import.meta.url), 'utf8')
const episodePolicySource = await readFile(new URL('./services/episode-export-policy.mjs', import.meta.url), 'utf8')

test('episode export validates and persists an explicit episode scope', () => {
  assert.match(serverSource, /episodeRequest = normalizeEpisodeExportRequest\(body\)/)
  assert.match(serverSource, /buildExportPackage\(projectId, episodeRequest\)/)
  assert.match(serverSource, /buildProjectFinalEdit\(project, \{ episodeNo: episodeRequest\.episodeNo \}\)/)
  assert.match(serverSource, /\.\.\.\(episodeRequest\.episodeNo \? \{ episodeNo: episodeRequest\.episodeNo \} : \{\}\)/)
})

test('episode render selects only manifest shots from the requested episode', () => {
  assert.match(serverSource, /normalizeEpisodeExportRequest\(\{ episodeNo: config\.episodeNo \}\)/)
  assert.match(serverSource, /storyboardIds: requestedEpisode \? finalEditPayload\.summary\.storyboardIds : undefined/)
  assert.match(serverSource, /selectedClips = selectExportClips\(/)
  assert.match(selectionSource, /const manifestIds = Array\.isArray\(storyboardIds\)/)
})

test('episode final export keeps its audio mix but never renders or uploads an automatic subtitle sidecar', () => {
  assert.match(serverSource, /const generateSubtitleSidecar = config\.generateSubtitleSidecar !== false/)
  assert.match(serverSource, /rendered\.subtitlePath\s*\?\s*objectStorage\.putObject/)
  assert.match(serverSource, /subtitleStorageKey: storedSubtitles\?\.key \|\| null/)
  assert.match(episodePolicySource, /includeAudioTracks: true/)
  assert.match(serverSource, /buildCinematicAudioFilter\(\{ clips: timelineClips \}\)/)
})

test('episode final-edit routes scope reads and preserve per-episode draft snapshots', () => {
  assert.match(serverSource, /buildProjectFinalEdit\(project, \{ episodeNo \}\)/)
  assert.match(serverSource, /selectFinalEditDraftForEpisode\(draftRow\?\.draft_json, scopedEpisodeNo\)/)
  assert.match(serverSource, /saveFinalEditDraftForEpisode\([\s\S]+normalizedDraft/)
})

test('episode final-edit reload keeps the saved source, trims, and transition override', () => {
  assert.match(draftSource, /videoAssetId: positiveId\(item\?\.videoAssetId\) \|\| null/)
  assert.match(draftSource, /const trim = normalizeTrim\(item, sourceDurationSeconds\)/)
  assert.match(draftSource, /transition: normalizeTransition\(draftItem\?\.transition\)/)
  assert.match(draftSource, /transition\.manual === true \? \{ manual: true \} : \{\}/)
})

test('episode final-edit reload uses the shared non-destructive timeline applicator', () => {
  assert.match(serverSource, /const timelineVideoItems = applyFinalEditDraftToVideoItems\(videoItems, normalizedDraft\)/)
  assert.match(serverSource, /Object\.assign\(audioTracks, applyFinalEditDraftToAudioTracks\(audioTracks, normalizedDraft\)\)/)
  assert.match(serverSource, /clipId: item\.clipId \|\| null/)
  assert.match(serverSource, /overlayClips: normalizedDraft\.overlayClips/)
})
