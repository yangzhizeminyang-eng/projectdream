export function assetNodeRowId(row = {}) {
  const value = Number(row.asset_node_id ?? row.assetNodeId ?? row.id)
  return Number.isInteger(value) && value > 0 ? value : null
}
