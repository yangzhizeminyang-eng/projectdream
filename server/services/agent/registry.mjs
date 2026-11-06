const KEY_PATTERN = /^[a-z][a-z0-9-]{2,79}$/

function normalizeAdapter(adapter = {}) {
  const key = String(adapter.key || '').trim()
  if (!KEY_PATTERN.test(key)) {
    throw new Error('Agent adapter 必须提供合法的 key')
  }
  if (typeof adapter.execute !== 'function') {
    throw new Error(`Agent adapter ${key} 必须提供 execute`)
  }
  return {
    key,
    label: String(adapter.label || key).trim() || key,
    description: String(adapter.description || '').trim(),
    execute: adapter.execute,
  }
}

export function createAgentRegistry(initialAdapters = []) {
  const adapters = new Map()

  function register(adapter) {
    const normalized = normalizeAdapter(adapter)
    if (adapters.has(normalized.key)) {
      throw new Error(`Agent ${normalized.key} 已注册`)
    }
    adapters.set(normalized.key, normalized)
    return normalized
  }

  for (const adapter of initialAdapters) register(adapter)

  return {
    register,
    get(key) {
      return adapters.get(String(key || '').trim()) || null
    },
    has(key) {
      return adapters.has(String(key || '').trim())
    },
    list() {
      return [...adapters.values()].map(({ execute, ...metadata }) => metadata)
    },
  }
}
