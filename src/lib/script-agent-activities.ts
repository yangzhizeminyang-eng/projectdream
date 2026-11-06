export type ActivityForDedupe = {
  id: number | string
  actionKey: string
  stageKey: string
  status: string
}

export function dedupeRunningActivities<T extends ActivityForDedupe>(activities: T[]): T[] {
  const newestByAction = new Map<string, T>()
  const kept: T[] = []

  for (const activity of activities) {
    if (activity.status !== 'running') {
      kept.push(activity)
      continue
    }

    const key = `${activity.stageKey}:${activity.actionKey}`
    const current = newestByAction.get(key)
    if (!current || Number(activity.id) > Number(current.id)) {
      newestByAction.set(key, activity)
    }
  }

  return [...kept, ...newestByAction.values()].sort((a, b) => Number(a.id) - Number(b.id))
}
