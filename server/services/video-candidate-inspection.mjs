import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'

import { buildMediaInspectionSummary } from './media-inspection.mjs'

const execFile = promisify(nodeExecFile)

export function inferVideoCandidateExpectations({
  durationSeconds,
  actionText = '',
  actingBeat = '',
  dialogueText = '',
  audioDirection = '',
  gazePlan = null,
  soundPlan = null,
} = {}) {
  const action = `${actionText} ${actingBeat}`
  const dialogue = String(dialogueText || '').trim()
  const direction = String(audioDirection || '').trim()
  const hasDialogue = Boolean(dialogue) && !/^(?:[（(]\s*)?(?:无对白|无台词|no\s+dialogue)(?:\s*[）)])?$/i.test(dialogue)
  const explicitlySilent = /(?:静默|完全静音|无环境声|无声音)/u.test(direction)
  const requiresAudio = hasDialogue || (!explicitlySilent && /(?:环境声|音效|拟音|背景声|打印机|电流声|通风|音乐|脚步声|呼吸声)/u.test(direction))
  const requiresMotion = /(?:抬头|低头|转身|走(?:向|到|入|出|开)?|跑|滑出|滑入|推开|拉开|打开|关闭|伸手|拿起|放下|递出|接过|起身|坐下|靠近|后退|移动|摇镜|推镜|拉镜|跟拍|环绕|摆动|闪烁|升起|落下|点亮|熄灭|点击|打印|敲击|颤抖|回头|眨眼)/u.test(action)
  const gazeTargets = [...new Set(
    (Array.isArray(gazePlan?.transitions) ? gazePlan.transitions : [])
      .map((item) => String(item?.target || '').trim())
      .filter(Boolean),
  )]
  const soundCues = Array.isArray(soundPlan?.cues)
    ? soundPlan.cues.filter((item) => String(item?.sound || '').trim())
    : []
  const requiresContinuousAmbience = !explicitlySilent && Boolean(String(soundPlan?.bed || '').trim())

  return {
    durationSeconds: Math.max(1, Math.round(Number(durationSeconds) || 4)),
    requiresMotion,
    requiresAudio: requiresAudio || requiresContinuousAmbience,
    requiresGazeReview: gazeTargets.length > 0,
    gazeTargetCount: gazeTargets.length,
    requiresContinuousAmbience,
    soundCueCount: soundCues.length,
  }
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function issue(code, message, severity = 'warning') {
  return { code, message, severity }
}

function silenceRatioFromOutput(stderr, durationSeconds) {
  const duration = finite(durationSeconds)
  if (!duration || duration <= 0) return null
  const starts = [...String(stderr || '').matchAll(/silence_start:\s*([\d.]+)/g)]
    .map((match) => Number(match[1]))
  const ends = [...String(stderr || '').matchAll(/silence_end:\s*([\d.]+)/g)]
    .map((match) => Number(match[1]))
  let silentSeconds = 0
  for (let index = 0; index < starts.length; index += 1) {
    const end = Math.min(duration, Math.max(starts[index], ends[index] ?? duration))
    silentSeconds += Math.max(0, end - starts[index])
  }
  return Math.min(1, silentSeconds / duration)
}

export function buildVideoCandidateInspection({
  expected = {},
  media = {},
  motion = null,
  audio = null,
  inspectionError = '',
} = {}) {
  const issues = []
  const duration = finite(media.durationSeconds)
  const targetDuration = finite(expected.durationSeconds)
  const requiresMotion = expected.requiresMotion === true
  const requiresAudio = expected.requiresAudio === true
  const requiresContinuousAmbience = expected.requiresContinuousAmbience === true
  const requiresGazeReview = expected.requiresGazeReview === true
  let technicalStatus = 'passed'
  const markAttention = () => {
    if (technicalStatus === 'passed') technicalStatus = 'needs_attention'
  }

  if (inspectionError || !finite(media.width) || !finite(media.height) || !duration || !finite(media.frameRate)) {
    technicalStatus = 'unchecked'
    issues.push(issue(
      'media-inspection-incomplete',
      String(inspectionError || '媒体技术检查未完成，不能判定视频质量通过。'),
      'blocker',
    ))
  }

  if (targetDuration && duration && Math.abs(targetDuration - duration) > Math.max(1, targetDuration * 0.2)) {
    markAttention()
    issues.push(issue('video-duration-deviation', `视频实际时长 ${duration.toFixed(2)} 秒，与目标 ${targetDuration} 秒差异较大。`))
  }

  if (requiresMotion) {
    const frozen = finite(motion?.frozenDurationSeconds)
    const meanFrameDifference = finite(motion?.meanFrameDifference)
    const activeFrameRatio = finite(motion?.activeFrameRatio)
    if (frozen === null && meanFrameDifference === null && activeFrameRatio === null) {
      if (technicalStatus !== 'unchecked') technicalStatus = 'unchecked'
      issues.push(issue('motion-inspection-incomplete', '本镜有明确动作要求，但画面冻结风险未能测量。', 'blocker'))
    } else if ((duration && frozen !== null && frozen / duration >= 0.7)
      || (meanFrameDifference !== null && meanFrameDifference < 1)) {
      markAttention()
      issues.push(issue(
        meanFrameDifference !== null && meanFrameDifference < 1 ? 'expected-motion-near-static' : 'expected-motion-freeze-risk',
        '本镜要求可见动作，但逐帧变化幅度偏低或出现长时间静止；请重点核对动作是否发生。',
      ))
    }
    if (activeFrameRatio !== null && activeFrameRatio < 0.1) {
      markAttention()
      issues.push(issue(
        'expected-motion-low-coverage',
        '明显画面变化只覆盖了很少帧，可能是闪变或瞬间跳动而非连续动作；请观看核对。',
      ))
    }
  }

  if (requiresAudio) {
    const streamPresent = audio?.streamPresent === true
    const meanVolumeDb = finite(audio?.meanVolumeDb)
    if (!streamPresent) {
      markAttention()
      issues.push(issue('required-audio-missing', '本镜要求声音，但视频没有音轨。'))
    } else if (meanVolumeDb === null) {
      if (technicalStatus !== 'unchecked') technicalStatus = 'unchecked'
      issues.push(issue('audio-level-inspection-incomplete', '检测到音轨，但响度指标不可用。', 'blocker'))
    } else if (meanVolumeDb <= -45 || finite(audio?.silenceRatio) >= 0.8) {
      markAttention()
      issues.push(issue('required-audio-near-silent', `本镜要求声音，但音轨平均响度为 ${meanVolumeDb.toFixed(1)} dB 或大部分时段静音。`))
    }
  }

  const attentionCount = issues.filter((item) => item.severity !== 'blocker').length
  const summary = technicalStatus === 'unchecked'
    ? '媒体技术检查未完成，不能标记为通过。'
    : technicalStatus === 'needs_attention'
      ? `发现 ${attentionCount} 项需要处理的技术风险；剧情动作仍需观看复核。`
      : '媒体技术检查通过；剧情动作、资产一致性和声音内容仍需观看复核。'

  return {
    version: 1,
    technicalStatus,
    semanticStatus: 'pending_review',
    summary,
    expected: {
      durationSeconds: targetDuration,
      requiresMotion,
      requiresAudio,
      requiresGazeReview,
      gazeTargetCount: Number(expected.gazeTargetCount || 0),
      requiresContinuousAmbience,
      soundCueCount: Number(expected.soundCueCount || 0),
    },
    reviewRequirements: {
      gaze: requiresGazeReview
        ? `需人工核对${Number(expected.gazeTargetCount || 0)}个视线目标的顺序、停留和结束锁定`
        : '无结构化视线计划，未执行视线语义检查',
      sound: requiresContinuousAmbience
        ? `需人工核对连续环境底床及${Number(expected.soundCueCount || 0)}个动作拟音 cue`
        : '无结构化持续底床要求，仍需人工听审实际音轨',
      semanticStatus: 'pending_review',
    },
    metrics: {
      width: finite(media.width),
      height: finite(media.height),
      durationSeconds: duration,
      frameRate: finite(media.frameRate),
      audioCodec: String(media.audioCodec || ''),
      meanVolumeDb: finite(audio?.meanVolumeDb),
      silenceRatio: finite(audio?.silenceRatio),
      frozenDurationSeconds: finite(motion?.frozenDurationSeconds),
      meanFrameDifference: finite(motion?.meanFrameDifference),
      maxFrameDifference: finite(motion?.maxFrameDifference),
      activeFrameRatio: finite(motion?.activeFrameRatio),
    },
    issues,
    checkedAt: new Date().toISOString(),
  }
}

export async function inspectVideoCandidateFile({
  filePath,
  expected,
  ffprobeBin = 'ffprobe',
  ffmpegBin = 'ffmpeg',
  run = (command, args) => execFile(command, args, { maxBuffer: 8 * 1024 * 1024 }),
} = {}) {
  try {
    const probe = await run(ffprobeBin, [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
    ])
    const probePayload = JSON.parse(probe.stdout || '{}')
    const media = buildMediaInspectionSummary(probePayload)
    const video = (probePayload.streams || []).some((stream) => stream.codec_type === 'video')
    const audioStream = (probePayload.streams || []).some((stream) => stream.codec_type === 'audio')
    if (!video) throw new Error('文件中没有视频流。')

    const freezePromise = expected?.requiresMotion
      ? run(ffmpegBin, [
        '-hide_banner', '-nostats', '-i', filePath, '-vf', 'freezedetect=n=-50dB:d=0.8',
        '-an', '-f', 'null', '-',
      ])
      : Promise.resolve({ stderr: '' })
    const frameDifferencePromise = expected?.requiresMotion
      ? run(ffmpegBin, [
        '-hide_banner', '-nostats', '-i', filePath,
        '-vf', 'tblend=all_mode=difference,signalstats,metadata=print',
        '-an', '-f', 'null', '-',
      ])
      : Promise.resolve({ stderr: '' })
    const audioPromise = audioStream
      ? run(ffmpegBin, [
        '-hide_banner', '-nostats', '-i', filePath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-',
      ])
      : Promise.resolve({ stderr: '' })
    const silencePromise = audioStream && expected?.requiresAudio
      ? run(ffmpegBin, [
        '-hide_banner', '-nostats', '-i', filePath, '-map', '0:a:0',
        '-af', 'silencedetect=n=-45dB:d=0.05', '-f', 'null', '-',
      ])
      : Promise.resolve({ stderr: '' })
    const [freezeResult, frameDifferenceResult, audioResult, silenceResult] = await Promise.all([
      freezePromise,
      frameDifferencePromise,
      audioPromise,
      silencePromise,
    ])
    const frozenDurationSeconds = [...String(freezeResult.stderr || '').matchAll(/freeze_duration:\s*([\d.]+)/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0)
    const frameDifferences = [...String(frameDifferenceResult.stderr || '').matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite)
    const meanFrameDifference = frameDifferences.length
      ? frameDifferences.reduce((sum, value) => sum + value, 0) / frameDifferences.length
      : null
    const activeFrameRatio = frameDifferences.length
      ? frameDifferences.filter((value) => value >= 1).length / frameDifferences.length
      : null
    const meanVolumeDb = Number(String(audioResult.stderr || '').match(/mean_volume:\s*(-?[\d.]+)\s*dB/)?.[1])
    const report = buildVideoCandidateInspection({
      expected,
      media: { ...media, hasVideo: true },
      motion: expected?.requiresMotion
        ? {
          frozenDurationSeconds,
          meanFrameDifference,
          maxFrameDifference: frameDifferences.length ? Math.max(...frameDifferences) : null,
          activeFrameRatio,
        }
        : null,
      audio: audioStream
        ? {
          streamPresent: true,
          meanVolumeDb: Number.isFinite(meanVolumeDb) ? meanVolumeDb : null,
          silenceRatio: silenceRatioFromOutput(silenceResult.stderr, media.durationSeconds),
        }
        : { streamPresent: false },
    })
    return report
  } catch (error) {
    return buildVideoCandidateInspection({
      expected,
      inspectionError: error instanceof Error ? error.message : '媒体技术检查失败。',
    })
  }
}
