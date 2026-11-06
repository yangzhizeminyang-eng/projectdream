type ScriptParseCharacter = { id: number | string }
type ScriptParseScene = { id: number | string }
type ScriptParseAssetNode = {
  nodeType: string
  refId?: number | string | null
  groupKey?: string | null
}

export function canReuseCurrentScriptAssets(input: {
  characters: ScriptParseCharacter[]
  scenes: ScriptParseScene[]
  nodes: ScriptParseAssetNode[]
}): boolean
