export function resolveCinematicExportStatus({ passed = false } = {}) {
  return passed === true ? 'completed' : 'blocked'
}
