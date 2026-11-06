import { validateStoryboardDurationContract } from './storyboard-duration-contract.mjs'
import { validateStoryboardDirectionContract } from './storyboard-direction-contract.mjs'

function text(value) {
  return String(value ?? '').trim()
}

function list(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

export function normalizeStoryboardShotContract(shot = {}) {
  return {
    shotNo: text(shot.shot_no ?? shot.shotNo),
    shotType: text(shot.shot_type ?? shot.shotType),
    cameraAngle: text(shot.camera_angle ?? shot.cameraAngle),
    composition: text(shot.composition),
    durationSeconds: shot.duration_seconds ?? shot.durationSeconds ?? null,
    visualPrompt: text(shot.visual_prompt ?? shot.visualPrompt),
    durationBreakdown: shot.duration_breakdown ?? shot.durationBreakdown ?? shot.timing_plan ?? shot.timingPlan ?? [],
    durationBasis: text(shot.duration_basis ?? shot.durationBasis),
    actionText: text(shot.action_text ?? shot.actionText),
    actingBeat: text(shot.acting_beat ?? shot.actingBeat),
    dialogueText: text(shot.dialogue_text ?? shot.dialogueText),
    audioDirection: text(shot.audio_direction ?? shot.audioDirection),
    gazePlan: shot.gaze_plan ?? shot.gazePlan ?? null,
    soundPlan: shot.sound_plan ?? shot.soundPlan ?? null,
    emotionalChange: text(shot.emotional_change ?? shot.emotionalChange),
    shotPurpose: text(shot.shot_purpose ?? shot.shotPurpose),
    startState: text(shot.start_state ?? shot.startState),
    endState: text(shot.end_state ?? shot.endState),
    characterAssets: list(shot.character_assets ?? shot.characterAssets),
    sceneAssets: list(shot.scene_assets ?? shot.sceneAssets),
    propAssets: list(shot.prop_assets ?? shot.propAssets),
    tools: list(shot.tools ?? shot.mention_tools ?? shot.mentionTools),
    sceneViewKey: text(shot.scene_view_key ?? shot.sceneViewKey),
    startVisualPrompt: text(shot.start_visual_prompt ?? shot.startVisualPrompt),
    endVisualPrompt: text(shot.end_visual_prompt ?? shot.endVisualPrompt),
  }
}

export function validateStoryboardShotContract(shot = {}) {
  const value = normalizeStoryboardShotContract(shot)
  const blockers = []
  if (!value.shotNo) blockers.push('缺少镜头编号')
  if (!value.shotType) blockers.push('缺少景别')
  if (!value.cameraAngle) blockers.push('缺少机位')
  if (!value.composition) blockers.push('缺少构图')
  const durationResult = validateStoryboardDurationContract(shot)
  blockers.push(...durationResult.blockers)
  const directionResult = validateStoryboardDirectionContract(shot)
  blockers.push(...directionResult.blockers)
  if (!value.actionText) blockers.push('缺少镜头动作')
  if (!value.actingBeat) blockers.push('缺少表演节拍')
  if (!value.shotPurpose) blockers.push('缺少镜头目的')
  if (!value.startState) blockers.push('缺少镜头起始状态')
  if (!value.endState) blockers.push('缺少镜头结束状态')
  // 场景全景基准是最低可用引用；九宫格生成后才要求镜头绑定具体角度。
  if (value.sceneAssets.length && value.sceneViewKey && !/^((front|back|left|right|center)(-left|-right)?)$/.test(value.sceneViewKey)) {
    blockers.push('引用场景时的场景角度标识无效')
  }
  return {
    passed: blockers.length === 0,
    blockers,
    shot: {
      ...value,
      durationSeconds: durationResult.durationSeconds,
      durationBreakdown: durationResult.durationBreakdown,
      durationBasis: durationResult.durationBasis,
      gazePlan: directionResult.gaze,
      soundPlan: directionResult.sound,
    },
    duration: durationResult,
    direction: directionResult,
  }
}
