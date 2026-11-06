export function buildTextModelHistory(
  currentModel: string,
  fields: Array<{ key: string; value?: string | null }>,
  stored: string[] = [],
): string[] {
  const candidates = [
    currentModel,
    ...fields
      .filter((field) => field.key.startsWith('AI_MODEL'))
      .map((field) => field.value || ''),
    ...stored,
  ]
  return [...new Set(candidates.map((value) => String(value).trim()).filter(Boolean))]
}
