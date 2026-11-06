export async function drainQueuedAgentPipelines({ db, execute, limit = 20 }) {
  const [rows] = await db.execute(
    `SELECT id FROM agent_pipeline_runs WHERE status = 'queued' ORDER BY id ASC LIMIT ?`,
    [Math.max(1, Math.min(100, Number(limit) || 20))],
  )
  let claimed = 0
  let failed = 0

  for (const row of rows) {
    const runId = Number(row.id)
    const [claim] = await db.execute(
      `UPDATE agent_pipeline_runs
       SET status = 'running', error_text = NULL, updated_at = NOW()
       WHERE id = ? AND status = 'queued'`,
      [runId],
    )
    if (Number(claim.affectedRows || 0) !== 1) continue
    claimed += 1

    const [runRows] = await db.execute(
      `SELECT * FROM agent_pipeline_runs WHERE id = ? AND status = 'running' LIMIT 1`,
      [runId],
    )
    if (!runRows[0]) continue

    try {
      const result = await execute(runRows[0])
      if (['failed', 'retryable_failed'].includes(result?.status)) failed += 1
    } catch (error) {
      const message = String(error instanceof Error ? error.message : 'Agent Pipeline 阶段执行失败').slice(0, 2000)
      await db.execute(
        `UPDATE agent_pipeline_runs
         SET status = 'retryable_failed', error_text = ?, updated_at = NOW()
         WHERE id = ? AND status = 'running'`,
        [message, runId],
      )
      failed += 1
    }
  }

  return { claimed, failed }
}

export async function recoverInterruptedAgentPipelines(db) {
  const interruption = 'Worker 在阶段执行期间重启；为避免重复触发外部副作用，本次运行已标为可重试失败'
  await db.execute(
    `UPDATE agent_pipeline_executions e
     INNER JOIN agent_pipeline_runs r ON r.id = e.pipeline_run_id
     SET e.status = 'retryable_failed', e.error_text = ?, e.finished_at = NOW(), e.updated_at = NOW()
     WHERE r.status = 'running' AND e.status = 'running'`,
    [interruption],
  )
  await db.execute(
    `UPDATE agent_pipeline_runs
     SET status = 'retryable_failed', error_text = ?, updated_at = NOW()
     WHERE status = 'running'`,
    [interruption],
  )
}
