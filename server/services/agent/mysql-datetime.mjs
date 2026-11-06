export function normalizeMysqlDateTime(value) {
  if (value === null || value === undefined || value === '') return null

  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) {
    throw new Error(`无法转换为 MySQL DATETIME：${String(value)}`)
  }

  return date.toISOString().slice(0, 19).replace('T', ' ')
}
