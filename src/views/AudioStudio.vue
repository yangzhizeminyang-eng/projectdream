<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  archiveAudio,
  confirmProjectAudio,
  generateProjectAudio,
  getModelSettings,
  getProject,
  listCharacters,
  listProjectAudio,
  listProjectVoiceCast,
  listScenes,
  listStoryboards,
  listVoiceProfiles,
  updateProjectAudioPlacement,
  type AudioAssetDTO,
  type CharacterDTO,
  type CharacterVoiceCastDTO,
  type ProjectDTO,
  type SceneDTO,
  type StoryboardDTO,
  type VoiceProfileDTO,
} from '@/api/project'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'

type TrackType = 'dialogue' | 'narration' | 'music' | 'sfx'
type PageState = 'missing-project' | 'loading' | 'empty' | 'error' | 'ready'
type FilterTrackType = TrackType | 'all'
type FilterStatus = 'all' | 'candidate' | 'confirmed' | 'archived'

interface TrackOption {
  key: TrackType
  label: string
  icon: string
  accentClass: string
  hint: string
}

interface AudioGroup {
  key: string
  trackType: TrackType
  sceneId: number | null
  characterId: number | null
  title: string
  subtitle: string
  items: AudioAssetDTO[]
}

const TRACK_OPTIONS: TrackOption[] = [
  {
    key: 'dialogue',
    label: '对白轨',
    icon: 'graphic_eq',
    accentClass: 'track-dialogue',
    hint: '适合按“场景 + 角色”生成对白候选。',
  },
  {
    key: 'narration',
    label: '旁白轨',
    icon: 'record_voice_over',
    accentClass: 'track-narration',
    hint: '适合按场景生成说明性旁白。',
  },
  {
    key: 'music',
    label: '音乐轨',
    icon: 'music_note',
    accentClass: 'track-music',
    hint: '可做项目级或场景级氛围音乐候选。',
  },
  {
    key: 'sfx',
    label: '音效轨',
    icon: 'volume_up',
    accentClass: 'track-sfx',
    hint: '可做项目级或场景级音效候选。',
  },
]

const STATUS_OPTIONS: Array<{ value: FilterStatus; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'candidate', label: '候选' },
  { value: 'confirmed', label: '已确认' },
  { value: 'archived', label: '已归档' },
]

const route = useRoute()
const router = useRouter()

const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  if (fromQuery > 0) return fromQuery
  return getWorkspaceContext()?.projectId || 0
})

const requestedSceneId = computed(() => {
  const fromQuery = Number(route.query.sceneId) || 0
  if (fromQuery > 0) return fromQuery
  return getWorkspaceContext()?.sceneId || 0
})

const pageState = ref<PageState>('loading')
const project = ref<ProjectDTO | null>(null)
const scenes = ref<SceneDTO[]>([])
const storyboards = ref<StoryboardDTO[]>([])
const characters = ref<CharacterDTO[]>([])
const audioItems = ref<AudioAssetDTO[]>([])
const voiceCast = ref<CharacterVoiceCastDTO[]>([])
const voiceProfiles = ref<VoiceProfileDTO[]>([])

const generating = ref(false)
const confirmingAudioId = ref<number | null>(null)
const archivingAudioId = ref<number | null>(null)
const savingPlacement = ref(false)
const selectedAudioId = ref<number | null>(null)
const placementStoryboardId = ref<number>(0)
const placementOffsetSeconds = ref(0)

const errorMsg = ref('')
const infoMsg = ref('')

const formTrackType = ref<TrackType>('dialogue')
const formSceneId = ref<number>(requestedSceneId.value || 0)
const formStoryboardId = ref<number>(0)
const formCharacterId = ref<number>(0)
const formTitle = ref('')
const formText = ref('')
const formStartOffsetSeconds = ref(0)
const formModelName = ref('qwen3-tts-flash')
const defaultAudioModel = ref('qwen3-tts-flash')
const formVoiceProfileKey = ref('female-adult-gentle')
const MAX_AUDIO_TEXT_LENGTH = 600
const autoTextNotice = ref('')

const keyword = ref('')
const filterTrackType = ref<FilterTrackType>('all')
const filterSceneId = ref<number>(requestedSceneId.value || 0)
const filterStatus = ref<FilterStatus>('all')

const trackOrder: Record<TrackType, number> = {
  dialogue: 1,
  narration: 2,
  music: 3,
  sfx: 4,
}

const sceneMap = computed(() => new Map(scenes.value.map((item) => [item.id, item])))
const characterMap = computed(() => new Map(characters.value.map((item) => [item.id, item])))
const voiceCastMap = computed(
  () => new Map(voiceCast.value.map((item) => [item.character.id, item])),
)
const voiceProfileMap = computed(
  () => new Map(voiceProfiles.value.map((item) => [item.profileKey, item])),
)
const selectedCharacterVoiceCast = computed(() => voiceCastMap.value.get(formCharacterId.value) || null)
const selectedFormVoiceProfile = computed(() => {
  if (formTrackType.value === 'dialogue') return selectedCharacterVoiceCast.value?.selectedProfile || null
  return voiceProfileMap.value.get(formVoiceProfileKey.value) || null
})
const lockedVoiceCount = computed(() => voiceCast.value.filter((item) => item.ready).length)

const sceneOptions = computed(() => [...scenes.value].sort((a, b) => a.sceneNo - b.sceneNo))
const storyboardOptions = computed(() =>
  storyboards.value
    .filter((item) => !formSceneId.value || item.sceneId === formSceneId.value)
    .sort((a, b) => a.sortOrder - b.sortOrder),
)
const storyboardEnabled = computed(() => formTrackType.value === 'dialogue' || formTrackType.value === 'narration')
const characterOptions = computed(() =>
  [...characters.value].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
)

const totalCount = computed(() => audioItems.value.length)
const confirmedCount = computed(() => audioItems.value.filter((item) => item.status === 'confirmed').length)
const candidateCount = computed(() => audioItems.value.filter((item) => item.status === 'candidate').length)
const archivedCount = computed(() => audioItems.value.filter((item) => item.status === 'archived').length)

const currentTrackMeta = computed(
  () => TRACK_OPTIONS.find((item) => item.key === formTrackType.value) ?? TRACK_OPTIONS[0]!,
)
const characterEnabled = computed(() => formTrackType.value === 'dialogue')
const voiceEnabled = computed(
  () => formTrackType.value === 'dialogue' || formTrackType.value === 'narration',
)

const filteredItems = computed(() => {
  const keywordValue = keyword.value.trim().toLowerCase()

  return [...audioItems.value]
    .filter((item) => {
      if (filterTrackType.value !== 'all' && item.trackType !== filterTrackType.value) return false
      if (filterSceneId.value > 0 && Number(item.sceneId || 0) !== filterSceneId.value) return false
      if (filterStatus.value !== 'all' && item.status !== filterStatus.value) return false
      if (!keywordValue) return true

      const haystacks = [
        item.title,
        item.trackType,
        item.sceneTitle || '',
        item.characterName || '',
        item.voiceName || '',
        item.modelName || '',
      ]
      return haystacks.some((value) => String(value).toLowerCase().includes(keywordValue))
    })
    .sort((a, b) => {
      const trackDelta =
        trackOrder[normalizeTrackType(a.trackType)] - trackOrder[normalizeTrackType(b.trackType)]
      if (trackDelta !== 0) return trackDelta

      const sceneDelta = resolveSceneNo(a) - resolveSceneNo(b)
      if (sceneDelta !== 0) return sceneDelta

      const characterDelta = resolveCharacterName(a).localeCompare(resolveCharacterName(b), 'zh-CN')
      if (characterDelta !== 0) return characterDelta

      if (a.status === 'confirmed' && b.status !== 'confirmed') return -1
      if (a.status !== 'confirmed' && b.status === 'confirmed') return 1
      if ((b.versionNo || 0) !== (a.versionNo || 0)) return (b.versionNo || 0) - (a.versionNo || 0)
      return b.id - a.id
    })
})

const groupedItems = computed<AudioGroup[]>(() => {
  const map = new Map<string, AudioGroup>()

  for (const item of filteredItems.value) {
    const key = buildGroupKey(item.trackType, item.sceneId, item.characterId)
    const existing = map.get(key)
    if (existing) {
      existing.items.push(item)
      continue
    }

    map.set(key, {
      key,
      trackType: normalizeTrackType(item.trackType),
      sceneId: Number(item.sceneId || 0) || null,
      characterId: Number(item.characterId || 0) || null,
      title: buildGroupTitle(item),
      subtitle: buildGroupSubtitle(item),
      items: [item],
    })
  }

  return [...map.values()]
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => {
        if (a.status === 'confirmed' && b.status !== 'confirmed') return -1
        if (a.status !== 'confirmed' && b.status === 'confirmed') return 1
        if ((b.versionNo || 0) !== (a.versionNo || 0)) return (b.versionNo || 0) - (a.versionNo || 0)
        return b.id - a.id
      }),
    }))
    .sort((a, b) => {
      const trackDelta = trackOrder[a.trackType] - trackOrder[b.trackType]
      if (trackDelta !== 0) return trackDelta

      const sceneDelta = resolveSceneNoById(a.sceneId) - resolveSceneNoById(b.sceneId)
      if (sceneDelta !== 0) return sceneDelta

      return resolveCharacterNameById(a.characterId).localeCompare(
        resolveCharacterNameById(b.characterId),
        'zh-CN',
      )
    })
})

const visibleCount = computed(() => filteredItems.value.length)
const groupCount = computed(() => groupedItems.value.length)

const selectedAudio = computed<AudioAssetDTO | null>(
  () => audioItems.value.find((item) => item.id === selectedAudioId.value) || null,
)

const emptyStateTitle = computed(() => {
  if (!scenes.value.length) return '当前项目还没有场景'
  if (!totalCount.value) return '当前还没有音频候选'
  return '当前筛选条件下没有结果'
})

const emptyStateDesc = computed(() => {
  if (!scenes.value.length) return '先去场景模块完成场景拆解，再回来生成场景级音频。'
  if (!totalCount.value) return '先从左侧参数区生成一组候选音频，跑通确认与归档链路。'
  return '试试清空筛选条件，或者切换到其他轨道 / 场景查看。'
})

const generateBlockedReason = computed(() => {
  if (!projectId.value) return '缺少项目上下文'
  if (!scenes.value.length) return '当前项目还没有场景，请先完成场景模块'
  if (formTrackType.value === 'music' || formTrackType.value === 'sfx') {
    return 'qwen3-tts-flash 仅支持对白和旁白'
  }
  if (formTrackType.value === 'dialogue' && !formSceneId.value) return '对白轨需要先选择场景'
  if (formTrackType.value === 'dialogue' && !formCharacterId.value) return '对白轨需要先选择角色'
  if (formTrackType.value === 'dialogue' && !selectedCharacterVoiceCast.value?.ready) {
    return '当前角色还没有确认并锁定音色，请先完成角色音色管理'
  }
  if (formTrackType.value === 'narration' && !formSceneId.value) return '旁白轨需要先选择场景'
  if (formTrackType.value === 'narration' && !selectedFormVoiceProfile.value) return '请选择旁白音色'
  if (formStoryboardId.value && !storyboardOptions.value.some((item) => item.id === formStoryboardId.value)) {
    return '当前分镜不属于所选场景，请重新选择'
  }
  if (!formText.value.trim()) return '请输入需要朗读的文本'
  if (formText.value.trim().length > MAX_AUDIO_TEXT_LENGTH) return `朗读文本不能超过 ${MAX_AUDIO_TEXT_LENGTH} 字`
  return ''
})

function syncGenerateDefaults(options?: { forceTrackType?: boolean }): void {
  const firstSceneId = scenes.value[0]?.id || 0
  const hasCharacters = characters.value.length > 0

  if (options?.forceTrackType && formTrackType.value === 'dialogue' && !hasCharacters) {
    formTrackType.value = 'narration'
  }

  if (
    (formTrackType.value === 'dialogue' || formTrackType.value === 'narration') &&
    !formSceneId.value &&
    firstSceneId
  ) {
    formSceneId.value = firstSceneId
  }
}

function normalizeSpeechText(value?: string | null): string {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function stripOuterSpeechQuotes(value?: string | null): string {
  let text = normalizeSpeechText(value)
  const quotePairs: Array<[string, string]> = [
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
    ['"', '"'],
    ["'", "'"],
  ]

  let changed = true
  while (changed && text.length >= 2) {
    changed = false
    for (const [left, right] of quotePairs) {
      if (text.startsWith(left) && text.endsWith(right)) {
        text = text.slice(left.length, -right.length).trim()
        changed = true
      }
    }
  }
  return text
}

function normalizeSpeakerName(value?: string | null): string {
  return normalizeSpeechText(value)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .toLocaleLowerCase('zh-CN')
}

function isSameSpeaker(left?: string | null, right?: string | null): boolean {
  const speaker = normalizeSpeakerName(left)
  const character = normalizeSpeakerName(right)
  if (!speaker || !character) return false
  return speaker === character ||
    (speaker.length >= 2 && character.length >= 2 &&
      (speaker.includes(character) || character.includes(speaker)))
}

function isNoSpeechText(value?: string | null): boolean {
  const text = normalizeSpeechText(value)
  if (!text) return true
  return /^(?:[（(]?\s*(?:无对白|无台词|无旁白|无朗读|无需朗读|静默|沉默|none|no\s+dialogue|no\s+speech)\s*[）)]?)$/i.test(text)
}

function cleanSpeechLine(value?: string | null): string {
  return stripOuterSpeechQuotes(value)
    .replace(/^[：:，,、；;\s]+|[：:，,、；;\s]+$/g, '')
    .replace(/[（(]\s*(?:停顿|沉默|无声|轻声|压低声音|低声|哽咽|叹气|笑|冷笑|哭|喘息)[^）)]*[）)]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractSpokenText(dialogueText?: string | null, speakerName = ''): string {
  const source = normalizeSpeechText(dialogueText)
  if (isNoSpeechText(source)) return ''

  const blocks: Array<{ speaker: string; contentStart: number; text: string }> = []
  const speakerPattern = /(^|\n|[。！？!?…"'”’）】]\s*)([^：:\n。！？!?]{1,40}?)(?:\s*[（(][^）)\n]{0,80}[）)])?\s*[：:]\s*/g
  let currentBlock: { speaker: string; contentStart: number; text: string } | null = null
  let hasUnlabelledText = false
  let match: RegExpExecArray | null

  while ((match = speakerPattern.exec(source)) !== null) {
    const labelStart = match.index + String(match[1] || '').length
    const speaker = normalizeSpeechText(match[2] || '')
    if (!speaker) continue

    if (!currentBlock && source.slice(0, labelStart).trim()) {
      hasUnlabelledText = true
    }
    if (currentBlock) {
      currentBlock.text = source.slice(currentBlock.contentStart, labelStart)
    }
    currentBlock = { speaker, contentStart: speakerPattern.lastIndex, text: '' }
    blocks.push(currentBlock)
  }

  if (currentBlock) {
    currentBlock.text = source.slice(currentBlock.contentStart)
  }

  if (!blocks.length || hasUnlabelledText) return cleanSpeechLine(source)

  const selectedBlocks = speakerName
    ? blocks.filter((block) => isSameSpeaker(block.speaker, speakerName))
    : blocks.length === 1
      ? blocks
      : []

  if (!selectedBlocks.length) return ''

  return selectedBlocks
    .map((block) => cleanSpeechLine(block.text))
    .filter((text) => text && !isNoSpeechText(text))
    .join('\n')
    .trim()
}

function trimAudioText(value?: string | null): string {
  const text = normalizeSpeechText(value)
  if (text.length <= MAX_AUDIO_TEXT_LENGTH) return text

  const parts = text
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
  let result = ''
  for (const part of parts) {
    const next = result ? `${result}${part}` : part
    if (next.length > MAX_AUDIO_TEXT_LENGTH) break
    result = next
  }
  return result || text.slice(0, MAX_AUDIO_TEXT_LENGTH)
}

function storyboardCharacterMatches(storyboard: StoryboardDTO, characterId: number, characterName: string): boolean {
  if (!characterId && !characterName) return false
  if (characterId && Number(storyboard.characterId || 0) === characterId) return true
  return Boolean(characterName && isSameSpeaker(storyboard.characterName || '', characterName))
}

function selectedCharacterName(): string {
  return String(characterMap.value.get(formCharacterId.value)?.name || '').trim()
}

function resolveDialogueAutoText(): { text: string; storyboardId: number; notice: string } {
  const characterId = Number(formCharacterId.value || 0)
  const characterName = selectedCharacterName()
  const selected = storyboards.value.find((item) => item.id === formStoryboardId.value) || null
  const candidates = [
    ...(selected ? [selected] : []),
    ...storyboardOptions.value.filter((item) => item.id !== selected?.id),
  ]

  for (const storyboard of candidates) {
    if (
      !storyboardCharacterMatches(storyboard, characterId, characterName) &&
      !extractSpokenText(storyboard.dialogueText, characterName)
    ) {
      continue
    }
    const text = extractSpokenText(storyboard.dialogueText, characterName)
    if (!text) continue
    return {
      text: trimAudioText(text),
      storyboardId: storyboard.id,
      notice: `${storyboard.shotNo || '当前分镜'} 已读取 ${characterName || '角色'} 的对白`,
    }
  }

  return {
    text: '',
    storyboardId: selected?.id || 0,
    notice: characterName ? `没有找到 ${characterName} 的可朗读对白` : '请先选择角色',
  }
}

function extractNarrationFromText(value?: string | null): string {
  const narratorNames = ['旁白', '画外音', '解说', '旁述', 'VO', 'V.O.', 'voice over']
  for (const name of narratorNames) {
    const text = extractSpokenText(value, name)
    if (text) return text
  }
  return ''
}

function resolveNarrationAutoText(): { text: string; storyboardId: number; notice: string } {
  const scene = sceneMap.value.get(formSceneId.value)
  const selected = storyboards.value.find((item) => item.id === formStoryboardId.value) || null

  if (selected) {
    const explicitNarration = extractNarrationFromText(selected.dialogueText)
    if (explicitNarration) {
      return {
        text: trimAudioText(explicitNarration),
        storyboardId: selected.id,
        notice: `${selected.shotNo || '当前分镜'} 已读取旁白`,
      }
    }
    const actionText = cleanSpeechLine(selected.actionText)
    if (actionText) {
      return {
        text: trimAudioText(actionText),
        storyboardId: selected.id,
        notice: `${selected.shotNo || '当前分镜'} 已根据镜头动作生成旁白草稿`,
      }
    }
  }

  const explicitSceneNarration = extractNarrationFromText(scene?.content)
  if (explicitSceneNarration) {
    return {
      text: trimAudioText(explicitSceneNarration),
      storyboardId: 0,
      notice: '已从场景正文读取旁白',
    }
  }

  const fallback = cleanSpeechLine(scene?.summary || scene?.content)
  return {
    text: trimAudioText(fallback),
    storyboardId: 0,
    notice: fallback ? '已从场景摘要生成旁白草稿' : '当前场景没有可读取的旁白文本',
  }
}

function resolveAutoSpeechText(): { text: string; storyboardId: number; notice: string } {
  if (formTrackType.value === 'dialogue') return resolveDialogueAutoText()
  if (formTrackType.value === 'narration') return resolveNarrationAutoText()
  return { text: '', storyboardId: 0, notice: '当前轨道不需要朗读文本' }
}

function syncFormText(force = false): void {
  if (!force && formText.value.trim()) return
  if (formTrackType.value !== 'dialogue' && formTrackType.value !== 'narration') {
    formText.value = ''
    autoTextNotice.value = ''
    return
  }

  const resolved = resolveAutoSpeechText()
  formText.value = resolved.text
  autoTextNotice.value = resolved.notice
}

function onAutoReadText(): void {
  const resolved = resolveAutoSpeechText()
  if (resolved.storyboardId && formStoryboardId.value !== resolved.storyboardId) {
    formStoryboardId.value = resolved.storyboardId
  }
  formText.value = resolved.text
  autoTextNotice.value = resolved.notice
  if (resolved.text) {
    infoMsg.value = resolved.notice
    errorMsg.value = ''
  } else {
    errorMsg.value = resolved.notice
    infoMsg.value = ''
  }
}

function normalizeTrackType(value: string): TrackType {
  return TRACK_OPTIONS.find((item) => item.key === value)?.key || 'dialogue'
}

function syncVoiceSelection(): void {
  const profile = selectedFormVoiceProfile.value
  formModelName.value = voiceEnabled.value ? profile?.modelName || defaultAudioModel.value : ''
}

function ageGroupLabel(value?: string | null): string {
  return ({
    child: '儿童',
    teen: '少年',
    young_adult: '青年',
    middle_aged: '中年',
    senior: '老年',
  } as Record<string, string>)[String(value || '')] || '未识别'
}

function genderLabel(value?: string | null): string {
  return ({ male: '男性', female: '女性', neutral: '中性' } as Record<string, string>)[String(value || '')] || '未识别'
}

function formatDuration(seconds?: number | null): string {
  const total = Number(seconds) || 0
  if (total <= 0) return '0s'

  const mins = Math.floor(total / 60)
  const rest = total % 60
  if (mins <= 0) return `${rest}s`
  if (rest === 0) return `${mins}m`
  return `${mins}m ${rest}s`
}

function formatDateTime(value?: string | null): string {
  if (!value) return '时间未知'

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function trackLabel(trackType: string): string {
  return TRACK_OPTIONS.find((item) => item.key === trackType)?.label || trackType
}

function statusLabel(status: string): string {
  if (status === 'confirmed') return '已确认'
  if (status === 'archived') return '已归档'
  return '候选'
}

function resolveSceneNo(item: AudioAssetDTO): number {
  if (Number(item.sceneNo || 0) > 0) return Number(item.sceneNo)
  return resolveSceneNoById(item.sceneId)
}

function resolveSceneNoById(sceneId?: number | null): number {
  if (!sceneId) return 9999
  return Number(sceneMap.value.get(sceneId)?.sceneNo || 9999)
}

function resolveCharacterName(item: AudioAssetDTO): string {
  return String(item.characterName || resolveCharacterNameById(item.characterId)).trim()
}

function resolveCharacterNameById(characterId?: number | null): string {
  if (!characterId) return ''
  return String(characterMap.value.get(characterId)?.name || '').trim()
}

function sceneLabel(
  sceneId?: number | null,
  fallbackSceneNo?: number | null,
  fallbackTitle?: string | null,
): string {
  if (!sceneId) return '项目级'

  const scene = sceneMap.value.get(sceneId)
  const sceneNo = Number(scene?.sceneNo || fallbackSceneNo || 0)
  const title = String(scene?.title || fallbackTitle || '未命名场景').trim()
  if (sceneNo > 0) return `Scene ${String(sceneNo).padStart(2, '0')} · ${title}`
  return title || '未命名场景'
}

function characterLabel(characterId?: number | null, fallbackName?: string | null): string {
  if (!characterId) return '未绑定角色'
  const name = String(characterMap.value.get(characterId)?.name || fallbackName || '').trim()
  return name || '未绑定角色'
}

function buildGroupKey(
  trackType: string,
  sceneId?: number | null,
  characterId?: number | null,
): string {
  return [
    normalizeTrackType(trackType),
    Number(sceneId || 0),
    Number(characterId || 0),
  ].join(':')
}

function buildGroupTitle(item: AudioAssetDTO): string {
  const track = trackLabel(item.trackType)
  const sceneText = sceneLabel(item.sceneId, item.sceneNo, item.sceneTitle)
  const characterText = characterLabel(item.characterId, item.characterName)

  if (item.trackType === 'dialogue') return `${track} · ${characterText} · ${sceneText}`
  if (item.trackType === 'narration') return `${track} · ${sceneText}`
  if (!item.sceneId) return `${track} · 项目级`
  return `${track} · ${sceneText}`
}

function buildGroupSubtitle(item: AudioAssetDTO): string {
  const parts = [`最新版本 V${item.versionNo || 1}`]
  if (item.voiceName) parts.push(item.voiceName)
  if (item.modelName) parts.push(item.modelName)
  return parts.join(' · ')
}

function waveformBars(item: AudioAssetDTO): number[] {
  let seed =
    item.id * 17 +
    (item.versionNo || 1) * 13 +
    item.trackType.length * 29 +
    Number(item.sceneId || 0) * 7 +
    Number(item.characterId || 0) * 11

  const bars: number[] = []
  for (let i = 0; i < 28; i += 1) {
    seed = (seed * 9301 + 49297) % 233280
    const ratio = seed / 233280
    bars.push(10 + Math.round(ratio * 24))
  }
  return bars
}

function syncSelectedAudio(preferredId?: number | null): void {
  if (preferredId && filteredItems.value.some((item) => item.id === preferredId)) {
    selectedAudioId.value = preferredId
    return
  }

  if (selectedAudioId.value && filteredItems.value.some((item) => item.id === selectedAudioId.value)) {
    return
  }

  const preferredSceneConfirmed =
    requestedSceneId.value > 0
      ? filteredItems.value.find(
          (item) => item.status === 'confirmed' && Number(item.sceneId || 0) === requestedSceneId.value,
        )
      : null
  if (preferredSceneConfirmed) {
    selectedAudioId.value = preferredSceneConfirmed.id
    return
  }

  const confirmed = filteredItems.value.find((item) => item.status === 'confirmed')
  if (confirmed) {
    selectedAudioId.value = confirmed.id
    return
  }

  selectedAudioId.value = filteredItems.value[0]?.id || null
}

function syncPlacementState(item: AudioAssetDTO | null): void {
  placementStoryboardId.value = Number(item?.storyboardId || 0)
  placementOffsetSeconds.value = Math.max(0, Number(item?.startOffsetSeconds || 0))
}

async function savePlacement(): Promise<void> {
  const item = selectedAudio.value
  if (!item || savingPlacement.value) return

  savingPlacement.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const updated = await updateProjectAudioPlacement(item.id, {
      storyboardId: placementStoryboardId.value || null,
      startOffsetSeconds: Math.max(0, Number(placementOffsetSeconds.value) || 0),
    })
    audioItems.value = audioItems.value.map((audio) => (audio.id === updated.id ? updated : audio))
    syncPlacementState(updated)
    infoMsg.value = '音频时间线定位已保存，重新导出即可生效。'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '音频时间线定位保存失败'
  } finally {
    savingPlacement.value = false
  }
}

function rememberContext(): void {
  const sceneId =
    requestedSceneId.value || Number(selectedAudio.value?.sceneId || 0) || Number(formSceneId.value || 0) || undefined
  setWorkspaceContext({
    projectId: projectId.value,
    sceneId,
  })
}

function goDashboard(): void {
  router.push('/dashboard')
}

function goScenes(): void {
  if (!projectId.value) {
    router.push('/dashboard')
    return
  }

  rememberContext()
  router.push({
    path: '/workspace/scenes',
    query: { projectId: String(projectId.value) },
  })
}

function goCharacters(): void {
  if (!projectId.value) return
  rememberContext()
  router.push({
    path: '/workspace/character',
    query: { projectId: String(projectId.value) },
  })
}

function goCharacterVoice(characterId: number): void {
  if (!projectId.value || !characterId) return
  rememberContext()
  router.push({
    path: '/workspace/character/detail',
    query: { projectId: String(projectId.value), characterId: String(characterId) },
  })
}

function goScriptScene(sceneId?: number | null): void {
  if (!projectId.value) return

  const targetSceneId = Number(sceneId || requestedSceneId.value || selectedAudio.value?.sceneId || 0)
  if (!targetSceneId) {
    goScenes()
    return
  }

  setWorkspaceContext({ projectId: projectId.value, sceneId: targetSceneId })
  router.push({
    path: '/workspace/script',
    query: {
      projectId: String(projectId.value),
      sceneId: String(targetSceneId),
    },
  })
}

async function refreshAudio(preferredId?: number | null): Promise<void> {
  if (!projectId.value) return
  audioItems.value = await listProjectAudio(projectId.value)
  pageState.value = audioItems.value.length ? 'ready' : 'empty'
  syncSelectedAudio(preferredId)
}

async function loadPage(): Promise<void> {
  if (!projectId.value) {
    pageState.value = 'missing-project'
    project.value = null
    scenes.value = []
    storyboards.value = []
    characters.value = []
    audioItems.value = []
    voiceCast.value = []
    voiceProfiles.value = []
    selectedAudioId.value = null
    return
  }

  pageState.value = 'loading'
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    const [projectData, sceneItems, characterItems, audioList, voiceCastItems, voiceCatalog] = await Promise.all([
      getProject(projectId.value),
      listScenes(projectId.value),
      listCharacters(projectId.value),
      listProjectAudio(projectId.value),
      listProjectVoiceCast(projectId.value),
      listVoiceProfiles(),
    ])
    const storyboardLists = await Promise.all(sceneItems.map((scene) => listStoryboards(scene.id)))

    project.value = projectData
    scenes.value = [...sceneItems].sort((a, b) => a.sceneNo - b.sceneNo)
    storyboards.value = storyboardLists.flat()
    characters.value = [...characterItems].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    audioItems.value = audioList
    voiceCast.value = voiceCastItems
    voiceProfiles.value = voiceCatalog.items
    if (!voiceProfileMap.value.has(formVoiceProfileKey.value)) {
      formVoiceProfileKey.value =
        voiceProfiles.value.find((item) => item.profileKey === 'female-adult-gentle')?.profileKey ||
        voiceProfiles.value[0]?.profileKey ||
        ''
    }

    const hasRequestedScene =
      requestedSceneId.value > 0 && scenes.value.some((item) => item.id === requestedSceneId.value)

    filterSceneId.value = hasRequestedScene ? requestedSceneId.value : 0
    if (hasRequestedScene) {
      formSceneId.value = requestedSceneId.value
    } else if (formSceneId.value > 0 && !scenes.value.some((item) => item.id === formSceneId.value)) {
      formSceneId.value = 0
    }

    syncGenerateDefaults({ forceTrackType: true })
    if (formStoryboardId.value && !storyboards.value.some((item) => item.id === formStoryboardId.value)) {
      formStoryboardId.value = 0
    }
    syncFormText(true)

    syncVoiceSelection()

    rememberContext()
    pageState.value = audioItems.value.length ? 'ready' : 'empty'
    syncSelectedAudio(selectedAudioId.value)
  } catch (error) {
    project.value = null
    scenes.value = []
    storyboards.value = []
    characters.value = []
    audioItems.value = []
    voiceCast.value = []
    voiceProfiles.value = []
    selectedAudioId.value = null
    errorMsg.value = error instanceof Error ? error.message : '音频模块加载失败'
    pageState.value = 'error'
  }
}

async function loadModelDefaults(): Promise<void> {
  try {
    const settings = await getModelSettings()
    defaultAudioModel.value = settings.effective.audio.defaultModel || defaultAudioModel.value
    syncVoiceSelection()
  } catch {
    // 设置中心不可用时保留页面内置默认值。
  }
}

async function onGenerate(): Promise<void> {
  if (generating.value || generateBlockedReason.value || !projectId.value) return

  generating.value = true
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    const created = await generateProjectAudio(projectId.value, {
      trackType: formTrackType.value,
      sceneId: formSceneId.value || undefined,
      storyboardId: storyboardEnabled.value ? formStoryboardId.value || undefined : undefined,
      startOffsetSeconds: storyboardEnabled.value
        ? Math.max(0, Number(formStartOffsetSeconds.value) || 0)
        : undefined,
      characterId: characterEnabled.value ? formCharacterId.value || undefined : undefined,
      title: formTitle.value.trim() || undefined,
      text: formText.value.trim(),
      voiceProfileKey: voiceEnabled.value
        ? selectedFormVoiceProfile.value?.profileKey || undefined
        : undefined,
      modelName: voiceEnabled.value ? formModelName.value || undefined : undefined,
      candidateCount: 1,
    })

    await refreshAudio(created[0]?.id || null)
    infoMsg.value = `${trackLabel(formTrackType.value)}已生成 ${created.length} 条候选，当前版本 V${created[0]?.versionNo || 1}`
    formTitle.value = ''
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '音频生成失败'
  } finally {
    generating.value = false
  }
}

async function onConfirm(audioId: number): Promise<void> {
  if (confirmingAudioId.value) return

  confirmingAudioId.value = audioId
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    const confirmed = await confirmProjectAudio(audioId)
    await refreshAudio(confirmed.id)
    infoMsg.value = `${trackLabel(confirmed.trackType)}主版本已确认`
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '音频确认失败'
  } finally {
    confirmingAudioId.value = null
  }
}

async function onArchive(audioId: number): Promise<void> {
  if (archivingAudioId.value) return

  archivingAudioId.value = audioId
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    const archived = await archiveAudio(audioId)
    const nextSelected = selectedAudioId.value === audioId ? null : selectedAudioId.value
    await refreshAudio(nextSelected)
    infoMsg.value = `${trackLabel(archived.trackType)}候选已归档`
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '音频归档失败'
  } finally {
    archivingAudioId.value = null
  }
}

watch(formTrackType, (next) => {
  if (next !== 'dialogue') {
    formCharacterId.value = 0
  }
  if (!storyboardEnabled.value) formStoryboardId.value = 0
  if ((next === 'dialogue' || next === 'narration') && !formSceneId.value && scenes.value[0]?.id) {
    formSceneId.value = scenes.value[0].id
  }
  syncVoiceSelection()
  syncFormText(true)
})

watch(formSceneId, () => {
  if (formStoryboardId.value && !storyboardOptions.value.some((item) => item.id === formStoryboardId.value)) {
    formStoryboardId.value = 0
  }
  syncFormText(true)
})

watch(formStoryboardId, () => {
  syncFormText(true)
})

watch(formCharacterId, () => {
  if (!characterEnabled.value) return
  syncVoiceSelection()
  syncFormText(true)
})

watch(formVoiceProfileKey, () => {
  if (formTrackType.value === 'narration') syncVoiceSelection()
})

watch(filteredItems, () => {
  syncSelectedAudio(selectedAudioId.value)
})

watch(selectedAudio, (item) => {
  syncPlacementState(item)
}, { immediate: true })

watch(
  [projectId, requestedSceneId],
  () => {
    void loadPage()
  },
  { immediate: false },
)

onMounted(() => {
  void loadModelDefaults()
  void loadPage()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <section
      v-if="pageState === 'missing-project'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少项目上下文</h2>
        <p class="state-desc">音频工作台需要从具体项目进入，请先返回项目工作区。</p>
        <button class="primary-btn" type="button" @click="goDashboard">返回项目页</button>
      </div>
    </section>

    <div
      v-else-if="pageState === 'loading'"
      class="flex h-full items-center justify-center bg-[#111210] text-sm text-[#c7b39a]"
    >
      正在加载音频工作台...
    </div>

    <section
      v-else-if="pageState === 'error'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card border-red-500/40">
        <h2 class="state-title text-red-300">音频工作台加载失败</h2>
        <p class="state-desc">{{ errorMsg || '请稍后重试。' }}</p>
        <div class="action-row">
          <button class="ghost-btn" type="button" @click="loadPage">重新加载</button>
          <button class="primary-btn" type="button" @click="goScenes">返回工作区</button>
        </div>
      </div>
    </section>

    <div v-else class="audio-page">
      <div class="page-top">
        <div>
          <p class="eyebrow">PROJECT {{ projectId }}</p>
          <h1 class="page-title">音频工作台</h1>
          <p class="page-subtitle">
            音频二期改成 source-aware 工作台：按轨道类型、场景、角色生成候选音频，并支持确认主版本与归档旧候选。
          </p>
        </div>

        <div class="top-actions">
          <button class="ghost-btn" type="button" @click="goScenes">返回场景模块</button>
          <button class="ghost-btn" type="button" @click="goCharacters">角色库</button>
          <button class="ghost-btn" type="button" @click="loadPage">刷新列表</button>
        </div>
      </div>

      <div v-if="errorMsg" class="message error">{{ errorMsg }}</div>
      <div v-if="infoMsg" class="message success">{{ infoMsg }}</div>
      <div v-if="!scenes.length" class="message warn">
        当前项目还没有场景，音频二期无法按来源生成。请先完成场景拆解。
      </div>

      <div class="summary-grid">
        <section class="summary-card highlight">
          <span class="summary-label">当前项目</span>
          <strong class="summary-value">{{ project?.name || `项目 #${projectId}` }}</strong>
          <p class="summary-help">项目状态：{{ project?.status || '未知' }}</p>
        </section>
        <section class="summary-card">
          <span class="summary-label">来源上下文</span>
          <strong class="summary-value">{{ requestedSceneId ? '当前场景模式' : '全项目模式' }}</strong>
          <p class="summary-help">
            {{ requestedSceneId ? sceneLabel(requestedSceneId) : '可查看全部场景与项目级轨道。' }}
          </p>
        </section>
        <section class="summary-card">
          <span class="summary-label">候选统计</span>
          <strong class="summary-value">{{ totalCount }}</strong>
          <p class="summary-help">
            已确认 {{ confirmedCount }} · 候选 {{ candidateCount }} · 已归档 {{ archivedCount }}
          </p>
        </section>
        <section class="summary-card">
          <span class="summary-label">场景 / 角色</span>
          <strong class="summary-value">{{ scenes.length }} / {{ characters.length }}</strong>
          <p class="summary-help">已锁定角色音色 {{ lockedVoiceCount }} / {{ characters.length }}</p>
        </section>
      </div>

      <section class="panel voice-cast-panel">
        <div class="panel-head">
          <div>
            <h2>角色音色管理</h2>
            <p class="panel-sub">{{ lockedVoiceCount }} 个角色已锁定，{{ Math.max(0, voiceCast.length - lockedVoiceCount) }} 个待确认</p>
          </div>
          <button class="ghost-btn compact" type="button" @click="goCharacters">角色库</button>
        </div>
        <div v-if="voiceCast.length" class="voice-cast-list">
          <div v-for="item in voiceCast" :key="item.character.id" class="voice-cast-row">
            <div class="voice-cast-character">
              <strong>{{ item.character.name }}</strong>
              <span>{{ item.character.roleTag || '未设置角色标签' }}</span>
            </div>
            <div class="voice-cast-traits">
              <span>{{ ageGroupLabel(item.character.ageGroup || item.traits.ageGroup) }}</span>
              <span>{{ genderLabel(item.character.gender || item.traits.gender) }}</span>
            </div>
            <div class="voice-cast-profile">
              <strong>{{ item.selectedProfile?.displayName || item.recommendations[0]?.displayName || '暂无推荐' }}</strong>
              <span>{{ item.selectedProfile ? `${item.selectedProfile.voiceId} · ${item.selectedProfile.modelName}` : '需要试听确认' }}</span>
            </div>
            <span class="voice-cast-status" :class="item.ready ? 'ready' : 'pending'">
              {{ item.ready ? '已锁定' : '待确认' }}
            </span>
            <button
              class="icon-btn"
              type="button"
              :title="`管理 ${item.character.name} 的音色`"
              @click="goCharacterVoice(item.character.id)"
            >
              <span class="material-symbols-outlined">arrow_forward</span>
            </button>
          </div>
        </div>
        <div v-else class="inspector-empty">当前项目还没有角色</div>
      </section>

      <div class="main-grid">
        <main class="workspace-shell">
          <section class="panel controls-panel">
            <div class="panel-head">
              <div>
                <h2>生成参数</h2>
                <p class="panel-sub">{{ currentTrackMeta.hint }}</p>
              </div>
              <span class="panel-tag">Qwen3 TTS</span>
            </div>

            <div class="field-grid">
              <label class="field">
                <span>轨道类型</span>
                <select v-model="formTrackType">
                  <option
                    v-for="track in TRACK_OPTIONS"
                    :key="track.key"
                    :value="track.key"
                    :disabled="track.key === 'music' || track.key === 'sfx'"
                  >
                    {{ track.label }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>场景来源</span>
                <select v-model="formSceneId">
                  <option :value="0">项目级 / 不绑定场景</option>
                  <option v-for="scene in sceneOptions" :key="scene.id" :value="scene.id">
                    {{ `Scene ${String(scene.sceneNo).padStart(2, '0')} · ${scene.title || '未命名场景'}` }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>分镜定位</span>
                <select v-model="formStoryboardId" :disabled="!storyboardEnabled || !formSceneId">
                  <option :value="0">
                    {{ storyboardEnabled ? '不绑定具体分镜（按场景排布）' : '当前轨道不绑定分镜' }}
                  </option>
                  <option v-for="storyboard in storyboardOptions" :key="storyboard.id" :value="storyboard.id">
                    {{ `${storyboard.shotNo} · ${storyboard.shotType || '镜头'} · ${storyboard.durationSeconds || 4}s` }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>角色来源</span>
                <select v-model="formCharacterId" :disabled="!characterEnabled">
                  <option :value="0">{{ characterEnabled ? '请选择角色' : '当前轨道不绑定角色' }}</option>
                  <option v-for="character in characterOptions" :key="character.id" :value="character.id">
                    {{ `${character.name} · ${voiceCastMap.get(character.id)?.ready ? '已锁定音色' : '待配置音色'}` }}
                  </option>
                </select>
              </label>

              <label class="field field-wide">
                <span>自定义标题</span>
                <input v-model="formTitle" type="text" placeholder="留空则按轨道 / 场景 / 角色自动命名" />
              </label>

              <label class="field field-wide speech-field">
                <span class="field-heading">
                  <span>朗读文本（{{ formText.trim().length }} / {{ MAX_AUDIO_TEXT_LENGTH }}）</span>
                  <button
                    class="ghost-btn compact auto-read-btn"
                    type="button"
                    :disabled="formTrackType !== 'dialogue' && formTrackType !== 'narration'"
                    @click.prevent="onAutoReadText"
                  >
                    <span class="material-symbols-outlined">auto_stories</span>
                    自动读取
                  </button>
                </span>
                <textarea
                  v-model="formText"
                  :maxlength="MAX_AUDIO_TEXT_LENGTH"
                  rows="6"
                  placeholder="输入对白或旁白文本"
                ></textarea>
                <small v-if="autoTextNotice" class="field-hint">{{ autoTextNotice }}</small>
              </label>

              <label class="field">
                <span>{{ formTrackType === 'dialogue' ? '角色主音色' : '旁白音色' }}</span>
                <input
                  v-if="formTrackType === 'dialogue'"
                  :value="selectedCharacterVoiceCast?.selectedProfile?.displayName || '未锁定音色'"
                  type="text"
                  disabled
                />
                <select v-else v-model="formVoiceProfileKey" :disabled="!voiceEnabled">
                  <option v-for="profile in voiceProfiles" :key="profile.profileKey" :value="profile.profileKey">
                    {{ `${profile.displayName} · ${profile.voiceId}` }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>模型标识</span>
                <input :value="selectedFormVoiceProfile?.modelName || formModelName" type="text" disabled />
              </label>

              <label class="field">
                <span>起始微调（秒）</span>
                <input
                  v-model.number="formStartOffsetSeconds"
                  min="0"
                  max="10"
                  step="0.1"
                  type="number"
                  :disabled="!storyboardEnabled"
                />
              </label>
            </div>

            <div class="controls-footer">
              <div>
                <div class="controls-title">本次生成</div>
                <p class="controls-desc">
                  绑定具体分镜后，导出会把这条语音锁定在对应镜头时间线上。
                </p>
                <p v-if="generateBlockedReason" class="controls-warning">{{ generateBlockedReason }}</p>
              </div>

              <button class="primary-btn" type="button" :disabled="Boolean(generateBlockedReason) || generating" @click="onGenerate">
                {{ generating ? '正在生成...' : '生成语音' }}
              </button>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>筛选与分组</h2>
                <p class="panel-sub">
                  当前可见 {{ visibleCount }} 条候选，归属于 {{ groupCount }} 个来源分组。
                </p>
              </div>
            </div>

            <div class="field-grid filter-grid">
              <label class="field">
                <span>关键字</span>
                <input v-model="keyword" type="text" placeholder="标题 / 场景 / 角色 / 音色 / 模型" />
              </label>

              <label class="field">
                <span>轨道筛选</span>
                <select v-model="filterTrackType">
                  <option value="all">全部轨道</option>
                  <option v-for="track in TRACK_OPTIONS" :key="track.key" :value="track.key">
                    {{ track.label }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>场景筛选</span>
                <select v-model="filterSceneId">
                  <option :value="0">全部场景 / 项目级</option>
                  <option v-for="scene in sceneOptions" :key="scene.id" :value="scene.id">
                    {{ `Scene ${String(scene.sceneNo).padStart(2, '0')} · ${scene.title || '未命名场景'}` }}
                  </option>
                </select>
              </label>

              <label class="field">
                <span>状态筛选</span>
                <select v-model="filterStatus">
                  <option v-for="status in STATUS_OPTIONS" :key="status.value" :value="status.value">
                    {{ status.label }}
                  </option>
                </select>
              </label>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>音频候选列表</h2>
                <p class="panel-sub">
                  分组维度：轨道类型 + 场景 + 角色。每个来源组只能保留 1 条 confirmed 主版本。
                </p>
              </div>
            </div>

            <div v-if="!visibleCount" class="empty-stage">
              <span class="material-symbols-outlined text-4xl text-primary/80">library_music</span>
              <h3>{{ emptyStateTitle }}</h3>
              <p>{{ emptyStateDesc }}</p>
              <div class="action-row">
                <button v-if="!scenes.length" class="primary-btn" type="button" @click="goScenes">
                  去场景模块
                </button>
                <button v-else-if="totalCount > 0" class="ghost-btn" type="button" @click="filterTrackType = 'all'; filterSceneId = 0; filterStatus = 'all'; keyword = ''">
                  清空筛选
                </button>
              </div>
            </div>

            <div v-else class="group-stack">
              <section
                v-for="group in groupedItems"
                :key="group.key"
                class="audio-group"
                :class="TRACK_OPTIONS.find((item) => item.key === group.trackType)?.accentClass"
              >
                <div class="group-head">
                  <div>
                    <div class="group-title-line">
                      <span class="material-symbols-outlined">
                        {{ TRACK_OPTIONS.find((item) => item.key === group.trackType)?.icon }}
                      </span>
                      <h3>{{ group.title }}</h3>
                    </div>
                    <p class="group-subtitle">{{ group.subtitle }}</p>
                  </div>
                  <span class="group-count">{{ group.items.length }} 条</span>
                </div>

                <div class="candidate-grid">
                  <article
                    v-for="item in group.items"
                    :key="item.id"
                    class="audio-card"
                    :class="{
                      active: item.id === selectedAudioId,
                      confirmed: item.status === 'confirmed',
                      archived: item.status === 'archived',
                    }"
                  >
                    <div class="card-head">
                      <div>
                        <span class="card-kicker">{{ trackLabel(item.trackType) }} · V{{ item.versionNo }}</span>
                        <h4>{{ item.title }}</h4>
                      </div>
                      <span class="status-chip" :class="item.status">{{ statusLabel(item.status) }}</span>
                    </div>

                    <p class="card-meta">
                      {{ sceneLabel(item.sceneId, item.sceneNo, item.sceneTitle) }}
                      <span v-if="item.shotNo"> · {{ item.shotNo }}</span>
                      <span v-if="item.characterId"> · {{ characterLabel(item.characterId, item.characterName) }}</span>
                    </p>

                    <div class="candidate-bars">
                      <span
                        v-for="(bar, index) in waveformBars(item)"
                        :key="`${item.id}-${index}`"
                        class="bar"
                        :style="{ height: `${bar}px` }"
                      ></span>
                    </div>

                    <audio class="audio-player" controls preload="none" :src="item.audioUrl"></audio>

                    <div class="card-meta-grid">
                      <span>时长：{{ formatDuration(item.durationSeconds) }}</span>
                      <span>音色：{{ item.voiceName || '—' }}</span>
                      <span>模型：{{ item.modelName || '—' }}</span>
                      <span>创建：{{ formatDateTime(item.createdAt) }}</span>
                    </div>

                    <div class="card-actions">
                      <button class="ghost-btn compact" type="button" @click="selectedAudioId = item.id">
                        查看详情
                      </button>
                      <button
                        class="ghost-btn compact"
                        type="button"
                        :disabled="item.status === 'confirmed' || archivingAudioId === item.id"
                        @click="onArchive(item.id)"
                      >
                        {{
                          item.status === 'confirmed'
                            ? '主版本不可归档'
                            : archivingAudioId === item.id
                              ? '归档中...'
                              : '归档候选'
                        }}
                      </button>
                      <button
                        class="primary-btn compact"
                        type="button"
                        :disabled="item.status === 'confirmed' || confirmingAudioId === item.id"
                        @click="onConfirm(item.id)"
                      >
                        {{
                          item.status === 'confirmed'
                            ? '当前主版本'
                            : confirmingAudioId === item.id
                              ? '确认中...'
                              : '确认主版本'
                        }}
                      </button>
                    </div>
                  </article>
                </div>
              </section>
            </div>
          </section>
        </main>

        <aside class="inspector-shell">
          <section class="panel sticky-panel">
            <div class="panel-head">
              <div>
                <h2>详情检查器</h2>
                <p class="panel-sub">查看当前选中音频的来源、状态与后续跳转入口。</p>
              </div>
            </div>

            <div v-if="!selectedAudio" class="inspector-empty">
              <span class="material-symbols-outlined text-4xl text-primary/80">headphones</span>
              <p>先从左侧选中一条候选音频，再查看详情。</p>
            </div>

            <div v-else class="inspector-body">
              <div class="chip-row">
                <span class="status-chip" :class="selectedAudio.status">{{ statusLabel(selectedAudio.status) }}</span>
                <span class="status-chip neutral">{{ trackLabel(selectedAudio.trackType) }}</span>
              </div>

              <div>
                <h3 class="inspector-title">{{ selectedAudio.title }}</h3>
                <p class="inspector-sub">
                  {{ sceneLabel(selectedAudio.sceneId, selectedAudio.sceneNo, selectedAudio.sceneTitle) }}
                  <span v-if="selectedAudio.shotNo"> · {{ selectedAudio.shotNo }}</span>
                  <span v-if="selectedAudio.characterId">
                    · {{ characterLabel(selectedAudio.characterId, selectedAudio.characterName) }}
                  </span>
                </p>
              </div>

              <audio class="audio-player" controls preload="none" :src="selectedAudio.audioUrl"></audio>

              <div class="placement-panel">
                <div class="placement-title">时间线定位</div>
                <label class="field">
                  <span>绑定分镜</span>
                  <select v-model="placementStoryboardId">
                    <option :value="0">不绑定具体分镜（按场景排布）</option>
                    <option
                      v-for="storyboard in storyboards.filter((item) => !selectedAudio?.sceneId || item.sceneId === selectedAudio.sceneId)"
                      :key="storyboard.id"
                      :value="storyboard.id"
                    >
                      {{ `${storyboard.shotNo} · ${storyboard.shotType || '镜头'} · ${storyboard.durationSeconds || 4}s` }}
                    </option>
                  </select>
                </label>
                <label class="field">
                  <span>起始微调（秒）</span>
                  <input v-model.number="placementOffsetSeconds" min="0" max="60" step="0.1" type="number" />
                </label>
                <button class="primary-btn compact" type="button" :disabled="savingPlacement" @click="savePlacement">
                  {{ savingPlacement ? '保存中...' : '保存定位' }}
                </button>
              </div>

              <div class="candidate-bars inspector-bars">
                <span
                  v-for="(bar, index) in waveformBars(selectedAudio)"
                  :key="`inspector-${selectedAudio.id}-${index}`"
                  class="bar"
                  :style="{ height: `${bar}px` }"
                ></span>
              </div>

              <div class="inspector-grid">
                <div>
                  <span class="inspector-label">版本</span>
                  <strong>V{{ selectedAudio.versionNo }}</strong>
                </div>
                <div>
                  <span class="inspector-label">时长</span>
                  <strong>{{ formatDuration(selectedAudio.durationSeconds) }}</strong>
                </div>
                <div>
                  <span class="inspector-label">音色</span>
                  <strong>{{ selectedAudio.voiceName || '—' }}</strong>
                </div>
                <div>
                  <span class="inspector-label">模型</span>
                  <strong>{{ selectedAudio.modelName || '—' }}</strong>
                </div>
                <div>
                  <span class="inspector-label">创建时间</span>
                  <strong>{{ formatDateTime(selectedAudio.createdAt) }}</strong>
                </div>
                <div>
                  <span class="inspector-label">确认时间</span>
                  <strong>{{ formatDateTime(selectedAudio.confirmedAt) }}</strong>
                </div>
              </div>

              <div class="inspector-note">
                <h4>来源说明</h4>
                <p v-if="selectedAudio.trackType === 'dialogue'">
                  这条对白轨按“场景 + 角色”分组确认，后续接真实 TTS 时可以直接复用角色音色配置。
                </p>
                <p v-else-if="selectedAudio.trackType === 'narration'">
                  这条旁白轨按场景来源管理，适合后面继续扩展成解说词 / 旁白多版本工作流。
                </p>
                <p v-else-if="selectedAudio.trackType === 'music'">
                  这条音乐轨当前还是 mock 占位，后续可扩成风格、节奏、情绪等参数。
                </p>
                <p v-else>
                  这条音效轨当前还是 mock 占位，后续可扩成环境音、动作音、转场音分类。
                </p>
              </div>

              <div class="stack-actions">
                <button
                  v-if="selectedAudio.sceneId"
                  class="ghost-btn w-full"
                  type="button"
                  @click="goScriptScene(selectedAudio.sceneId)"
                >
                  返回该场景脚本
                </button>
                <button
                  class="primary-btn w-full"
                  type="button"
                  :disabled="selectedAudio.status === 'confirmed' || confirmingAudioId === selectedAudio.id"
                  @click="onConfirm(selectedAudio.id)"
                >
                  {{
                    selectedAudio.status === 'confirmed'
                      ? '当前已是主版本'
                      : confirmingAudioId === selectedAudio.id
                        ? '确认中...'
                        : '确认当前音频为主版本'
                  }}
                </button>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.audio-page {
  min-height: 100%;
  background:
    radial-gradient(circle at top left, rgba(245, 158, 11, 0.16), transparent 30%),
    radial-gradient(circle at bottom right, rgba(14, 165, 233, 0.08), transparent 24%),
    #111210;
  color: #f3ede4;
  padding: 32px;
}

.page-top {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: flex-start;
  margin-bottom: 20px;
}

.eyebrow {
  margin: 0 0 8px;
  color: #c7b39a;
  font-size: 12px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
}

.page-title {
  margin: 0;
  font-size: 34px;
  line-height: 1.1;
}

.page-subtitle {
  margin: 10px 0 0;
  max-width: 760px;
  color: #cbb59b;
  line-height: 1.7;
}

.top-actions,
.action-row,
.stack-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.summary-card,
.panel,
.state-card {
  border: 1px solid rgba(203, 181, 155, 0.18);
  background: rgba(23, 24, 21, 0.92);
  box-shadow: 0 22px 50px rgba(0, 0, 0, 0.24);
}

.summary-card {
  padding: 18px;
}

.summary-card.highlight {
  background: linear-gradient(135deg, rgba(42, 27, 14, 0.96), rgba(23, 24, 21, 0.92));
}

.summary-label {
  display: block;
  color: #c7b39a;
  font-size: 12px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.summary-value {
  display: block;
  margin-top: 10px;
  font-size: 24px;
}

.summary-help {
  margin: 10px 0 0;
  color: #a9937a;
  line-height: 1.6;
}

.main-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(320px, 0.9fr);
  gap: 20px;
}

.workspace-shell,
.group-stack {
  display: grid;
  gap: 20px;
}

.panel {
  padding: 20px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: flex-start;
  margin-bottom: 18px;
}

.panel-head h2 {
  margin: 0;
  font-size: 20px;
}

.panel-sub {
  margin: 6px 0 0;
  color: #af9981;
  line-height: 1.6;
}

.voice-cast-panel {
  margin-bottom: 20px;
}

.voice-cast-list {
  border: 1px solid rgba(203, 181, 155, 0.16);
}

.voice-cast-row {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) minmax(130px, 0.65fr) minmax(240px, 1.35fr) 74px 38px;
  gap: 16px;
  align-items: center;
  min-height: 68px;
  padding: 12px 14px;
  background: rgba(15, 16, 14, 0.68);
}

.voice-cast-row + .voice-cast-row {
  border-top: 1px solid rgba(203, 181, 155, 0.14);
}

.voice-cast-character,
.voice-cast-profile {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.voice-cast-character strong,
.voice-cast-profile strong {
  overflow: hidden;
  color: #f6efe5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-cast-character span,
.voice-cast-profile span {
  overflow: hidden;
  color: #a9937a;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-cast-traits {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.voice-cast-traits span,
.voice-cast-status {
  border: 1px solid rgba(203, 181, 155, 0.18);
  padding: 4px 7px;
  color: #dbc7b0;
  font-size: 12px;
  text-align: center;
}

.voice-cast-status.ready {
  border-color: rgba(52, 211, 153, 0.38);
  background: rgba(52, 211, 153, 0.08);
  color: #a7f3d0;
}

.voice-cast-status.pending {
  border-color: rgba(251, 191, 36, 0.38);
  background: rgba(251, 191, 36, 0.08);
  color: #fde68a;
}

.icon-btn {
  display: inline-flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(203, 181, 155, 0.22);
  color: #f6efe5;
}

.icon-btn:hover {
  border-color: rgba(245, 158, 11, 0.6);
  color: #ffcb8e;
}

.panel-tag,
.group-count {
  border: 1px solid rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.12);
  color: #ffcb8e;
  padding: 6px 10px;
  font-size: 12px;
  letter-spacing: 0.12em;
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.filter-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: #dbc7b0;
  font-size: 13px;
}

.field-wide {
  grid-column: span 2;
}

.field-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.auto-read-btn {
  min-height: 30px;
  padding: 6px 10px;
}

.auto-read-btn .material-symbols-outlined {
  font-size: 17px;
}

.field-hint {
  color: #a89782;
  line-height: 1.5;
}

.field input,
.field select,
.field textarea {
  border: 1px solid rgba(203, 181, 155, 0.2);
  background: rgba(15, 16, 14, 0.88);
  color: #f6efe5;
  padding: 11px 12px;
  outline: none;
}

.field textarea {
  min-height: 132px;
  resize: vertical;
  line-height: 1.65;
}

.field input:disabled,
.field select:disabled {
  opacity: 0.58;
  cursor: not-allowed;
}

.controls-footer {
  margin-top: 18px;
  border-top: 1px solid rgba(203, 181, 155, 0.14);
  padding-top: 18px;
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: center;
}

.controls-title {
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #c7b39a;
}

.controls-desc {
  margin: 8px 0 0;
  color: #af9981;
  line-height: 1.6;
}

.controls-warning {
  margin: 10px 0 0;
  color: #fbbf24;
  line-height: 1.6;
}

.audio-group {
  border: 1px solid rgba(203, 181, 155, 0.16);
  background: rgba(15, 16, 14, 0.78);
  padding: 16px;
}

.group-head,
.group-title-line,
.card-head,
.card-actions,
.chip-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.group-title-line h3,
.card-head h4 {
  margin: 0;
}

.group-subtitle,
.card-meta {
  margin: 8px 0 0;
  color: #af9981;
  line-height: 1.6;
}

.candidate-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.audio-card {
  border: 1px solid rgba(203, 181, 155, 0.16);
  background: rgba(23, 24, 21, 0.92);
  padding: 16px;
}

.audio-card.active {
  border-color: rgba(245, 158, 11, 0.55);
  box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.18);
}

.audio-card.confirmed {
  background: linear-gradient(135deg, rgba(42, 27, 14, 0.96), rgba(23, 24, 21, 0.92));
}

.audio-card.archived {
  opacity: 0.72;
}

.card-kicker {
  display: block;
  color: #c7b39a;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.status-chip {
  border: 1px solid rgba(203, 181, 155, 0.18);
  padding: 4px 8px;
  font-size: 12px;
  color: #f6efe5;
}

.status-chip.confirmed {
  background: rgba(245, 158, 11, 0.14);
  color: #ffcb8e;
}

.status-chip.candidate {
  background: rgba(59, 130, 246, 0.14);
  color: #bfdbfe;
}

.status-chip.archived {
  background: rgba(107, 114, 128, 0.2);
  color: #d1d5db;
}

.status-chip.neutral {
  background: rgba(255, 255, 255, 0.05);
  color: #cbb59b;
}

.candidate-bars {
  height: 54px;
  display: flex;
  align-items: end;
  gap: 3px;
  margin: 12px 0;
  padding: 0 2px;
}

.inspector-bars {
  height: 66px;
}

.bar {
  width: 5px;
  border-radius: 999px;
  background: linear-gradient(180deg, #ffcf96 0%, #ff9d45 100%);
}

.audio-player {
  width: 100%;
  margin-top: 10px;
}

.card-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
  color: #cbb59b;
  font-size: 12px;
}

.sticky-panel {
  position: sticky;
  top: 24px;
}

.placement-panel {
  display: grid;
  gap: 10px;
  border: 1px solid rgba(245, 158, 11, 0.22);
  background: rgba(245, 158, 11, 0.06);
  padding: 14px;
}

.placement-title {
  color: #f7cf8d;
  font-size: 13px;
  font-weight: 700;
}

.inspector-body {
  display: grid;
  gap: 16px;
}

.inspector-title {
  margin: 0;
  font-size: 22px;
}

.inspector-sub {
  margin: 8px 0 0;
  color: #af9981;
  line-height: 1.6;
}

.inspector-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  border-top: 1px solid rgba(203, 181, 155, 0.12);
  border-bottom: 1px solid rgba(203, 181, 155, 0.12);
  padding: 14px 0;
}

.inspector-label {
  display: block;
  color: #c7b39a;
  font-size: 12px;
  margin-bottom: 6px;
}

.inspector-note {
  border: 1px solid rgba(203, 181, 155, 0.16);
  background: rgba(15, 16, 14, 0.76);
  padding: 14px;
}

.inspector-note h4 {
  margin: 0 0 8px;
}

.inspector-note p {
  margin: 0;
  color: #af9981;
  line-height: 1.7;
}

.inspector-empty,
.empty-stage {
  border: 1px dashed rgba(203, 181, 155, 0.18);
  background: rgba(15, 16, 14, 0.52);
  min-height: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  color: #cbb59b;
  padding: 24px;
}

.message {
  padding: 12px 14px;
  margin-bottom: 14px;
  border: 1px solid rgba(203, 181, 155, 0.18);
}

.message.error {
  background: rgba(127, 29, 29, 0.2);
  color: #fecaca;
}

.message.success {
  background: rgba(21, 128, 61, 0.18);
  color: #bbf7d0;
}

.message.warn {
  background: rgba(146, 64, 14, 0.18);
  color: #fed7aa;
}

.state-card {
  max-width: 520px;
  padding: 28px;
}

.state-title {
  margin: 0 0 10px;
  font-size: 24px;
}

.state-desc {
  margin: 0 0 18px;
  color: #cbb59b;
  line-height: 1.7;
}

.primary-btn,
.ghost-btn {
  border: 1px solid rgba(245, 158, 11, 0.28);
  padding: 10px 16px;
  color: #f6efe5;
}

.primary-btn {
  background: linear-gradient(135deg, #f59e0b, #ea580c);
  border-color: transparent;
}

.ghost-btn {
  background: rgba(255, 255, 255, 0.04);
}

.primary-btn.compact,
.ghost-btn.compact {
  padding: 8px 12px;
  font-size: 13px;
}

.track-dialogue .group-title-line,
.track-dialogue .group-count {
  color: #ffbb78;
}

.track-narration .group-title-line,
.track-narration .group-count {
  color: #f7cf8d;
}

.track-music .group-title-line,
.track-music .group-count {
  color: #8bd3ff;
}

.track-sfx .group-title-line,
.track-sfx .group-count {
  color: #b59cff;
}

@media (max-width: 1240px) {
  .summary-grid,
  .main-grid,
  .filter-grid,
  .candidate-grid,
  .inspector-grid,
  .card-meta-grid {
    grid-template-columns: 1fr;
  }

  .voice-cast-row {
    grid-template-columns: minmax(150px, 1fr) minmax(120px, 0.7fr) minmax(220px, 1.2fr) 74px 38px;
  }
}

@media (max-width: 960px) {
  .field-grid,
  .summary-grid {
    grid-template-columns: 1fr;
  }

  .field-wide {
    grid-column: span 1;
  }

  .field-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .voice-cast-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .voice-cast-character {
    grid-column: 1;
    grid-row: 1;
  }

  .voice-cast-status {
    grid-column: 2;
    grid-row: 1;
  }

  .voice-cast-traits {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .voice-cast-profile {
    grid-column: 1;
    grid-row: 3;
  }

  .voice-cast-row .icon-btn {
    grid-column: 2;
    grid-row: 3;
  }
}

@media (max-width: 720px) {
  .audio-page {
    padding: 20px;
  }

  .page-top,
  .controls-footer,
  .panel-head,
  .group-head,
  .card-actions {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
