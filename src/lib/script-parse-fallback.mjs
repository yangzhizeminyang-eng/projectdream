function positiveId(value) {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : 0
}

function hasNode(nodes, nodeType, id) {
  const groupPrefix = `${nodeType}:${id}`
  return nodes.some((node) => node.nodeType === nodeType && (
    positiveId(node.refId) === id
    || node.groupKey === groupPrefix
    || node.groupKey?.startsWith(`${groupPrefix}:`)
  ))
}

export function canReuseCurrentScriptAssets({ characters, scenes, nodes }) {
  if (!Array.isArray(characters) || !characters.length
    || !Array.isArray(scenes) || !scenes.length
    || !Array.isArray(nodes)) return false

  return characters.every((character) => {
    const id = positiveId(character.id)
    return id > 0 && hasNode(nodes, 'character', id)
  }) && scenes.every((scene) => {
    const id = positiveId(scene.id)
    return id > 0 && hasNode(nodes, 'scene', id)
  })
}
