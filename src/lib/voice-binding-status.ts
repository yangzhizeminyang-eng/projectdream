export type VoiceBindingCharacter = {
  name?: string | null
  voiceLocked?: boolean | null
  voiceProfileKey?: string | null
  referenceAudioUrl?: string | null
}

export type VoiceBindingState = 'ready' | 'pending' | 'none'

export type VoiceBindingShotContext = {
  allowedEntities?: string[] | null
  visualPrompt?: string | null
  dialogueText?: string | null
  primaryCharacterName?: string | null
}

export type VoiceBindingShotRecord = {
  dialogueText?: string | null
  characterName?: string | null
}

const SILENT_DIALOGUE = /^(?:\(\s*无对白\s*\)|（\s*无对白\s*）|无对白|无台词|静默|no dialogue)$/i

export function getDialogueSpeakerNames(
  shots: VoiceBindingShotRecord[],
  knownCharacterNames: string[] = [],
): string[] {
  const knownNames = [...new Set(knownCharacterNames.map((name) => String(name || '').trim()).filter(Boolean))]
  const speakers = new Set<string>()
  for (const shot of Array.isArray(shots) ? shots : []) {
    const dialogue = String(shot.dialogueText || '').trim()
    if (!dialogue || SILENT_DIALOGUE.test(dialogue)) continue
    let foundSpeaker = false
    for (const name of knownNames) {
      if (new RegExp(`(?:^|[\\n。！？!?；;])\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*[（(][^）)\\n]{0,60}[）)]?\\s*[：:]`).test(dialogue)
        || new RegExp(`(?:^|[\\n。！？!?；;])\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*[：:]`).test(dialogue)) {
        speakers.add(name)
        foundSpeaker = true
      }
    }
    if (!foundSpeaker) {
      const characterName = String(shot.characterName || '').trim()
      if (characterName && knownNames.includes(characterName)) speakers.add(characterName)
    }
  }
  return [...speakers]
}

export function buildVoiceBindingSummary(
  voiceCast: Array<{ character: VoiceBindingCharacter & { id?: number }; ready?: boolean }>,
  shots: VoiceBindingShotRecord[],
): { total: number; ready: number; pending: number; speakerNames: string[] } {
  const byName = new Map((Array.isArray(voiceCast) ? voiceCast : []).map((item) => [
    String(item.character?.name || '').trim(),
    item,
  ]))
  const speakers = getDialogueSpeakerNames(shots, [...byName.keys()])
  const ready = speakers.filter((name) => Boolean(byName.get(name)?.ready)).length
  return { total: speakers.length, ready, pending: speakers.length - ready, speakerNames: speakers }
}

export function getVoiceBindingState(
  characters: VoiceBindingCharacter[],
  hasDialogue: boolean,
): VoiceBindingState {
  if (!hasDialogue) return 'none'
  if (!characters.length) return 'pending'
  return characters.every((character) => Boolean(
    character.voiceLocked
    && (
      String(character.voiceProfileKey || '').trim()
      || String(character.referenceAudioUrl || '').trim()
    ),
  )) ? 'ready' : 'pending'
}

export function getShotVoiceBindingState(
  characters: VoiceBindingCharacter[],
  context: VoiceBindingShotContext,
): VoiceBindingState {
  const prompt = String(context.visualPrompt || '')
  const dialogue = String(context.dialogueText || '')
  const allowedNames = new Set((context.allowedEntities || []).map((name) => String(name).trim()).filter(Boolean))
  const explicitNames = new Set<string>()
  for (const character of characters) {
    const name = String(character.name || '').trim()
    if (!name) continue
    if (prompt.includes(`@${name}`) || dialogue.includes(`${name}：`) || dialogue.includes(`${name}:`)) {
      explicitNames.add(name)
    }
  }
  const referencedCharacters = characters.filter((character) => {
    const name = String(character.name || '').trim()
    if (!name) return false
    const names = explicitNames.size ? explicitNames : allowedNames
    return names.has(name)
      || name === String(context.primaryCharacterName || '').trim()
  })

  return getVoiceBindingState(referencedCharacters, Boolean(dialogue.trim()))
}
