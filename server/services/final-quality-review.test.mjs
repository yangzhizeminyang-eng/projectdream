import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeFinalQualityReview } from './final-quality-review.mjs'

test('rejects approving a render that has automatic blocking issues', () => {
  assert.throws(
    () =>
      normalizeFinalQualityReview({
        decision: 'approved',
        checklist: {
          visualReviewed: true,
          subtitleReviewed: true,
          audioReviewed: true,
        },
        automaticPassed: false,
      }),
    /自动技术门禁未通过/,
  )
})

test('rejects approving a render whose technical report has no audible signal evidence', () => {
  assert.throws(
    () =>
      normalizeFinalQualityReview({
        decision: 'approved',
        checklist: {
          visualReviewed: true,
          subtitleReviewed: true,
          audioReviewed: true,
        },
        automaticPassed: true,
        automaticReport: {
          inspectedMedia: {
            audioSignal: 'silent',
          },
        },
      }),
    /音轨检测/,
  )
})

test('requires an exact confirmation token before approving a final quality review', () => {
  const baseReview = {
    decision: 'approved',
    checklist: {
      visualReviewed: true,
      subtitleReviewed: true,
      audioReviewed: true,
      visualNote: '主体无拉伸、无明显黑边，构图可接受',
      subtitleNote: '字幕文本准确，位置在安全区内',
      audioNote: '对白清晰，响度正常，无明显爆音',
      audioEvidence: {
        reviewed: true,
        listeningConfirmed: true,
        clarityReviewed: true,
        loudnessReviewed: true,
        clippingReviewed: true,
        syncReviewed: true,
      },
      characterConsistencyReviewed: true,
      characterConsistencyNote: '人物外貌、发型、服装和体型与角色设定一致',
    },
    automaticPassed: true,
    automaticReport: {
      inspectedMedia: {
        audioSignal: 'measurable',
      },
    },
  }

  assert.throws(
    () => normalizeFinalQualityReview(baseReview),
    /确认口令/,
  )
  assert.throws(
    () =>
      normalizeFinalQualityReview({
        ...baseReview,
        confirm: true,
        confirmationToken: 'APPROVE',
      }),
    /确认口令/,
  )

  const review = normalizeFinalQualityReview({
    ...baseReview,
    confirm: true,
    confirmationToken: 'APPROVE_FINAL_QUALITY_REVIEW',
  })
  assert.equal(review.decision, 'approved')
})

test('requires structured visual, subtitle, and audio evidence before approval', () => {
  const baseReview = {
    decision: 'approved',
    checklist: {
      visualReviewed: true,
      subtitleReviewed: true,
      audioReviewed: true,
      characterConsistencyReviewed: true,
      characterConsistencyNote: '人物外貌、发型、服装和体型与角色设定一致',
      audioEvidence: {
        reviewed: true,
        listeningConfirmed: true,
        clarityReviewed: true,
        loudnessReviewed: true,
        clippingReviewed: true,
        syncReviewed: true,
      },
    },
    automaticPassed: true,
    automaticReport: {
      inspectedMedia: {
        audioSignal: 'measurable',
      },
    },
    confirm: true,
    confirmationToken: 'APPROVE_FINAL_QUALITY_REVIEW',
  }

  assert.throws(
    () => normalizeFinalQualityReview(baseReview),
    /终审证据/,
  )

  const review = normalizeFinalQualityReview({
    ...baseReview,
    checklist: {
      ...baseReview.checklist,
      visualNote: '主体无拉伸、无明显黑边，构图可接受',
      subtitleNote: '字幕文本准确，位置在安全区内',
      audioNote: '对白清晰，响度正常，无明显爆音',
    },
  })

  assert.deepEqual(review.checklist.visualEvidence, {
    reviewed: true,
    note: '主体无拉伸、无明显黑边，构图可接受',
  })
  assert.deepEqual(review.checklist.subtitleEvidence, {
    reviewed: true,
    note: '字幕文本准确，位置在安全区内',
  })
  assert.deepEqual(review.checklist.audioEvidence, {
    reviewed: true,
    listeningConfirmed: true,
    clarityReviewed: true,
    loudnessReviewed: true,
    clippingReviewed: true,
    syncReviewed: true,
    syncNotApplicable: false,
    note: '对白清晰，响度正常，无明显爆音',
  })
})

test('requires structured character consistency evidence before approval', () => {
  const baseReview = {
    decision: 'approved',
    checklist: {
      visualReviewed: true,
      subtitleReviewed: true,
      audioReviewed: true,
      visualNote: '主体无拉伸、无明显黑边，构图可接受',
      subtitleNote: '字幕文本准确，位置在安全区内',
      audioNote: '对白清晰，响度正常，无明显爆音',
      audioEvidence: {
        reviewed: true,
        listeningConfirmed: true,
        clarityReviewed: true,
        loudnessReviewed: true,
        clippingReviewed: true,
        syncReviewed: true,
      },
    },
    automaticPassed: true,
    automaticReport: {
      inspectedMedia: {
        audioSignal: 'measurable',
      },
    },
    confirm: true,
    confirmationToken: 'APPROVE_FINAL_QUALITY_REVIEW',
  }

  assert.throws(
    () => normalizeFinalQualityReview(baseReview),
    /人物一致性/,
  )

  const review = normalizeFinalQualityReview({
    ...baseReview,
    checklist: {
      ...baseReview.checklist,
      characterConsistencyReviewed: true,
      characterConsistencyNote: '人物外貌、发型、服装和体型与角色设定一致',
    },
  })

  assert.deepEqual(review.checklist.characterConsistencyEvidence, {
    reviewed: true,
    note: '人物外貌、发型、服装和体型与角色设定一致',
  })
})

test('rejects approval when audio listening evidence is only a generic checkbox', () => {
  assert.throws(
    () =>
      normalizeFinalQualityReview({
        decision: 'approved',
        checklist: {
          visualReviewed: true,
          subtitleReviewed: true,
          audioReviewed: true,
          visualNote: '画面正常',
          subtitleNote: '字幕正常',
          audioNote: '音频正常',
          characterConsistencyReviewed: true,
          characterConsistencyNote: '人物一致',
        },
        automaticPassed: true,
        automaticReport: {
          inspectedMedia: {
            audioSignal: 'measurable',
          },
        },
        confirm: true,
        confirmationToken: 'APPROVE_FINAL_QUALITY_REVIEW',
      }),
    /实际听感/,
  )
})

test('requires detailed audio listening evidence before approval', () => {
  const review = normalizeFinalQualityReview({
    decision: 'approved',
    checklist: {
      visualReviewed: true,
      subtitleReviewed: true,
      audioReviewed: true,
      visualNote: '画面正常',
      subtitleNote: '字幕正常',
      audioNote: '已完整播放，确认对白清晰、响度平衡、无爆音；本镜头无可见说话人物，对嘴不适用。',
      audioEvidence: {
        reviewed: true,
        listeningConfirmed: true,
        clarityReviewed: true,
        loudnessReviewed: true,
        clippingReviewed: true,
        syncReviewed: false,
        syncNotApplicable: true,
        note: '已完整播放，确认对白清晰、响度平衡、无爆音；本镜头无可见说话人物，对嘴不适用。',
      },
      characterConsistencyReviewed: false,
      characterConsistencyEvidence: {
        notApplicable: true,
        note: '无实体人物',
      },
    },
    automaticPassed: true,
    automaticReport: {
      inspectedMedia: {
        audioSignal: 'measurable',
      },
    },
    confirm: true,
    confirmationToken: 'APPROVE_FINAL_QUALITY_REVIEW',
  })

  assert.deepEqual(review.checklist.audioEvidence, {
    reviewed: true,
    listeningConfirmed: true,
    clarityReviewed: true,
    loudnessReviewed: true,
    clippingReviewed: true,
    syncReviewed: false,
    syncNotApplicable: true,
    note: '已完整播放，确认对白清晰、响度平衡、无爆音；本镜头无可见说话人物，对嘴不适用。',
  })
})

test('allows an explicit not-applicable character review for a shot without visible people', () => {
  const review = normalizeFinalQualityReview({
    decision: 'approved',
    checklist: {
      visualReviewed: true,
      subtitleReviewed: true,
      audioReviewed: true,
      visualNote: '广播机特写无拉伸、无明显黑边。',
      subtitleNote: '字幕“十。”准确，位于安全区。',
      audioNote: '音轨有有效信号，但该测试只记录已验证的技术事实。',
      audioEvidence: {
        reviewed: true,
        listeningConfirmed: true,
        clarityReviewed: true,
        loudnessReviewed: true,
        clippingReviewed: true,
        syncReviewed: false,
        syncNotApplicable: true,
      },
      characterConsistencyReviewed: false,
      characterConsistencyEvidence: {
        notApplicable: true,
        note: '不适用：当前镜头没有实体人物，只记录角色一致性检查范围。',
      },
    },
    automaticPassed: true,
    automaticReport: {
      inspectedMedia: {
        audioSignal: 'measurable',
      },
    },
    confirm: true,
    confirmationToken: 'APPROVE_FINAL_QUALITY_REVIEW',
  })

  assert.equal(review.checklist.characterConsistencyReviewed, false)
  assert.equal(review.checklist.characterConsistencyNotApplicable, true)
  assert.deepEqual(review.checklist.characterConsistencyEvidence, {
    notApplicable: true,
    reviewed: false,
    note: '不适用：当前镜头没有实体人物，只记录角色一致性检查范围。',
  })
})

test('allows rework review notes without an approval confirmation token', () => {
  const review = normalizeFinalQualityReview({
    decision: 'rework',
    checklist: {
      visualReviewed: false,
      subtitleReviewed: false,
      audioReviewed: true,
      audioNote: '对白清晰，但字幕需重改',
    },
    note: '字幕需重改',
    automaticPassed: true,
    automaticReport: {
      inspectedMedia: {
        audioSignal: 'measurable',
      },
    },
  })

  assert.equal(review.decision, 'rework')
  assert.equal(review.note, '字幕需重改')
})
