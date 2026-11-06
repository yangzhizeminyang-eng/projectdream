export interface UnifiedStoryboardFields {
  visualPrompt?: string
  actionText?: string
  dialogueText?: string
  startVisualPrompt?: string
  endVisualPrompt?: string
}

export function buildUnifiedStoryboardPrompt(fields?: UnifiedStoryboardFields): string
export function parseUnifiedStoryboardPrompt(value?: string): Required<UnifiedStoryboardFields>
