const BROWSER_MEDIA_PATH = /^\/(?:generated|storage|mock)(?:\/|$)/i

/**
 * Normalize application media URLs for the origin that rendered the page.
 * Production may expose the same host on a non-default port while older jobs
 * persist a URL without that port. Provider/CDN URLs stay intact.
 */
export function normalizeBrowserMediaUrl(value: string, browserOrigin?: string): string {
  const raw = String(value || '').trim()
  if (!raw) return raw

  const origin = String(browserOrigin || '').trim()
  if (!origin) return raw

  try {
    const current = new URL(origin)
    const url = new URL(raw, current.origin)
    const hostname = url.hostname.toLowerCase()
    const sameHost = hostname === current.hostname.toLowerCase()
    const localHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname)
    if (BROWSER_MEDIA_PATH.test(url.pathname) && (sameHost || localHost)) {
      return new URL(`${url.pathname}${url.search}${url.hash}`, current.origin).toString()
    }
    return url.toString()
  } catch {
    return raw
  }
}
