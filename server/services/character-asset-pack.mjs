const PACK_VIEWS = [
  { viewSetType: 'single', viewKey: null, viewLabel: '基础正面全身图', viewIndex: 1, x: 0, y: 0, width: 0.5, height: 1 },
  { viewSetType: 'character-face-closeup', viewKey: 'face', viewLabel: '脸部特写', viewIndex: 1, x: 0.5, y: 0, width: 0.5, height: 0.5 },
  { viewSetType: 'character-turnaround', viewKey: 'front', viewLabel: '正面', viewIndex: 1, x: 0.5, y: 0.5, width: 1 / 6, height: 0.5 },
  { viewSetType: 'character-turnaround', viewKey: 'side', viewLabel: '严格侧面', viewIndex: 2, x: 2 / 3, y: 0.5, width: 1 / 6, height: 0.5 },
  { viewSetType: 'character-turnaround', viewKey: 'back', viewLabel: '背面', viewIndex: 3, x: 5 / 6, y: 0.5, width: 1 / 6, height: 0.5 },
]

export function buildCharacterAssetPackDescriptors() {
  return PACK_VIEWS.map((item) => ({ ...item }))
}

export function buildCharacterAssetPackCropFilter(viewKey = '') {
  const descriptor = PACK_VIEWS.find((item) => String(item.viewKey || '__base__') === String(viewKey || '__base__'))
  if (!descriptor) throw new Error(`unknown character asset pack view: ${viewKey}`)
  return `crop=iw*${descriptor.width}:ih*${descriptor.height}:iw*${descriptor.x}:ih*${descriptor.y}`
}

export function validateCharacterAssetPackDescriptors(descriptors = PACK_VIEWS) {
  const items = Array.isArray(descriptors) ? descriptors : []
  const keys = items.map((item) => String(item.viewKey || '__base__'))
  const required = ['__base__', 'face', 'front', 'side', 'back']
  return {
    ready: required.every((key) => keys.includes(key)) && new Set(keys).size === required.length,
    missing: required.filter((key) => !keys.includes(key)),
  }
}
