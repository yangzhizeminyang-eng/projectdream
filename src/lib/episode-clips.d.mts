export function formatShotDuration(durationSeconds: number | null | undefined): string
export function formatAggregateDuration(durationSeconds: number | null | undefined): string

export interface EpisodeClipScene {
  id: number
  sceneNo?: number | null
  title?: string | null
  location?: string | null
  timeOfDay?: string | null
  mood?: string | null
  status?: string | null
  sortOrder?: number | null
}

export interface EpisodeClip<TShot> {
  id: number
  sceneNo: number
  title: string
  location: string
  timeOfDay: string
  mood: string
  status: string
  shots: TShot[]
  shotCount: number
  durationSeconds: number
}

export function buildEpisodeClips<TShot extends {
  sceneId: number
  shotNo?: string | number | null
  durationSeconds?: number | null
}>(
  scenes?: EpisodeClipScene[],
  shots?: TShot[],
): EpisodeClip<TShot>[]
