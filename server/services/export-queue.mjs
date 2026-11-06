export function startExportQueueSweep({
  sweep,
  intervalMs,
  onError = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof sweep !== 'function') throw new TypeError('sweep must be a function')
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError('intervalMs must be a positive safe integer')
  }
  if (typeof onError !== 'function') throw new TypeError('onError must be a function')

  const timer = setIntervalFn(() => Promise.resolve().then(sweep).catch(onError), intervalMs)
  timer?.unref?.()
  return () => clearIntervalFn(timer)
}
