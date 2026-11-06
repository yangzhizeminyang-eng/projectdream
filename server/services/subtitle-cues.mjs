import { extractSpokenDialogue } from './audio-dialogue.mjs'

function positiveNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function normalizeCueText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 280)
}

function stripSubtitleSpeakerLabel(value) {
  return normalizeCueText(value)
    .replace(/^[^：:\n]{1,40}?\s*(?:[（(][^）)\n]{0,80}[）)])?\s*[：:]\s*/, '')
    .trim()
}

function normalizeSpeakerName(value) {
  return String(value || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

function parseDialogueSegments(value) {
  const source = String(value || '').replace(/\r\n?/g, '\n').trim()
  if (!source) return []

  const pattern =
    /(^|\n|[。！？!?…；;]\s*)([^：:\n。！？!?…；;]{1,40}?)(\s*[（(][^）)\n]{0,80}[）)])?\s*[：:]\s*/g
  const labels = []
  let match
  while ((match = pattern.exec(source)) !== null) {
    const labelStart = match.index + match[1].length
    labels.push({
      labelStart,
      label: `${match[2]}${match[3] || ''}`.trim(),
      speakerName: normalizeSpeakerName(match[2]),
      contentStart: pattern.lastIndex,
    })
  }

  if (!labels.length) return [{ label: '', speakerName: '', text: normalizeCueText(source) }]

  return labels
    .map((label, index) => ({
      label: label.label,
      speakerName: label.speakerName,
      text: normalizeCueText(
        source.slice(label.contentStart, labels[index + 1]?.labelStart ?? source.length),
      ),
    }))
    .filter((segment) => segment.text)
}

function formatDialogueSegment(segment) {
  const text = normalizeCueText(segment?.text)
  if (!text) return ''
  const label = String(segment?.label || '').trim()
  return label ? `${label}：${text}` : text
}

function formatSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000))
  const hours = Math.floor(totalMs / 3600000)
  const minutes = Math.floor((totalMs % 3600000) / 60000)
  const secs = Math.floor((totalMs % 60000) / 1000)
  const millis = totalMs % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`
}

export function buildSubtitleForceStyle() {
  // libass uses a legacy script coordinate system for SRT. Keep the values
  // inside that coordinate system so subtitles remain visible on 9:16 output.
  return 'FontName=Microsoft YaHei UI,FontSize=64,Bold=1,Outline=5,BorderStyle=1,Shadow=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,ShadowColour=&H80000000,Alignment=2,MarginL=72,MarginR=72,MarginV=300,WrapStyle=2,PlayResX=1080,PlayResY=1920'
}

export function buildDefaultSubtitleCues(clips = []) {
  return clips.flatMap((clip) => {
    if (clip?.enabled === false) return []
    const storyboardId = Number(clip?.storyboardId) || 0
    const text = normalizeCueText(extractSpokenDialogue(String(clip?.dialogueText || '')))
    if (!storyboardId || !text || /(?:无对白|无台词|no\s+dialogue)/i.test(text)) return []

    return [{
      cueId: `sb-${storyboardId}-1`,
      storyboardId,
      enabled: true,
      startOffsetSeconds: 0,
      durationSeconds: Math.max(0.25, positiveNumber(clip?.durationSeconds, 4)),
      text,
    }]
  })
}

export function buildSubtitleCuesFromAudioTracks(clips = [], audioTracks = {}) {
  const clipByStoryboardId = new Map(
    clips
      .filter((clip) => clip?.enabled !== false && Number(clip?.storyboardId))
      .map((clip) => [Number(clip.storyboardId), clip]),
  )
  const usedSegmentsByStoryboardId = new Map()
  const speechItems = ['dialogue', 'narration'].flatMap((trackType) =>
    (Array.isArray(audioTracks?.[trackType]) ? audioTracks[trackType] : []).map((item) => ({
      ...item,
      trackType,
    })),
  )
  const cues = []

  for (const item of speechItems.sort((left, right) => {
    const offsetDifference =
      nonNegativeNumber(left.startOffsetSeconds, 0) -
      nonNegativeNumber(right.startOffsetSeconds, 0)
    return offsetDifference || Number(left.id || 0) - Number(right.id || 0)
  })) {
    const storyboardId = Number(item?.storyboardId) || 0
    const clip = clipByStoryboardId.get(storyboardId)
    if (!storyboardId || !clip) continue

    const segments = parseDialogueSegments(clip.dialogueText)
    const usedIndexes = usedSegmentsByStoryboardId.get(storyboardId) || new Set()
    const requestedSpeaker = normalizeSpeakerName(item.characterName)
    let segmentIndex = segments.findIndex(
      (segment, index) =>
        !usedIndexes.has(index) &&
        requestedSpeaker &&
        segment.speakerName === requestedSpeaker,
    )
    if (segmentIndex < 0) {
      segmentIndex = segments.findIndex((_, index) => !usedIndexes.has(index))
    }
    const segment = segmentIndex >= 0 ? segments[segmentIndex] : null
    if (segment) usedIndexes.add(segmentIndex)
    usedSegmentsByStoryboardId.set(storyboardId, usedIndexes)

    const text =
      formatDialogueSegment(segment) ||
      normalizeCueText(
        extractSpokenDialogue(String(clip.dialogueText || ''), item.characterName),
      )
    if (!text) continue

    cues.push({
      cueId: `audio-${Number(item.id) || `${storyboardId}-${cues.length + 1}`}`,
      storyboardId,
      enabled: true,
      startOffsetSeconds: Number(nonNegativeNumber(item.startOffsetSeconds, 0).toFixed(3)),
      durationSeconds: Number(
        Math.max(0.25, positiveNumber(item.durationSeconds, clip.durationSeconds || 4)).toFixed(3),
      ),
      text,
    })
  }

  return cues.length ? cues : buildDefaultSubtitleCues(clips)
}

export function normalizeSubtitleCues(rawCues, clips = []) {
  const clipByStoryboardId = new Map(
    clips
      .filter((clip) => clip?.enabled !== false && Number(clip?.storyboardId))
      .map((clip) => [Number(clip.storyboardId), clip]),
  )
  const seenCueIds = new Set()
  const cues = []

  for (const [index, rawCue] of (Array.isArray(rawCues) ? rawCues : []).entries()) {
    const storyboardId = Number(rawCue?.storyboardId) || 0
    const clip = clipByStoryboardId.get(storyboardId)
    if (!clip) continue

    const cueId = String(rawCue?.cueId || `sb-${storyboardId}-${index + 1}`)
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 64)
    if (!cueId || seenCueIds.has(cueId)) continue
    seenCueIds.add(cueId)

    const clipDuration = Math.max(0.25, positiveNumber(clip.durationSeconds, 4))
    const startOffsetSeconds = Math.min(
      nonNegativeNumber(rawCue?.startOffsetSeconds, 0),
      Math.max(0, clipDuration - 0.25),
    )
    const durationSeconds = Math.min(
      Math.max(0.25, positiveNumber(rawCue?.durationSeconds, clipDuration)),
      Math.max(0.25, clipDuration - startOffsetSeconds),
    )
    const text = normalizeCueText(rawCue?.text)

    cues.push({
      cueId,
      storyboardId,
      enabled: rawCue?.enabled !== false,
      startOffsetSeconds: Number(startOffsetSeconds.toFixed(3)),
      durationSeconds: Number(durationSeconds.toFixed(3)),
      text,
    })
  }

  return cues
}

export function shiftDialogueSubtitleCues(
  cues = [],
  dialogueAudioItems = [],
  offsetSeconds = 0,
) {
  const offset = Number(offsetSeconds)
  if (!Number.isFinite(offset) || offset === 0) return cues

  const dialogueCueIds = new Set(
    (Array.isArray(dialogueAudioItems) ? dialogueAudioItems : [])
      .map((item) => `audio-${Number(item?.id) || 0}`)
      .filter((cueId) => cueId !== 'audio-0'),
  )

  return (Array.isArray(cues) ? cues : []).map((cue) => {
    if (!dialogueCueIds.has(String(cue?.cueId || ''))) return cue
    return {
      ...cue,
      startOffsetSeconds: Number(
        Math.max(0, Number(cue.startOffsetSeconds || 0) + offset).toFixed(3),
      ),
    }
  })
}

export function buildSubtitleTextFromCues(cues = [], timeline) {
  const rows = []

  for (const cue of Array.isArray(cues) ? cues : []) {
    if (cue?.enabled === false) continue
    const entry = timeline?.byStoryboardId?.get(Number(cue?.storyboardId))
    const text = stripSubtitleSpeakerLabel(cue?.text)
    if (!entry || !text) continue

    const startSeconds = Math.min(
      entry.endSeconds - 0.25,
      entry.startSeconds + nonNegativeNumber(cue.startOffsetSeconds, 0),
    )
    const endSeconds = Math.min(
      entry.endSeconds,
      startSeconds + Math.max(0.25, positiveNumber(cue.durationSeconds, entry.durationSeconds)),
    )
    if (endSeconds <= startSeconds) continue

    rows.push(
      `${rows.length + 1}\n${formatSrtTimestamp(startSeconds)} --> ${formatSrtTimestamp(endSeconds)}\n${text}\n`,
    )
  }

  return rows.join('\n')
}
