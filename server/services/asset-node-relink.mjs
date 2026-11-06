function text(value) {
  return String(value ?? '').trim()
}

export function chooseSceneForRelink({ requestedSceneId, requestedLabel, scenes = [] } = {}) {
  const id = Number(requestedSceneId)
  if (Number.isSafeInteger(id) && id > 0) {
    return scenes.find((scene) => Number(scene?.id) === id) || null
  }

  const label = text(requestedLabel).toLocaleLowerCase('zh-CN')
  if (!label) return null
  return scenes.find((scene) => [scene?.title, scene?.location, scene?.summary]
    .map(text)
    .filter(Boolean)
    .some((value) => value.toLocaleLowerCase('zh-CN') === label)) || null
}
