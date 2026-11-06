const TRACK_LABELS = {
  dialogue: '对白',
  narration: '旁白',
}

function sourceLabel(check = {}) {
  return String(check.title || `音频 #${Number(check.audioId) || '未知'}`).trim()
}

function issue(check, code, message) {
  return {
    code,
    audioId: Number(check.audioId) || null,
    storyboardId: Number(check.storyboardId) || null,
    message,
  }
}

export function evaluateSpeechAudioSourceReadiness({ checks = [] } = {}) {
  const blockingIssues = []

  for (const check of checks) {
    const trackLabel = TRACK_LABELS[check?.trackType]
    if (!trackLabel) continue

    const label = sourceLabel(check)
    const status = String(check.status || '').trim().toLowerCase()
    if (status === 'measurable') continue

    if (status === 'download-failed') {
      blockingIssues.push(
        issue(
          check,
          'speech-audio-download-failed',
          `${trackLabel}「${label}」无法读取：${String(check.reason || '未知读取错误')}。`,
        ),
      )
      continue
    }

    if (status === 'silent') {
      blockingIssues.push(
        issue(check, 'speech-audio-silent', `${trackLabel}「${label}」检测为静音，不能进入正式终剪。`),
      )
      continue
    }

    blockingIssues.push(
      issue(
        check,
        'speech-audio-signal-unverified',
        `${trackLabel}「${label}」未能确认有效声音，不能进入正式终剪。`,
      ),
    )
  }

  return {
    passed: blockingIssues.length === 0,
    blockingIssues,
  }
}
