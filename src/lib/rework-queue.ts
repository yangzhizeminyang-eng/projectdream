export interface ReworkQueueItem {
  key: string
  kind: 'video' | 'audio'
  projectId: number
  sceneId: number
  storyboardId: number
  sceneNo: number
  shotNo: string
  candidateId: number
  versionNo: number
  status: 'queued' | 'in-progress' | 'completed'
  createdAt: string
  completedAt?: string
}

function storageKey(projectId: number): string {
  return `projectdream:rework-queue:${projectId}`
}

export function readReworkQueue(projectId: number): ReworkQueueItem[] {
  if (typeof window === 'undefined' || !projectId) return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(projectId)) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is ReworkQueueItem =>
      !!item &&
      typeof item.key === 'string' &&
      (item.kind === 'video' || item.kind === 'audio') &&
      Number(item.projectId) === projectId &&
      Number(item.storyboardId) > 0 &&
      Number(item.candidateId) > 0 &&
      (item.status === 'queued' || item.status === 'in-progress' || item.status === 'completed'),
    )
  } catch {
    return []
  }
}

export function writeReworkQueue(projectId: number, items: ReworkQueueItem[]): void {
  if (typeof window === 'undefined' || !projectId) return
  window.localStorage.setItem(storageKey(projectId), JSON.stringify(items))
}

export function enqueueReworkItems(
  projectId: number,
  items: Omit<ReworkQueueItem, 'status' | 'createdAt'>[],
): ReworkQueueItem[] {
  const current = readReworkQueue(projectId)
  const existing = new Set(current.map((item) => item.key))
  const next = [...current]
  for (const item of items) {
    if (existing.has(item.key)) continue
    existing.add(item.key)
    next.push({
      ...item,
      status: 'queued',
      createdAt: new Date().toISOString(),
    })
  }
  writeReworkQueue(projectId, next)
  return next
}

export function startNextReworkItem(projectId: number): ReworkQueueItem | null {
  const queue = readReworkQueue(projectId)
  const next = queue.find((item) => item.status === 'queued')
  if (!next) return null
  writeReworkQueue(
    projectId,
    queue.map((item) => ({
      ...item,
      status: item.key === next.key ? 'in-progress' : 'queued',
    })),
  )
  return { ...next, status: 'in-progress' }
}

export function claimReworkItem(
  projectId: number,
  candidateId: number,
  kind: ReworkQueueItem['kind'],
): ReworkQueueItem | null {
  const queue = readReworkQueue(projectId)
  const target = queue.find(
    (item) => item.candidateId === candidateId && item.kind === kind && item.status !== 'completed',
  )
  if (!target) return null

  const next = queue.map((item) =>
    item.key === target.key ? { ...item, status: 'in-progress' as const } : item,
  )
  writeReworkQueue(projectId, next)
  return { ...target, status: 'in-progress' }
}

export function completeReworkItem(
  projectId: number,
  candidateId: number,
  kind: ReworkQueueItem['kind'],
): ReworkQueueItem | null {
  const queue = readReworkQueue(projectId)
  const target = queue.find((item) => item.candidateId === candidateId && item.kind === kind)
  if (!target) return null

  const completedAt = new Date().toISOString()
  const next = queue.map((item) =>
    item.key === target.key
      ? { ...item, status: 'completed' as const, completedAt }
      : item,
  )
  writeReworkQueue(projectId, next)
  return { ...target, status: 'completed', completedAt }
}

export function clearReworkQueue(projectId: number): void {
  writeReworkQueue(projectId, [])
}
