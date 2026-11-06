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
import { claimReworkItem, completeReworkItem } from '@/lib/rework-queue'
import { buildVoiceBindingSummary } from '@/lib/voice-binding-status'

type TrackType = 'dialogue' | 'narration' | 'music' | 'sfx'
type PageState = 'missing-project' | 'loading' | 'empty' | 'error' | 'ready'
type FilterTrackType = TrackType | 'all'
type FilterStatus = 'all' | 'candidate' | 'confirmed' | 'archived'
type PickerKey =
  | 'track'
  | 'scene'
  | 'storyboard'
  | 'character'
  | 'voice'
  | 'filterTrack'
  | 'filterScene'
  | 'filterStatus'
  | 'placementStoryboard'
type PickerValue = string | number

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

interface PickerOption {
  value: PickerValue
  label: string
  meta?: string
  icon?: string
  disabled?: boolean
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
const requestedStoryboardId = computed(() => Number(route.query.storyboardId) || getWorkspaceContext()?.storyboardId || 0)
const reworkCandidateId = computed(() => Number(route.query.reworkCandidateId) || 0)

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
const reworkContext = ref<{ candidateId: number } | null>(null)

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
const activePicker = ref<PickerKey | null>(null)

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
const voiceBindingSummary = computed(() => buildVoiceBindingSummary(voiceCast.value, storyboards.value))
const lockedVoiceCount = computed(() => voiceBindingSummary.value.ready)

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

const trackPickerOptions = computed<PickerOption[]>(() =>
  TRACK_OPTIONS.map((track) => ({
    value: track.key,
    label: track.label,
    meta: track.key === 'music' || track.key === 'sfx' ? '待接入' : track.hint,
    icon: track.icon,
    disabled: track.key === 'music' || track.key === 'sfx',
  })),
)
const scenePickerOptions = computed<PickerOption[]>(() => [
  { value: 0, label: '项目级 / 不绑定场景', meta: '适合通用旁白、音乐或音效' },
  ...sceneOptions.value.map((scene) => ({
    value: scene.id,
    label: `Scene ${String(scene.sceneNo).padStart(2, '0')} · ${scene.title || '未命名场景'}`,
    meta: scene.summary || scene.location || '场景来源',
  })),
])
const storyboardPickerOptions = computed<PickerOption[]>(() => [
  {
    value: 0,
    label: storyboardEnabled.value ? '不绑定具体分镜（按场景排布）' : '当前轨道不绑定分镜',
    meta: storyboardEnabled.value ? '导出时按场景顺序排布' : '音乐与音效暂不绑定镜头',
  },
  ...storyboardOptions.value.map((storyboard) => ({
    value: storyboard.id,
    label: `${storyboard.shotNo} · ${storyboard.shotType || '镜头'} · ${storyboard.durationSeconds || 4}s`,
    meta: storyboard.actionText || storyboard.dialogueText || '分镜定位',
  })),
])
const characterPickerOptions = computed<PickerOption[]>(() => [
  {
    value: 0,
    label: characterEnabled.value ? '请选择角色' : '当前轨道不绑定角色',
    meta: characterEnabled.value ? '选择后使用角色锁定音色' : '只有对白轨需要角色',
  },
  ...characterOptions.value.map((character) => {
    const cast = voiceCastMap.value.get(character.id)
    return {
      value: character.id,
      label: character.name,
      meta: `${character.roleTag || '未设置角色标签'} · ${cast?.ready ? '已锁定音色' : '待配置音色'}`,
    }
  }),
])
const voicePickerOptions = computed<PickerOption[]>(() =>
  voiceProfiles.value.map((profile) => ({
    value: profile.profileKey,
    label: profile.displayName,
    meta: `${profile.voiceId} · ${profile.modelName}`,
  })),
)
const filterTrackPickerOptions = computed<PickerOption[]>(() => [
  { value: 'all', label: '全部轨道', meta: `共 ${totalCount.value} 条音频候选` },
  ...TRACK_OPTIONS.map((track) => ({
    value: track.key,
    label: track.label,
    meta: track.hint,
    icon: track.icon,
  })),
])
const filterScenePickerOptions = computed<PickerOption[]>(() => [
  { value: 0, label: '全部场景 / 项目级', meta: `覆盖 ${scenes.value.length} 个场景` },
  ...sceneOptions.value.map((scene) => ({
    value: scene.id,
    label: `Scene ${String(scene.sceneNo).padStart(2, '0')} · ${scene.title || '未命名场景'}`,
    meta: scene.summary || scene.location || '场景筛选',
  })),
])
const filterStatusPickerOptions = computed<PickerOption[]>(() =>
  STATUS_OPTIONS.map((status) => {
    const count =
      status.value === 'candidate'
        ? candidateCount.value
        : status.value === 'confirmed'
          ? confirmedCount.value
          : status.value === 'archived'
            ? archivedCount.value
            : totalCount.value
    return {
      value: status.value,
      label: status.label,
      meta: `${count} 条匹配`,
    }
  }),
)
const selectedTrackPickerOption = computed(() => findPickerOption(trackPickerOptions.value, formTrackType.value))
const selectedScenePickerOption = computed(() => findPickerOption(scenePickerOptions.value, formSceneId.value))
const selectedStoryboardPickerOption = computed(() =>
  findPickerOption(storyboardPickerOptions.value, formStoryboardId.value),
)
const selectedCharacterPickerOption = computed(() =>
  findPickerOption(characterPickerOptions.value, formCharacterId.value),
)
const selectedVoicePickerOption = computed(() =>
  findPickerOption(voicePickerOptions.value, formVoiceProfileKey.value),
)
const selectedFilterTrackPickerOption = computed(() =>
  findPickerOption(filterTrackPickerOptions.value, filterTrackType.value),
)
const selectedFilterScenePickerOption = computed(() =>
  findPickerOption(filterScenePickerOptions.value, filterSceneId.value),
)
const selectedFilterStatusPickerOption = computed(() =>
  findPickerOption(filterStatusPickerOptions.value, filterStatus.value),
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
const placementStoryboardPickerOptions = computed<PickerOption[]>(() => [
  { value: 0, label: '不绑定具体分镜（按场景排布）', meta: '导出时按场景顺序自动排布' },
  ...storyboards.value
    .filter((item) => !selectedAudio.value?.sceneId || item.sceneId === selectedAudio.value.sceneId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((storyboard) => ({
      value: storyboard.id,
      label: `${storyboard.shotNo} · ${storyboard.shotType || '镜头'} · ${storyboard.durationSeconds || 4}s`,
      meta: storyboard.actionText || storyboard.dialogueText || '时间线分镜',
    })),
])
const selectedPlacementStoryboardPickerOption = computed(() =>
  findPickerOption(placementStoryboardPickerOptions.value, placementStoryboardId.value),
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

function findPickerOption(options: PickerOption[], value: PickerValue): PickerOption | null {
  return options.find((option) => String(option.value) === String(value)) || null
}

function isPickerOpen(key: PickerKey): boolean {
  return activePicker.value === key
}

function togglePicker(key: PickerKey, disabled = false): void {
  if (disabled) return
  activePicker.value = activePicker.value === key ? null : key
}

function closePicker(key?: PickerKey): void {
  if (!key || activePicker.value === key) activePicker.value = null
}

function onPickerBlur(event: FocusEvent, key: PickerKey): void {
  const nextTarget = event.relatedTarget
  if (nextTarget instanceof Node && event.currentTarget instanceof Node) {
    if (event.currentTarget.contains(nextTarget)) return
  }
  closePicker(key)
}

function onPick(key: PickerKey, option: PickerOption): void {
  if (option.disabled) return

  if (key === 'track') formTrackType.value = option.value as TrackType
  if (key === 'scene') formSceneId.value = Number(option.value)
  if (key === 'storyboard') formStoryboardId.value = Number(option.value)
  if (key === 'character') formCharacterId.value = Number(option.value)
  if (key === 'voice') formVoiceProfileKey.value = String(option.value)
  if (key === 'filterTrack') filterTrackType.value = option.value as FilterTrackType
  if (key === 'filterScene') filterSceneId.value = Number(option.value)
  if (key === 'filterStatus') filterStatus.value = option.value as FilterStatus
  if (key === 'placementStoryboard') placementStoryboardId.value = Number(option.value)

  closePicker(key)
}

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
  // 音频列表按“轨道 + 场景 + 角色”分组。
  // 同一个角色在同一场景下的多次候选音频会聚在一起，便于确认主版本。
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
  // 刷新列表后尽量保持当前选中项。
  // 如果当前项不存在，就优先选当前场景的 confirmed 音频，再选任意 confirmed 音频。
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
  // 调整音频绑定的分镜和起始微调时间。
  // 这不会改音频文件本身，只影响后续成片导出时放到时间线上的位置。
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
  // 只刷新音频资产列表，不重新加载项目/角色/分镜等基础数据。
  if (!projectId.value) return
  audioItems.value = await listProjectAudio(projectId.value)
  pageState.value = audioItems.value.length ? 'ready' : 'empty'
  syncSelectedAudio(preferredId)
}

async function loadPage(): Promise<void> {
  // 音频页需要一次性加载项目、场景、角色、已有音频、角色音色绑定和系统音色目录。
  // 后面生成对白时，表单会从这些数据里自动推导文本、角色和推荐音色。
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
    if (reworkCandidateId.value) {
      const claimed = claimReworkItem(projectId.value, reworkCandidateId.value, 'audio')
      if (claimed) {
        reworkContext.value = { candidateId: claimed.candidateId }
      }
    }
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
    if (!formStoryboardId.value && requestedStoryboardId.value > 0) {
      const requestedShot = storyboards.value.find((item) => item.id === requestedStoryboardId.value)
      if (requestedShot) {
        formStoryboardId.value = requestedShot.id
        formSceneId.value = requestedShot.sceneId
        filterSceneId.value = requestedShot.sceneId
      }
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
  // 从模型设置中心读取当前音频默认模型。
  // 页面内置值只是兜底，真实项目最好以设置中心为准。
  try {
    const settings = await getModelSettings()
    defaultAudioModel.value = settings.effective.audio.defaultModel || defaultAudioModel.value
    syncVoiceSelection()
  } catch {
    // 设置中心不可用时保留页面内置默认值。
  }
}

async function onGenerate(): Promise<void> {
  // 生成音频是同步返回候选列表：
  // 后端会调用 TTS、下载音频、写入 audio_assets 后再把新记录返回给页面。
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
    if (reworkContext.value) {
      completeReworkItem(projectId.value, reworkContext.value.candidateId, 'audio')
      reworkContext.value = null
    }
    infoMsg.value = `${trackLabel(formTrackType.value)}已生成 ${created.length} 条候选，当前版本 V${created[0]?.versionNo || 1}`
    formTitle.value = ''
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '音频生成失败'
  } finally {
    generating.value = false
  }
}

async function onConfirm(audioId: number): Promise<void> {
  // 确认音频会把它标记为 confirmed。
  // 后续口型同步和成片导出默认只使用 confirmed 音频。
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
          <h1 class="page-title">音频工作台</h1>
          <p class="page-subtitle">
            音频二期改成 source-aware 工作台：按轨道类型、场景、角色生成候选音频，并支持确认主版本与归档旧候选。
          </p>
          <div class="page-meta-row">
            <span>Project {{ projectId }}</span>
            <span>{{ requestedSceneId ? '当前场景模式' : '全项目模式' }}</span>
            <span>{{ confirmedCount }} 条主版本</span>
          </div>
        </div>

        <div class="top-actions">
          <button class="ghost-btn" type="button" @click="goScenes">返回场景模块</button>
          <button class="ghost-btn" type="button" @click="goCharacters">角色库</button>
          <button class="ghost-btn" type="button" @click="loadPage">刷新列表</button>
        </div>
      </div>

      <div v-if="errorMsg" class="message error">{{ errorMsg }}</div>
      <div v-if="infoMsg" class="message success">{{ infoMsg }}</div>
      <div v-if="reworkContext" class="message rework">
        正在处理返工音频 #{{ reworkContext.candidateId }}。生成新声音成功后，会把该项标记为已完成。
      </div>
      <div v-if="!scenes.length" class="message warn">
        当前项目还没有场景，音频二期无法按来源生成。请先完成场景拆解。
      </div>

      <div class="summary-grid" aria-label="音频工作台状态概览">
        <section class="summary-card highlight">
          <span class="summary-label">项目</span>
          <strong class="summary-value">{{ project?.name || `项目 #${projectId}` }}</strong>
          <p class="summary-help">项目状态：{{ project?.status || '未知' }}</p>
        </section>
        <section class="summary-card">
          <span class="summary-label">来源</span>
          <strong class="summary-value">{{ requestedSceneId ? '当前场景模式' : '全项目模式' }}</strong>
          <p class="summary-help">
            {{ requestedSceneId ? sceneLabel(requestedSceneId) : '可查看全部场景与项目级轨道。' }}
          </p>
        </section>
        <section class="summary-card">
          <span class="summary-label">候选</span>
          <strong class="summary-value">{{ totalCount }}</strong>
          <p class="summary-help">
            已确认 {{ confirmedCount }} · 候选 {{ candidateCount }} · 已归档 {{ archivedCount }}
          </p>
        </section>
        <section class="summary-card">
          <span class="summary-label">素材</span>
          <strong class="summary-value">{{ scenes.length }} / {{ characters.length }}</strong>
            <p class="summary-help">项目对白音色 {{ lockedVoiceCount }} / {{ voiceBindingSummary.total }} 已绑定</p>
        </section>
      </div>

      <section class="panel voice-cast-panel">
        <div class="panel-head">
          <div>
            <h2>角色音色管理</h2>
            <p class="panel-sub">项目对白角色 {{ lockedVoiceCount }} / {{ voiceBindingSummary.total }} 已完成绑定</p>
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
              <strong>{{ item.selectedProfile?.displayName || (item.character.referenceAudioUrl ? '自定义参考音频' : item.recommendations[0]?.displayName || '暂无推荐') }}</strong>
              <span>{{ item.selectedProfile ? `${item.selectedProfile.voiceId} · ${item.selectedProfile.modelName}` : item.character.referenceAudioUrl ? '参考音频已锁定' : '需要试听确认' }}</span>
            </div>
            <span class="voice-cast-status" :class="item.ready ? 'ready' : !voiceBindingSummary.speakerNames.includes(item.character.name) ? 'inactive' : 'pending'">
              {{ item.ready ? '已锁定' : !voiceBindingSummary.speakerNames.includes(item.character.name) ? '项目未出声' : '待确认' }}
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
              <div class="field control-field">
                <span>轨道类型</span>
                <div
                  class="picker-shell"
                  :class="{ open: isPickerOpen('track') }"
                  @focusout="onPickerBlur($event, 'track')"
                >
                  <button
                    class="picker-trigger"
                    type="button"
                    :aria-expanded="isPickerOpen('track')"
                    aria-haspopup="listbox"
                    @click="togglePicker('track')"
                  >
                    <span class="picker-value">
                      <span class="material-symbols-outlined">{{ selectedTrackPickerOption?.icon || 'graphic_eq' }}</span>
                      <strong>{{ selectedTrackPickerOption?.label || '请选择轨道' }}</strong>
                    </span>
                    <span class="material-symbols-outlined picker-chevron">expand_more</span>
                  </button>
                  <Transition name="picker-menu">
                    <div v-if="isPickerOpen('track')" class="picker-menu" role="listbox">
                      <button
                        v-for="option in trackPickerOptions"
                        :key="option.value"
                        class="picker-option"
                        :class="{ selected: option.value === formTrackType, disabled: option.disabled }"
                        type="button"
                        role="option"
                        :aria-selected="option.value === formTrackType"
                        :disabled="option.disabled"
                        @click="onPick('track', option)"
                      >
                        <span class="material-symbols-outlined">{{ option.icon }}</span>
                        <span>
                          <strong>{{ option.label }}</strong>
                          <small>{{ option.meta }}</small>
                        </span>
                      </button>
                    </div>
                  </Transition>
                </div>
              </div>

              <div class="field control-field">
                <span>场景来源</span>
                <div
                  class="picker-shell"
                  :class="{ open: isPickerOpen('scene') }"
                  @focusout="onPickerBlur($event, 'scene')"
                >
                  <button
                    class="picker-trigger"
                    type="button"
                    :aria-expanded="isPickerOpen('scene')"
                    aria-haspopup="listbox"
                    @click="togglePicker('scene')"
                  >
                    <span class="picker-value">
                      <strong>{{ selectedScenePickerOption?.label || '请选择场景来源' }}</strong>
                      <small>{{ selectedScenePickerOption?.meta }}</small>
                    </span>
                    <span class="material-symbols-outlined picker-chevron">expand_more</span>
                  </button>
                  <Transition name="picker-menu">
                    <div v-if="isPickerOpen('scene')" class="picker-menu" role="listbox">
                      <button
                        v-for="option in scenePickerOptions"
                        :key="option.value"
                        class="picker-option"
                        :class="{ selected: option.value === formSceneId }"
                        type="button"
                        role="option"
                        :aria-selected="option.value === formSceneId"
                        @click="onPick('scene', option)"
                      >
                        <span>
                          <strong>{{ option.label }}</strong>
                          <small>{{ option.meta }}</small>
                        </span>
                      </button>
                    </div>
                  </Transition>
                </div>
              </div>

              <div class="field control-field">
                <span>分镜定位</span>
                <div
                  class="picker-shell"
                  :class="{ open: isPickerOpen('storyboard'), disabled: !storyboardEnabled || !formSceneId }"
                  @focusout="onPickerBlur($event, 'storyboard')"
                >
                  <button
                    class="picker-trigger"
                    type="button"
                    :aria-expanded="isPickerOpen('storyboard')"
                    aria-haspopup="listbox"
                    :disabled="!storyboardEnabled || !formSceneId"
                    @click="togglePicker('storyboard', !storyboardEnabled || !formSceneId)"
                  >
                    <span class="picker-value">
                      <strong>{{ selectedStoryboardPickerOption?.label || '请选择分镜' }}</strong>
                      <small>{{ selectedStoryboardPickerOption?.meta }}</small>
                    </span>
                    <span class="material-symbols-outlined picker-chevron">expand_more</span>
                  </button>
                  <Transition name="picker-menu">
                    <div v-if="isPickerOpen('storyboard')" class="picker-menu" role="listbox">
                      <button
                        v-for="option in storyboardPickerOptions"
                        :key="option.value"
                        class="picker-option"
                        :class="{ selected: option.value === formStoryboardId }"
                        type="button"
                        role="option"
                        :aria-selected="option.value === formStoryboardId"
                        @click="onPick('storyboard', option)"
                      >
                        <span>
                          <strong>{{ option.label }}</strong>
                          <small>{{ option.meta }}</small>
                        </span>
                      </button>
                    </div>
                  </Transition>
                </div>
              </div>

              <div class="field control-field">
                <span>角色来源</span>
                <div
                  class="picker-shell"
                  :class="{ open: isPickerOpen('character'), disabled: !characterEnabled }"
                  @focusout="onPickerBlur($event, 'character')"
                >
                  <button
                    class="picker-trigger"
                    type="button"
                    :aria-expanded="isPickerOpen('character')"
                    aria-haspopup="listbox"
                    :disabled="!characterEnabled"
                    @click="togglePicker('character', !characterEnabled)"
                  >
                    <span class="picker-value">
                      <strong>{{ selectedCharacterPickerOption?.label || '请选择角色' }}</strong>
                      <small>{{ selectedCharacterPickerOption?.meta }}</small>
                    </span>
                    <span class="material-symbols-outlined picker-chevron">expand_more</span>
                  </button>
                  <Transition name="picker-menu">
                    <div v-if="isPickerOpen('character')" class="picker-menu" role="listbox">
                      <button
                        v-for="option in characterPickerOptions"
                        :key="option.value"
                        class="picker-option"
                        :class="{ selected: option.value === formCharacterId, disabled: option.disabled }"
                        type="button"
                        role="option"
                        :aria-selected="option.value === formCharacterId"
                        :disabled="option.disabled"
                        @click="onPick('character', option)"
                      >
                        <span>
                          <strong>{{ option.label }}</strong>
                          <small>{{ option.meta }}</small>
                        </span>
                      </button>
                    </div>
                  </Transition>
                </div>
              </div>

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

              <div class="field control-field">
                <span>{{ formTrackType === 'dialogue' ? '角色主音色' : '旁白音色' }}</span>
                <input
                  v-if="formTrackType === 'dialogue'"
                  :value="selectedCharacterVoiceCast?.selectedProfile?.displayName || '未锁定音色'"
                  type="text"
                  disabled
                />
                <div
                  v-else
                  class="picker-shell"
                  :class="{ open: isPickerOpen('voice'), disabled: !voiceEnabled }"
                  @focusout="onPickerBlur($event, 'voice')"
                >
                  <button
                    class="picker-trigger"
                    type="button"
                    :aria-expanded="isPickerOpen('voice')"
                    aria-haspopup="listbox"
                    :disabled="!voiceEnabled"
                    @click="togglePicker('voice', !voiceEnabled)"
                  >
                    <span class="picker-value">
                      <strong>{{ selectedVoicePickerOption?.label || '请选择旁白音色' }}</strong>
                      <small>{{ selectedVoicePickerOption?.meta }}</small>
                    </span>
                    <span class="material-symbols-outlined picker-chevron">expand_more</span>
                  </button>
                  <Transition name="picker-menu">
                    <div v-if="isPickerOpen('voice')" class="picker-menu" role="listbox">
                      <button
                        v-for="option in voicePickerOptions"
                        :key="option.value"
                        class="picker-option"
                        :class="{ selected: option.value === formVoiceProfileKey }"
                        type="button"
                        role="option"
                        :aria-selected="option.value === formVoiceProfileKey"
                        @click="onPick('voice', option)"
                      >
                        <span>
                          <strong>{{ option.label }}</strong>
                          <small>{{ option.meta }}</small>
                        </span>
                      </button>
                    </div>
                  </Transition>
                </div>
              </div>

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

          <section class="panel candidates-panel">
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

              <div class="field control-field">
                <span>轨道筛选</span>
                <div
                  class="picker-shell"
                  :class="{ open: isPickerOpen('filterTrack') }"
                  @focusout="onPickerBlur($event, 'filterTrack')"
                >
                  <button
                    class="picker-trigger"
                    type="button"
                    :aria-expanded="isPickerOpen('filterTrack')"
                    aria-haspopup="listbox"
                    @click="togglePicker('filterTrack')"
                  >
                    <span class="picker-value">
                      <span class="material-symbols-outlined">
                        {{ selectedFilterTrackPickerOption?.icon || 'tune' }}
                      </span>
                      <strong>{{ selectedFilterTrackPickerOption?.label || '全部轨道' }}</strong>
                    </span>
                    <span class="material-symbols-outlined picker-chevron">expand_more</span>
                  </button>
                  <Transition name="picker-menu">
                    <div v-if="isPickerOpen('filterTrack')" class="picker-menu" role="listbox">
                      <button
                        v-for="option in filterTrackPickerOptions"
                        :key="option.value"
                        class="picker-option"
                        :class="{ selected: option.value === filterTrackType }"
                        type="button"
                        role="option"
                        :aria-selected="option.value === filterTrackType"
                        @click="onPick('filterTrack', option)"
                      >
                        <span class="material-symbols-outlined">{{ option.icon || 'select_all' }}</span>
                        <span>
                          <strong>{{ option.label }}</strong>
                          <small>{{ option.meta }}</small>
                        </span>
                      </button>
                    </div>
                  </Transition>
                </div>
              </div>

              <div class="field control-field">
                <span>场景筛选</span>
                <div
                  class="picker-shell"
                  :class="{ open: isPickerOpen('filterScene') }"
                  @focusout="onPickerBlur($event, 'filterScene')"
                >
                  <button
                    class="picker-trigger"
                    type="button"
                    :aria-expanded="isPickerOpen('filterScene')"
                    aria-haspopup="listbox"
                    @click="togglePicker('filterScene')"
                  >
                    <span class="picker-value">
                      <strong>{{ selectedFilterScenePickerOption?.label || '全部场景 / 项目级' }}</strong>
                      <small>{{ selectedFilterScenePickerOption?.meta }}</small>
                    </span>
                    <span class="material-symbols-outlined picker-chevron">expand_more</span>
                  </button>
                  <Transition name="picker-menu">
                    <div v-if="isPickerOpen('filterScene')" class="picker-menu" role="listbox">
                      <button
                        v-for="option in filterScenePickerOptions"
                        :key="option.value"
                        class="picker-option"
                        :class="{ selected: String(option.value) === String(filterSceneId) }"
                        type="button"
                        role="option"
                        :aria-selected="String(option.value) === String(filterSceneId)"
                        @click="onPick('filterScene', option)"
                      >
                        <span>
                          <strong>{{ option.label }}</strong>
                          <small>{{ option.meta }}</small>
                        </span>
                      </button>
                    </div>
                  </Transition>
                </div>
              </div>

              <div class="field control-field">
                <span>状态筛选</span>
                <div
                  class="picker-shell"
                  :class="{ open: isPickerOpen('filterStatus') }"
                  @focusout="onPickerBlur($event, 'filterStatus')"
                >
                  <button
                    class="picker-trigger"
                    type="button"
                    :aria-expanded="isPickerOpen('filterStatus')"
                    aria-haspopup="listbox"
                    @click="togglePicker('filterStatus')"
                  >
                    <span class="picker-value">
                      <strong>{{ selectedFilterStatusPickerOption?.label || '全部状态' }}</strong>
                      <small>{{ selectedFilterStatusPickerOption?.meta }}</small>
                    </span>
                    <span class="material-symbols-outlined picker-chevron">expand_more</span>
                  </button>
                  <Transition name="picker-menu">
                    <div v-if="isPickerOpen('filterStatus')" class="picker-menu" role="listbox">
                      <button
                        v-for="option in filterStatusPickerOptions"
                        :key="option.value"
                        class="picker-option"
                        :class="{ selected: option.value === filterStatus }"
                        type="button"
                        role="option"
                        :aria-selected="option.value === filterStatus"
                        @click="onPick('filterStatus', option)"
                      >
                        <span>
                          <strong>{{ option.label }}</strong>
                          <small>{{ option.meta }}</small>
                        </span>
                      </button>
                    </div>
                  </Transition>
                </div>
              </div>
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
              <div class="inspector-hero">
                <div class="inspector-status-line">
                  <span class="status-chip" :class="selectedAudio.status">{{ statusLabel(selectedAudio.status) }}</span>
                  <span class="status-chip neutral">{{ trackLabel(selectedAudio.trackType) }}</span>
                  <span class="status-chip neutral">V{{ selectedAudio.versionNo }}</span>
                </div>
                <h3 class="inspector-title">{{ selectedAudio.title }}</h3>
                <p class="inspector-sub">
                  {{ sceneLabel(selectedAudio.sceneId, selectedAudio.sceneNo, selectedAudio.sceneTitle) }}
                  <span v-if="selectedAudio.shotNo"> · {{ selectedAudio.shotNo }}</span>
                  <span v-if="selectedAudio.characterId">
                    · {{ characterLabel(selectedAudio.characterId, selectedAudio.characterName) }}
                  </span>
                </p>
                <div class="inspector-quick-grid">
                  <div>
                    <span>时长</span>
                    <strong>{{ formatDuration(selectedAudio.durationSeconds) }}</strong>
                  </div>
                  <div>
                    <span>音色</span>
                    <strong :title="selectedAudio.voiceName || '未设置'">{{ selectedAudio.voiceName || '—' }}</strong>
                  </div>
                  <div>
                    <span>模型</span>
                    <strong :title="selectedAudio.modelName || '未设置'">{{ selectedAudio.modelName || '—' }}</strong>
                  </div>
                </div>
              </div>

              <div class="inspector-player">
                <div class="inspector-section-head">
                  <span class="inspector-section-label">试听预览</span>
                  <span>{{ selectedAudio.audioUrl ? '可播放' : '缺少音频地址' }}</span>
                </div>
                <audio class="audio-player" controls preload="none" :src="selectedAudio.audioUrl"></audio>
              </div>

              <div class="placement-panel">
                <div class="placement-head">
                  <div class="placement-title">时间线定位</div>
                  <p>确认主版本前，先把音频落到正确分镜和起始秒。</p>
                </div>
                <div class="field control-field">
                  <span>绑定分镜</span>
                  <div
                    class="picker-shell placement-picker"
                    :class="{ open: isPickerOpen('placementStoryboard') }"
                    @focusout="onPickerBlur($event, 'placementStoryboard')"
                  >
                    <button
                      class="picker-trigger"
                      type="button"
                      :aria-expanded="isPickerOpen('placementStoryboard')"
                      aria-haspopup="listbox"
                      @click="togglePicker('placementStoryboard')"
                    >
                      <span class="picker-value">
                        <strong>{{ selectedPlacementStoryboardPickerOption?.label || '不绑定具体分镜' }}</strong>
                        <small>{{ selectedPlacementStoryboardPickerOption?.meta }}</small>
                      </span>
                      <span class="material-symbols-outlined picker-chevron">expand_more</span>
                    </button>
                    <Transition name="picker-menu">
                      <div v-if="isPickerOpen('placementStoryboard')" class="picker-menu" role="listbox">
                        <button
                          v-for="option in placementStoryboardPickerOptions"
                          :key="option.value"
                          class="picker-option"
                          :class="{ selected: String(option.value) === String(placementStoryboardId) }"
                          type="button"
                          role="option"
                          :aria-selected="String(option.value) === String(placementStoryboardId)"
                          @click="onPick('placementStoryboard', option)"
                        >
                          <span>
                            <strong>{{ option.label }}</strong>
                            <small>{{ option.meta }}</small>
                          </span>
                        </button>
                      </div>
                    </Transition>
                  </div>
                </div>
                <label class="field">
                  <span>起始微调（秒）</span>
                  <input v-model.number="placementOffsetSeconds" min="0" max="60" step="0.1" type="number" />
                </label>
                <button class="primary-btn compact" type="button" :disabled="savingPlacement" @click="savePlacement">
                  {{ savingPlacement ? '保存中...' : '保存定位' }}
                </button>
              </div>

              <div class="inspector-waveform">
                <div class="inspector-section-head">
                  <span class="inspector-section-label">波形概览</span>
                  <span>预览强弱变化</span>
                </div>
                <div class="candidate-bars inspector-bars">
                  <span
                    v-for="(bar, index) in waveformBars(selectedAudio)"
                    :key="`inspector-${selectedAudio.id}-${index}`"
                    class="bar"
                    :style="{ height: `${bar}px` }"
                  ></span>
                </div>
              </div>

              <div class="inspector-meta">
                <span class="inspector-section-label">音频信息</span>
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
                    <strong :title="selectedAudio.voiceName || '未设置'">{{ selectedAudio.voiceName || '—' }}</strong>
                  </div>
                  <div>
                    <span class="inspector-label">模型</span>
                    <strong :title="selectedAudio.modelName || '未设置'">{{ selectedAudio.modelName || '—' }}</strong>
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
  --audio-bg: #10120f;
  --audio-panel: rgba(22, 24, 21, 0.94);
  --audio-panel-strong: #191b17;
  --audio-line: rgba(213, 184, 142, 0.18);
  --audio-line-strong: rgba(245, 158, 11, 0.48);
  --audio-text: #f4eee5;
  --audio-muted: #b9a58d;
  --audio-soft: #8f7c68;
  --audio-accent: #f59e0b;
  --audio-accent-2: #fb923c;
  --audio-ease: cubic-bezier(0.16, 1, 0.3, 1);
  flex: 0 0 auto;
  height: max-content;
  min-height: 100%;
  background:
    radial-gradient(circle at 12% 8%, rgba(245, 158, 11, 0.14), transparent 28%),
    radial-gradient(circle at 94% 0%, rgba(45, 212, 191, 0.06), transparent 22%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.018), transparent 280px),
    var(--audio-bg);
  color: var(--audio-text);
  padding: 28px;
}

.page-top {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: flex-start;
  margin-bottom: 20px;
}

.page-title {
  margin: 0;
  color: #fff6ea;
  font-size: clamp(32px, 4vw, 48px);
  font-weight: 750;
  letter-spacing: 0;
  line-height: 1.05;
  text-wrap: balance;
}

.page-subtitle {
  margin: 10px 0 0;
  max-width: 70ch;
  color: #d6c0a4;
  font-size: 16px;
  line-height: 1.75;
}

.page-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.page-meta-row span {
  border: 1px solid rgba(213, 184, 142, 0.2);
  background: rgba(255, 255, 255, 0.035);
  color: #d9c5aa;
  padding: 6px 9px;
  font-size: 12px;
  line-height: 1;
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
  gap: 10px;
  margin-bottom: 20px;
}

.summary-card,
.panel,
.state-card {
  border: 1px solid var(--audio-line);
  background: var(--audio-panel);
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.22);
}

.summary-card {
  min-width: 0;
  padding: 14px 15px;
}

.summary-card.highlight {
  background: linear-gradient(135deg, rgba(42, 27, 14, 0.96), rgba(23, 24, 21, 0.92));
}

.summary-label {
  display: block;
  color: var(--audio-soft);
  font-size: 12px;
  font-weight: 650;
}

.summary-value {
  display: block;
  overflow: hidden;
  margin-top: 8px;
  color: #fff4e8;
  font-size: 21px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-help {
  overflow: hidden;
  margin: 7px 0 0;
  color: var(--audio-muted);
  font-size: 13px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.main-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
  gap: 20px;
  align-items: start;
}

.inspector-shell {
  align-self: start;
  min-height: 0;
}

.workspace-shell,
.group-stack {
  display: grid;
  gap: 20px;
}

.panel {
  padding: 20px;
}

.controls-panel {
  position: relative;
  overflow: visible;
  border-color: rgba(245, 158, 11, 0.24);
  background:
    linear-gradient(135deg, rgba(245, 158, 11, 0.08), transparent 34%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.026), transparent 180px),
    rgba(18, 20, 17, 0.96);
}

.controls-panel::before {
  position: absolute;
  inset: 0;
  pointer-events: none;
  border: 1px solid rgba(255, 255, 255, 0.025);
  content: '';
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
  color: var(--audio-muted);
  line-height: 1.6;
}

.voice-cast-panel {
  margin-bottom: 20px;
}

.voice-cast-list {
  border: 1px solid var(--audio-line);
}

.voice-cast-row {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) minmax(130px, 0.65fr) minmax(240px, 1.35fr) 74px 38px;
  gap: 16px;
  align-items: center;
  min-height: 68px;
  padding: 12px 14px;
  background: rgba(13, 15, 13, 0.62);
  transition:
    background 180ms var(--audio-ease),
    border-color 180ms var(--audio-ease);
}

.voice-cast-row:hover {
  background: rgba(245, 158, 11, 0.055);
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
  color: var(--audio-muted);
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

.voice-cast-status.inactive {
  border-color: rgba(148, 163, 184, 0.28);
  background: rgba(148, 163, 184, 0.08);
  color: #cbd5e1;
}

.icon-btn {
  display: inline-flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(203, 181, 155, 0.22);
  color: #f6efe5;
  transition:
    border-color 180ms var(--audio-ease),
    color 180ms var(--audio-ease),
    transform 180ms var(--audio-ease);
}

.icon-btn:hover {
  border-color: rgba(245, 158, 11, 0.6);
  color: #ffcb8e;
  transform: translateX(2px);
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

.control-field {
  min-width: 0;
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
  transition:
    border-color 180ms var(--audio-ease),
    box-shadow 180ms var(--audio-ease),
    background 180ms var(--audio-ease);
}

.field input {
  min-height: 58px;
}

.field input:hover,
.field select:hover,
.field textarea:hover {
  border-color: rgba(245, 158, 11, 0.36);
  background: rgba(18, 20, 17, 0.95);
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

.picker-shell {
  position: relative;
  z-index: 1;
  min-width: 0;
}

.picker-shell.open {
  z-index: 30;
}

.picker-trigger {
  display: flex;
  width: 100%;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid rgba(213, 184, 142, 0.22);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.008)),
    rgba(9, 11, 9, 0.92);
  color: #fff6ea;
  padding: 11px 13px 11px 16px;
  text-align: left;
  transition:
    border-color 180ms var(--audio-ease),
    background 180ms var(--audio-ease),
    box-shadow 180ms var(--audio-ease),
    transform 180ms var(--audio-ease);
}

.picker-trigger:hover:not(:disabled),
.picker-shell.open .picker-trigger {
  border-color: rgba(255, 183, 125, 0.72);
  background:
    linear-gradient(180deg, rgba(255, 183, 125, 0.08), rgba(255, 255, 255, 0.012)),
    rgba(12, 13, 11, 0.98);
  box-shadow:
    0 12px 28px rgba(0, 0, 0, 0.22),
    0 0 0 1px rgba(245, 158, 11, 0.09) inset;
}

.picker-trigger:active:not(:disabled) {
  transform: translateY(1px);
}

.picker-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.54;
}

.picker-value {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.picker-value:has(.material-symbols-outlined) {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
}

.picker-value .material-symbols-outlined {
  color: #ffb77d;
  font-size: 18px;
}

.picker-value strong {
  overflow: hidden;
  color: #fff8ee;
  font-size: 15px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-value small {
  overflow: hidden;
  color: var(--audio-muted);
  font-size: 11px;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-chevron {
  flex: 0 0 auto;
  color: #eac59c;
  font-size: 21px;
  transition: transform 220ms var(--audio-ease);
}

.picker-shell.open .picker-chevron {
  transform: rotate(180deg);
}

.picker-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  right: 0;
  overflow: hidden auto;
  max-height: 280px;
  border: 1px solid rgba(255, 183, 125, 0.42);
  background:
    linear-gradient(180deg, rgba(33, 35, 30, 0.98), rgba(18, 20, 17, 0.98)),
    #171814;
  box-shadow:
    0 24px 54px rgba(0, 0, 0, 0.48),
    0 0 0 1px rgba(255, 255, 255, 0.035) inset;
  padding: 6px;
  scrollbar-gutter: stable;
}

.picker-option {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 10px;
  border: 0;
  background: transparent;
  color: #f7efe4;
  padding: 10px 11px;
  text-align: left;
  transition:
    background 160ms var(--audio-ease),
    color 160ms var(--audio-ease),
    transform 160ms var(--audio-ease);
}

.picker-option + .picker-option {
  border-top: 1px solid rgba(213, 184, 142, 0.1);
}

.picker-option:hover:not(:disabled),
.picker-option:focus-visible {
  background: rgba(245, 158, 11, 0.1);
  color: #fff8ee;
  transform: translateX(2px);
}

.picker-option.selected {
  background: rgba(245, 158, 11, 0.16);
  color: #ffd39e;
}

.picker-option.disabled,
.picker-option:disabled {
  cursor: not-allowed;
  opacity: 0.46;
}

.picker-option .material-symbols-outlined {
  margin-top: 1px;
  color: #ffb77d;
  font-size: 18px;
}

.picker-option span:not(.material-symbols-outlined) {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.picker-option strong,
.picker-option small {
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-option strong {
  font-size: 14px;
  line-height: 1.25;
  white-space: nowrap;
}

.picker-option small {
  color: #baa68e;
  font-size: 11px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.picker-menu-enter-active,
.picker-menu-leave-active {
  transform-origin: top;
  transition:
    opacity 180ms var(--audio-ease),
    transform 180ms var(--audio-ease),
    filter 180ms var(--audio-ease);
}

.picker-menu-enter-from,
.picker-menu-leave-to {
  opacity: 0;
  filter: blur(6px);
  transform: translateY(-6px) scaleY(0.96);
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
  border: 1px solid var(--audio-line);
  background: rgba(12, 14, 12, 0.72);
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
  grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.audio-card {
  border: 1px solid rgba(203, 181, 155, 0.16);
  background: rgba(23, 24, 21, 0.92);
  padding: 16px;
  transition:
    border-color 180ms var(--audio-ease),
    background 180ms var(--audio-ease),
    transform 180ms var(--audio-ease),
    box-shadow 180ms var(--audio-ease);
}

.audio-card:hover {
  border-color: rgba(245, 158, 11, 0.34);
  background: rgba(26, 28, 24, 0.96);
  transform: translateY(-1px);
}

.audio-card.active {
  border-color: rgba(245, 158, 11, 0.62);
  box-shadow:
    0 0 0 1px rgba(245, 158, 11, 0.18),
    0 18px 34px rgba(0, 0, 0, 0.24);
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
  font-weight: 650;
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
  flex: 0 0 5px;
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
  top: 16px;
  max-height: calc(100dvh - 96px);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.sticky-panel::-webkit-scrollbar {
  width: 6px;
}

.sticky-panel::-webkit-scrollbar-thumb {
  border: 1px solid transparent;
  border-radius: 999px;
  background: rgba(112, 93, 75, 0.78);
  background-clip: padding-box;
}

.placement-panel {
  display: grid;
  gap: 10px;
  border: 1px solid rgba(245, 158, 11, 0.22);
  background:
    linear-gradient(135deg, rgba(245, 158, 11, 0.08), rgba(255, 255, 255, 0.018)),
    rgba(17, 18, 15, 0.82);
  padding: 14px;
}

.placement-picker .picker-trigger {
  min-height: 46px;
  padding: 9px 10px 9px 12px;
}

.placement-picker .picker-menu {
  max-height: 240px;
}

.placement-head {
  display: grid;
  gap: 4px;
}

.placement-title {
  color: #f7cf8d;
  font-size: 13px;
  font-weight: 700;
}

.placement-head p {
  margin: 0;
  color: var(--audio-muted);
  font-size: 12px;
  line-height: 1.45;
}

.inspector-body {
  display: grid;
  gap: 16px;
}

.inspector-section-label {
  display: block;
  color: #a9937a;
  font-size: 11px;
  letter-spacing: 0.12em;
  line-height: 1.4;
  text-transform: uppercase;
}

.inspector-hero,
.inspector-player,
.inspector-waveform,
.inspector-meta {
  min-width: 0;
}

.inspector-hero {
  border: 1px solid rgba(245, 158, 11, 0.22);
  background:
    radial-gradient(circle at top right, rgba(245, 158, 11, 0.16), transparent 44%),
    rgba(17, 18, 15, 0.9);
  padding: 14px;
}

.inspector-status-line,
.inspector-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.inspector-status-line {
  flex-wrap: wrap;
  justify-content: flex-start;
  margin-bottom: 10px;
}

.inspector-section-head span:last-child {
  color: var(--audio-soft);
  font-size: 12px;
}

.inspector-title {
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
  text-wrap: balance;
}

.inspector-sub {
  margin: 8px 0 0;
  color: #af9981;
  line-height: 1.6;
}

.inspector-quick-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
}

.inspector-quick-grid > div {
  min-width: 0;
  border: 1px solid rgba(203, 181, 155, 0.14);
  background: rgba(0, 0, 0, 0.16);
  padding: 9px;
}

.inspector-quick-grid span {
  display: block;
  color: var(--audio-soft);
  font-size: 11px;
  margin-bottom: 4px;
}

.inspector-quick-grid strong {
  display: block;
  overflow: hidden;
  color: #fff4e8;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
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

@media (min-width: 1280px) {
  .audio-page {
    --audio-inspector-width: clamp(360px, 31vw, 480px);
    padding-right: calc(var(--audio-inspector-width) + 20px);
  }

  .inspector-shell {
    position: fixed;
    top: 80px;
    right: 24px;
    z-index: 2;
    width: var(--audio-inspector-width);
  }

  .main-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .sticky-panel {
    display: flex;
    flex-direction: column;
    height: calc(100dvh - 96px);
    max-height: none;
    padding: 0;
    overflow: hidden;
    border: 1px solid rgba(234, 198, 140, 0.24);
    border-radius: 8px;
    background: #171814;
    box-shadow:
      -20px 24px 60px rgba(0, 0, 0, 0.28),
      0 0 0 1px rgba(255, 255, 255, 0.02) inset;
  }

  .sticky-panel .panel-head {
    flex: 0 0 auto;
    min-height: 82px;
    margin: 0;
    padding: 18px 20px 14px;
    border-bottom: 1px solid rgba(203, 181, 155, 0.14);
    background: #171814;
  }

  .sticky-panel .panel-head h2 {
    font-size: 18px;
    letter-spacing: 0;
  }

  .sticky-panel .panel-sub {
    font-size: 12px;
    line-height: 1.45;
  }

  .inspector-body {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    gap: 0;
    padding: 0 20px 18px;
  }

  .inspector-body::-webkit-scrollbar {
    width: 5px;
  }

  .inspector-body::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: rgba(112, 93, 75, 0.72);
  }

  .inspector-section-label {
    color: #9f927e;
    font-size: 10px;
    letter-spacing: 0.16em;
  }

  .inspector-body .status-chip {
    border-radius: 5px;
  }

  .inspector-hero {
    margin-top: 16px;
    padding: 13px;
  }

  .inspector-title {
    font-size: 20px;
    line-height: 1.2;
  }

  .inspector-sub {
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.45;
  }

  .inspector-player {
    padding: 14px 0;
    border-bottom: 1px solid rgba(203, 181, 155, 0.12);
  }

  .sticky-panel .audio-player {
    display: block;
    margin-top: 8px;
    height: 42px;
  }

  .placement-panel {
    margin-top: 14px;
    grid-template-columns: minmax(0, 1.25fr) minmax(92px, 0.7fr) auto;
    align-items: end;
    gap: 8px;
    padding: 10px;
    border-radius: 8px;
    background: #211b10;
  }

  .placement-title {
    color: #f2c579;
    letter-spacing: 0.02em;
  }

  .placement-head {
    grid-column: 1 / -1;
  }

  .placement-panel .field {
    gap: 5px;
    font-size: 12px;
  }

  .placement-panel .field input,
  .placement-panel .field select {
    min-height: 36px;
    padding: 8px 9px;
  }

  .placement-panel .picker-trigger {
    min-height: 36px;
    padding: 8px 9px;
  }

  .placement-panel .picker-value strong {
    font-size: 12px;
  }

  .placement-panel .picker-value small {
    font-size: 10px;
  }

  .placement-panel .primary-btn {
    align-self: end;
    white-space: nowrap;
  }

  .inspector-waveform {
    padding: 14px 0;
    border-bottom: 1px solid rgba(203, 181, 155, 0.12);
  }

  .inspector-bars {
    height: 44px;
    margin: 8px 0 0;
    padding: 0;
  }

  .inspector-meta {
    padding: 14px 0 0;
  }

  .inspector-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px 10px;
    margin-top: 8px;
    padding: 10px 0;
  }

  .inspector-grid > div {
    min-width: 0;
  }

  .inspector-label {
    margin-bottom: 3px;
    font-size: 11px;
  }

  .inspector-grid strong {
    display: block;
    overflow: hidden;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .inspector-note {
    margin-top: 14px;
    padding: 12px;
    background: #11120f;
  }

  .inspector-note h4 {
    margin-bottom: 4px;
    font-size: 13px;
  }

  .inspector-note p {
    font-size: 12px;
    line-height: 1.5;
  }

  .stack-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    position: sticky;
    bottom: 0;
    gap: 8px;
    margin: 14px -20px -18px;
    padding: 12px 20px 18px;
    border-top: 1px solid rgba(203, 181, 155, 0.14);
    background: #171814;
  }

  .stack-actions > :only-child {
    grid-column: 1 / -1;
  }

  .stack-actions .primary-btn,
  .stack-actions .ghost-btn {
    padding: 8px 10px;
    font-size: 12px;
  }
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

.message.rework {
  border-color: rgba(255, 183, 125, 0.42);
  background: rgba(255, 183, 125, 0.1);
  color: #ffd9b0;
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
  min-height: 38px;
  transition:
    border-color 180ms var(--audio-ease),
    background 180ms var(--audio-ease),
    color 180ms var(--audio-ease),
    opacity 180ms var(--audio-ease),
    transform 180ms var(--audio-ease);
}

.primary-btn {
  background: linear-gradient(135deg, #f59e0b, #ea580c);
  border-color: transparent;
  color: #1f1304;
  font-weight: 700;
}

.ghost-btn {
  background: rgba(255, 255, 255, 0.04);
}

.primary-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #ffb347, #f97316);
  transform: translateY(-1px);
}

.ghost-btn:hover:not(:disabled) {
  border-color: rgba(245, 158, 11, 0.55);
  background: rgba(245, 158, 11, 0.08);
  color: #ffd3a3;
}

.primary-btn:active:not(:disabled),
.ghost-btn:active:not(:disabled) {
  transform: translateY(1px);
}

.primary-btn:disabled,
.ghost-btn:disabled {
  cursor: not-allowed;
  opacity: 0.52;
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

@media (min-width: 1024px) and (max-width: 1279px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .main-grid {
    grid-template-columns: minmax(0, 1fr) minmax(320px, 360px);
  }

  .sticky-panel {
    max-height: calc(100dvh - 104px);
  }

  .candidate-grid {
    grid-template-columns: 1fr;
  }

  .voice-cast-row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    padding: 12px 14px;
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

  .placement-panel {
    grid-template-columns: minmax(0, 1fr);
  }

  .placement-panel .primary-btn {
    width: 100%;
  }

  .inspector-quick-grid,
  .inspector-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 1023px) {
  .inspector-shell {
    position: static;
    width: auto;
  }

  .sticky-panel {
    max-height: none;
    overflow: visible;
  }

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
