const COSTUME_EVIDENCE = /(?:固定|默认|穿着|穿戴|服装|衣着|西装|衬衫|外套|夹克|裙|裤|鞋|靴|皮带|领带|眼镜|腕表|手表|项链|吊坠|耳环|戒指|随身|携带|U盘)/u

function text(value) {
  return String(value ?? '').trim()
}

/**
 * Keep costume extraction evidence-based. If a model accidentally places its
 * costume baseline in voice_setting, recover that exact model text instead of
 * inventing a new outfit; ordinary voice descriptions remain voice-only.
 */
export function normalizeCharacterCostume(item = {}, fallback = '') {
  const direct = [
    item.costume,
    item.costume_description,
    item.fixed_costume,
    item.fixedCostume,
    item.costume_and_props,
    item.costumeAndProps,
    fallback,
  ].map(text).find(Boolean)
  if (direct) return direct

  const misplacedVoiceSetting = text(item.voice_setting ?? item.voiceSetting)
  return COSTUME_EVIDENCE.test(misplacedVoiceSetting) ? misplacedVoiceSetting : ''
}
