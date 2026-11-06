import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./Export.vue', import.meta.url), 'utf8')

test('export page requires an explicit final quality approval token', () => {
  assert.match(source, /const reviewConfirmationToken = ref\(''\)/)
  assert.match(source, /APPROVE_FINAL_QUALITY_REVIEW/)
  assert.match(source, /confirmationToken: reviewConfirmationToken\.value\.trim\(\)/)
  assert.match(source, /reviewConfirmationToken\.value\.trim\(\) === 'APPROVE_FINAL_QUALITY_REVIEW'/)
})

test('export page captures structured final review evidence notes', () => {
  assert.match(source, /const reviewEvidenceNotes = ref\({/)
  assert.match(source, /visualNote: reviewEvidenceNotes\.value\.visual\.trim\(\)/)
  assert.match(source, /subtitleNote: reviewEvidenceNotes\.value\.subtitle\.trim\(\)/)
  assert.match(source, /audioNote: reviewEvidenceNotes\.value\.audio\.trim\(\)/)
  assert.match(source, /placeholder="记录画面是否拉伸、黑边、跳帧、主体裁切"/)
  assert.match(source, /placeholder="记录字幕准确性、错别字和安全区"/)
  assert.match(source, /placeholder="记录对白清晰度、响度、爆音和对嘴"/)
})

test('export page requires detailed audio listening evidence before approval', () => {
  assert.match(source, /const reviewAudioEvidence = ref\({/)
  assert.match(source, /listeningConfirmed: false/)
  assert.match(source, /clarityReviewed: false/)
  assert.match(source, /loudnessReviewed: false/)
  assert.match(source, /clippingReviewed: false/)
  assert.match(source, /syncReviewed: false/)
  assert.match(source, /syncNotApplicable: false/)
  assert.match(source, /listeningConfirmed: reviewAudioEvidence\.value\.listeningConfirmed/)
  assert.match(source, /clarityReviewed: reviewAudioEvidence\.value\.clarityReviewed/)
  assert.match(source, /loudnessReviewed: reviewAudioEvidence\.value\.loudnessReviewed/)
  assert.match(source, /clippingReviewed: reviewAudioEvidence\.value\.clippingReviewed/)
  assert.match(source, /syncReviewed: reviewAudioEvidence\.value\.syncReviewed/)
  assert.match(source, /syncNotApplicable: reviewAudioEvidence\.value\.syncNotApplicable/)
  assert.match(source, /实际完整播放/)
  assert.match(source, /没有爆音或明显失真/)
  assert.match(source, /对白与画面同步/)
  assert.match(source, /对白同步不适用/)
})

test('export page only enables listening confirmation after the selected video finishes playback', () => {
  assert.match(source, /@ended="reviewPlaybackCompleted = true"/)
  assert.match(
    source,
    /:disabled="\s*!reviewPlaybackCompleted\s*&&\s*!reviewAudioEvidence\.listeningConfirmed\s*"/,
  )
  assert.match(source, /完整播放到结尾后才能勾选听感确认/)
})

test('regression sample review uses the same detailed audio listening gate', () => {
  assert.match(source, /const regressionReviewAudioEvidence = ref\({/)
  assert.match(source, /listeningConfirmed: regressionReviewAudioEvidence\.value\.listeningConfirmed/)
  assert.match(source, /clarityReviewed: regressionReviewAudioEvidence\.value\.clarityReviewed/)
  assert.match(source, /loudnessReviewed: regressionReviewAudioEvidence\.value\.loudnessReviewed/)
  assert.match(source, /clippingReviewed: regressionReviewAudioEvidence\.value\.clippingReviewed/)
  assert.match(source, /syncReviewed: regressionReviewAudioEvidence\.value\.syncReviewed/)
  assert.match(source, /syncNotApplicable: regressionReviewAudioEvidence\.value\.syncNotApplicable/)
  assert.match(source, /音频人工复核仍缺少实际听感字段/)
})

test('audio sync review choices are mutually exclusive in both review workbenches', () => {
  assert.match(source, /function toggleLatestSyncReviewed\(/)
  assert.match(source, /function toggleLatestSyncNotApplicable\(/)
  assert.match(source, /function toggleRegressionSyncReviewed\(/)
  assert.match(source, /function toggleRegressionSyncNotApplicable\(/)
  assert.match(source, /@change="toggleLatestSyncReviewed"/)
  assert.match(source, /@change="toggleLatestSyncNotApplicable"/)
  assert.match(source, /@change="toggleRegressionSyncReviewed"/)
  assert.match(source, /@change="toggleRegressionSyncNotApplicable"/)
})

test('export page requires character consistency evidence before final approval', () => {
  assert.match(source, /characterConsistencyReviewed/)
  assert.match(source, /characterConsistencyNote: reviewEvidenceNotes\.value\.characterConsistency\.trim\(\)/)
  assert.match(source, /reviewEvidenceNotes\.value\.characterConsistency\.trim\(\)/)
  assert.match(source, /人物一致性已复核/)
  assert.match(source, /placeholder="记录人物外貌、发型、服装、体型和同屏角色数量"/)
})

test('export page can record character consistency as not applicable for a no-person shot', () => {
  assert.match(source, /characterConsistencyNotApplicable/)
  assert.match(source, /人物一致性不适用/)
  assert.match(source, /notApplicable/)
})

test('export page captures per-platform release compliance evidence', () => {
  assert.match(source, /const platformComplianceEvidence = ref<Record<string, PlatformComplianceEvidence>>\({}\)/)
  assert.match(source, /platformEvidence: resolvePlatformEvidencePayload\(\)/)
  assert.match(source, /v-for="platform in releaseCompliance\.platforms"/)
  assert.match(source, /aiLabelReviewed/)
  assert.match(source, /copyrightFieldsReviewed/)
  assert.match(source, /ruleReviewNote/)
})

test('export page requires an explicit release compliance confirmation token', () => {
  assert.match(source, /const complianceConfirmationToken = ref\(''\)/)
  assert.match(source, /CONFIRM_RELEASE_COMPLIANCE_REVIEW/)
  assert.match(source, /confirmationToken: complianceConfirmationToken\.value\.trim\(\)/)
  assert.match(source, /complianceConfirmationToken\.value\.trim\(\) === 'CONFIRM_RELEASE_COMPLIANCE_REVIEW'/)
})

test('export page displays the release compliance audit fingerprint', () => {
  assert.match(source, /releaseCompliance\.audit\?\.evidenceHash/)
  assert.match(source, /合规证据指纹/)
  assert.match(source, /slice\(0, 16\)/)
})

test('export page displays a release candidate snapshot only when available', () => {
  assert.match(source, /releaseCompliance\.releaseCandidateSnapshot/)
  assert.match(source, /发布候选快照/)
  assert.match(source, /releaseCompliance\.releaseCandidateSnapshot\.evidenceHash\.slice\(0, 16\)/)
})

test('export page displays structured audio evidence in the release candidate snapshot', () => {
  assert.match(source, /releaseCandidateSnapshot\.humanReviewEvidence\.audioChecklist/)
  assert.match(source, /完整播放/)
  assert.match(source, /清晰度/)
  assert.match(source, /响度平衡/)
  assert.match(source, /失真/)
  assert.match(source, /对白同步/)
})

test('export page displays the ten-sample final quality regression gate', () => {
  assert.match(source, /getProjectFinalQualityRegression/)
  assert.match(source, /10 条终剪回归/)
  assert.match(source, /qualityRegression\.summary\.sampleCount/)
  assert.match(source, /qualityRegression\.sampleScope\.excludedCount/)
  assert.match(source, /v-if="qualityRegression" class="history-sub regression-scope-note"/)
  assert.match(source, /只统计实际完成或失败的终剪尝试/)
  assert.match(source, /不会自动启动 Worker 或调用模型/)
})

test('export page displays the six-dimension machine preflight separately from human review', () => {
  assert.match(source, /getProjectMarketQualityAudit/)
  assert.match(source, /const marketQualityAudit = ref/)
  assert.match(source, /六维机器预审/)
  assert.match(source, /画面比例与帧完整性/)
  assert.match(source, /字幕文字与时间轴/)
  assert.match(source, /人物一致性机器门禁/)
  assert.match(source, /音频机器检测/)
  assert.match(source, /开头钩子与镜头节奏/)
  assert.match(source, /发布候选机器状态/)
  assert.match(source, /机器预审不能替代真人完整播放和平台审核/)
})

test('export page exposes blocked cinematic reports without treating them as completed', () => {
  assert.match(source, /latestExport\.status === 'blocked'/)
  assert.match(source, /成片质量门禁阻止完成/)
  assert.match(source, /cinematicQualityReport\?\.blockers/)
  assert.match(source, /cinematicQualityReport\?\.issueShots/)
  assert.match(source, /手动调整后重新导出/)
  assert.match(source, /按建议重新规划/)
})

test('export page displays every machine audit sample and its technical blockers', () => {
  assert.match(source, /const machineAuditRows = computed/)
  assert.match(source, /机器审计样本清单/)
  assert.match(source, /machine-audit-row/)
  assert.match(source, /technicalBlockers/)
  assert.match(source, /画面规格/)
  assert.match(source, /字幕时间轴/)
  assert.match(source, /音频检测/)
  assert.match(source, /marketObserved\(latestMarketQualityItem, 'media', 'audioSampleRate'\)/)
  assert.match(source, /角色证据/)
  assert.match(source, /发布材料/)
  assert.match(source, /不会自动修复媒体/)
})

test('export page displays required regression coverage buckets', () => {
  assert.match(source, /qualityRegression\.coverage\.coveredCount/)
  assert.match(source, /qualityRegression\.coverage\.buckets/)
  assert.match(source, /缺少覆盖/)
  assert.match(source, /regressionMissingCoverageText/)
})

test('export page saves regression coverage tags with an explicit token only', () => {
  assert.match(source, /saveExportFinalQualityRegressionTags/)
  assert.match(source, /const regressionTagDraft = ref<string\[\]>\(\[\]\)/)
  assert.match(source, /CONFIRM_FINAL_QUALITY_REGRESSION_TAGS/)
  assert.match(source, /只保存标签，不启动 Worker 或模型/)
  assert.match(source, /saveSelectedRegressionTags/)
})

test('export page can tag a selected final quality regression sample', () => {
  assert.match(source, /const regressionTagTargetExportId = ref<number \| null>\(null\)/)
  assert.match(source, /const regressionTagTargets = computed/)
  assert.match(source, /v-model\.number="regressionTagTargetExportId"/)
  assert.match(source, /选择回归样本/)
  assert.match(source, /qualityRegression\.value\?\.items/)
})

test('export page shows a per-sample final quality regression review checklist', () => {
  assert.match(source, /const regressionSampleRows = computed/)
  assert.match(source, /样本复核清单/)
  assert.match(source, /qualityGapCodes/)
  assert.match(source, /标记此样本/)
  assert.match(source, /syncRegressionTagForm\(row\.exportId, true\)/)
})

test('export page summarizes final quality regression review gaps', () => {
  assert.match(source, /const regressionGapSummary = computed/)
  assert.match(source, /缺口摘要/)
  assert.match(source, /missingTags/)
  assert.match(source, /technicalBlocked/)
  assert.match(source, /pendingHumanReview/)
  assert.match(source, /rework/)
  assert.match(source, /approved/)
})

test('export page can filter final quality regression samples by review gap', () => {
  assert.match(source, /const regressionSampleFilter = ref/)
  assert.match(source, /const regressionSampleFilterOptions = computed/)
  assert.match(source, /const filteredRegressionSampleRows = computed/)
  assert.match(source, /筛选样本/)
  assert.match(source, /未标记/)
  assert.match(source, /技术阻塞/)
  assert.match(source, /待复核/)
  assert.match(source, /filteredRegressionSampleRows/)
})

test('export page displays the next manual action for each regression sample', () => {
  assert.match(source, /nextActionText/)
  assert.match(source, /下一步：/)
  assert.match(source, /row\.nextActionText/)
})

test('export page separates regression coverage from production readiness', () => {
  assert.match(source, /productionReadiness/)
  assert.match(source, /稳定生产判定/)
  assert.match(source, /qualityRegression\.productionReadiness\.status/)
  assert.match(source, /qualityRegression\.productionReadiness\.passedSampleCount/)
  assert.match(source, /qualityRegression\.productionReadiness\.blockers/)
})

test('export page displays the project production readiness gate and action queue', () => {
  assert.match(source, /getProjectProductionReadiness/)
  assert.match(source, /type ProductionReadinessDTO/)
  assert.match(source, /const productionReadiness = ref<ProductionReadinessDTO \| null>\(null\)/)
  assert.match(source, /生产发布总闸门/)
  assert.match(source, /productionReadiness\.releaseCandidateReady/)
  assert.match(source, /productionReadiness\.stableRevenueReady/)
  assert.match(source, /productionReadinessStageRows/)
  assert.match(source, /productionReadiness\.actionQueue/)
  assert.match(source, /不会替代人工审核、平台审核或收入证明/)
})

test('export page routes each production readiness action without starting production', () => {
  assert.match(source, /function focusProductionReadinessAction/)
  assert.match(source, /ProductionReadinessDTO\['actionQueue'\]\[number\]/)
  assert.match(source, /complete-ten-final-edit-regression/)
  assert.match(source, /complete-release-compliance-package/)
  assert.match(source, /complete-cost-ledger-pricing/)
  assert.match(source, /publish-controlled-episodes/)
  assert.match(source, /#final-quality-regression-gate/)
  assert.match(source, /#release-compliance-gate/)
  assert.match(source, /#cost-ledger-gate/)
  assert.match(source, /#platform-validation-gate/)
  assert.match(source, /只定位处理区，不保存、不发布、不启动 Worker 或模型/)
  assert.match(source, /@click="focusProductionReadinessAction\(action\)"/)
})

test('export evidence gates keep cost, compliance, and platform evidence in a stable layout', () => {
  assert.match(source, /class="panel cost-ledger-panel"/)
  assert.match(source, /class="summary-grid compact cost-ledger-summary"/)
  assert.match(source, /class="panel release-compliance-panel"/)
  assert.match(source, /grid-template-areas:\s*[\r\n]+\s*'cost release'[\r\n]+\s*'platform release'/)
  assert.match(source, /class="review-note compliance-label-input"/)
})

test('export history keeps status actions aligned with the actual export state', () => {
  assert.match(source, /function exportRecordActionLabel\(status: string\)/)
  assert.match(source, /if \(status === 'failed'\) return '导出失败'/)
  assert.match(source, /if \(status === 'canceled'\) return '已取消'/)
  assert.match(source, /class="history-item"/)
  assert.match(source, /class="history-meta"/)
  assert.match(source, /class="history-coverage"/)
  assert.match(source, /class="history-link muted">\{\{ exportRecordActionLabel\(record\.status\) \}\}/)
})

test('export review feedback distinguishes rework from success without covering the workbench', () => {
  assert.match(source, /type InfoTone = 'success' \| 'warning'/)
  assert.match(source, /function setInfo\(message: string, tone: InfoTone = 'success'\)/)
  assert.match(source, /class="message message--global"/)
  assert.match(source, /\.export-page > \.message--global/)
  assert.match(source, /width: fit-content/)
  assert.match(source, /infoTone === 'warning' \? 'priority_high' : 'check_circle'/)
  assert.match(source, /v-if="infoTone === 'warning'"/)
  assert.match(source, /@click="goFinalEdit"/)
  assert.match(source, /function goFinalEdit\(\): void/)
  assert.match(source, /class="message-actions"/)
  assert.match(source, /aria-label="关闭提示"/)
})

test('export page renders the complete production action queue', () => {
  assert.match(source, /v-for="action in productionReadiness\.actionQueue\.slice\(0, 3\)"/)
  assert.match(source, /v-for="action in productionReadiness\.actionQueue\.slice\(3\)"/)
  assert.match(source, /查看其余处理项/)
  assert.match(source, /productionReadiness\.actionQueue\.length/)
})

test('export page refreshes production readiness after evidence-changing actions', () => {
  assert.match(source, /async function refreshProductionReadiness/)
  assert.match(source, /await refreshProductionReadiness\(\)/)
  assert.match(source, /getProjectProductionReadiness\(projectId\.value\)/)
})

test('export page displays per-sample human review evidence gaps', () => {
  assert.match(source, /reviewEvidenceGaps/)
  assert.match(source, /formatRegressionReviewEvidenceGaps/)
  assert.match(source, /人工证据缺口/)
  assert.match(source, /row\.reviewEvidenceGapText/)
})

test('export page groups and filters samples by human review evidence gap type', () => {
  assert.match(source, /reviewEvidence\.buckets/)
  assert.match(source, /regressionEvidenceGapBuckets/)
  assert.match(source, /regressionEvidenceGapFilterByKey/)
  assert.match(source, /人工证据分组/)
  assert.match(source, /visual-evidence-missing/)
  assert.match(source, /character-consistency-evidence-missing/)
})

test('export page can manually review one selected final quality regression sample', () => {
  assert.match(source, /const regressionReviewTargetExportId = ref<number \| null>\(null\)/)
  assert.match(source, /const regressionReviewTargetReport = computed/)
  assert.match(source, /const canApproveRegressionSampleReview = computed/)
  assert.match(source, /syncRegressionReviewForm\(row\.exportId, true\)/)
  assert.match(source, /单条样本人工复核/)
  assert.match(source, /只保存人工复核证据，不启动 Worker 或模型/)
  assert.match(source, /reviewFinalQualityReport\(regressionReviewTargetReport\.value\.id/)
  assert.match(source, /saveRegressionSampleReview\('approved'\)/)
})

test('export page can create a technical quality report for one selected regression sample only', () => {
  assert.match(source, /const isCreatingRegressionSampleReport = ref\(false\)/)
  assert.match(source, /const canCreateRegressionSampleReport = computed/)
  assert.match(source, /createRegressionSampleQualityReport/)
  assert.match(source, /createExportQualityReport\(regressionReviewTargetExport\.value\.id\)/)
  assert.match(source, /为选中样本生成技术质量报告/)
  assert.match(source, /只检查这一条已完成导出，不启动 Worker 或模型/)
})

test('export page can focus the next regression sample that needs manual evidence', () => {
  assert.match(source, /const regressionReviewQueueSummary = computed/)
  assert.match(source, /missingReports/)
  assert.match(source, /evidenceGaps/)
  assert.match(source, /function focusNextRegressionReviewTarget/)
  assert.match(source, /syncRegressionReviewForm\(next\.exportId, true\)/)
  assert.match(source, /待补样本导航/)
  assert.match(source, /定位下一条待补样本/)
  assert.match(source, /只切换当前复核目标，不保存、不启动 Worker 或模型/)
})

test('export page shows a read-only todo list for the selected regression sample', () => {
  assert.match(source, /const regressionReviewTargetTodoItems = computed/)
  assert.match(source, /当前样本待补项/)
  assert.match(source, /缺少技术质量报告/)
  assert.match(source, /技术质检阻塞/)
  assert.match(source, /画面证据/)
  assert.match(source, /字幕证据/)
  assert.match(source, /音频证据/)
  assert.match(source, /人物一致性证据/)
  assert.match(source, /人工批准/)
  assert.match(source, /只读清单，不保存、不启动 Worker 或模型/)
})

test('export page distinguishes saved final review evidence from live approval blockers', () => {
  assert.match(source, /const regressionReviewEvidenceSummaryItems = computed/)
  assert.match(source, /const regressionReviewApprovalBlockers = computed/)
  assert.match(source, /已留存终审证据/)
  assert.match(source, /审批前缺口/)
  assert.match(source, /画面证据/)
  assert.match(source, /字幕证据/)
  assert.match(source, /音频证据/)
  assert.match(source, /人物一致性证据/)
  assert.match(source, /缺少批准确认口令/)
  assert.match(source, /只读说明，不保存、不启动 Worker 或模型/)
})

test('export page explains the save scope for one regression sample review', () => {
  assert.match(source, /const regressionReviewSaveScopeItems = computed/)
  assert.match(source, /保存影响范围/)
  assert.match(source, /只更新当前质量报告/)
  assert.match(source, /不会发布到平台/)
  assert.match(source, /不会创建新导出/)
  assert.match(source, /不会启动 Worker 或模型/)
})

test('export page displays a read-only audit summary for one regression sample review', () => {
  assert.match(source, /const regressionReviewAuditItems = computed/)
  assert.match(source, /复核历史/)
  assert.match(source, /人工结论/)
  assert.match(source, /复核时间/)
  assert.match(source, /最后更新/)
  assert.match(source, /发布状态/)
  assert.match(source, /只读审计，不保存、不发布、不启动 Worker 或模型/)
})

test('export page warns when one regression sample review has unsaved draft changes', () => {
  assert.match(source, /const regressionReviewDraftStatusItems = computed/)
  assert.match(source, /hasRegressionReviewUnsavedDraft/)
  assert.match(source, /当前输入保存状态/)
  assert.match(source, /尚未保存的改动/)
  assert.match(source, /与报告一致/)
  assert.match(source, /当前输入尚未保存/)
  assert.match(source, /只读对比，不保存、不发布、不启动 Worker 或模型/)
})

test('export page can copy or download a read-only final review summary', () => {
  assert.match(source, /const regressionReviewSummaryText = computed/)
  assert.match(source, /const regressionReviewSummaryMessage = ref\(''\)/)
  assert.match(source, /function copyRegressionReviewSummary/)
  assert.match(source, /navigator\.clipboard\.writeText/)
  assert.match(source, /function downloadRegressionReviewSummary/)
  assert.match(source, /text\/plain/)
  assert.match(source, /复制终审摘要/)
  assert.match(source, /下载终审摘要/)
  assert.match(source, /只读摘要，不保存、不发布、不启动 Worker 或模型/)
})

test('export page provides a print-ready final review checklist without saving', () => {
  assert.match(source, /function printRegressionReviewChecklist/)
  assert.match(source, /window\.print\(\)/)
  assert.match(source, /打印签核清单/)
  assert.match(source, /class="regression-review-print-sheet"/)
  assert.match(source, /@media print/)
  assert.match(source, /打印版签核清单/)
  assert.match(source, /打印操作不保存、不发布、不启动 Worker 或模型/)
})
