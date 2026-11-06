export interface ClipRehearsalShotInput {
  storyboardId?: number
  id?: number
  sceneId?: number
  scene_id?: number
  shotNo?: string
  shot_no?: string
  visualPrompt?: string | null
  visual_prompt?: string | null
  imageUrl?: string
  image_url?: string
  endImageUrl?: string
  end_image_url?: string
  assetReference?: Record<string, unknown> | null
  asset_reference_json?: Record<string, unknown> | string | null
}

export interface ClipRehearsalReport {
  ready: boolean
  sceneId: number
  shotCount: number
  readyShotCount: number
  blockedShotCount: number
  videoJobsCreated: number
  shots: Array<{
    storyboardId: number
    shotNo: string
    blockers: string[]
    ready: boolean
    keyframes: { start: 'ready' | 'missing'; end: 'ready' | 'missing' }
    startUrl: string | null
    endUrl: string | null
  }>
  transitions: Array<{
    fromShotId: number
    toShotId: number
    status: 'scene-change' | 'ready-for-review' | 'blocked'
    hasPreviousTail: boolean
    hasNextStart: boolean
  }>
}

export function filterScenesForEpisode<T extends { episodeNo?: number | null; episode_no?: number | null }>(
  scenes: T[],
  episodeNo?: number | null,
): T[]

export function buildClipRehearsalReport(input: {
  sceneId: number
  shots: ClipRehearsalShotInput[]
}): ClipRehearsalReport
