/**
 * Origin normalization helpers for the MCP panel API.
 * Kept dependency-free so they can be unit-tested without loading DSH.
 *
 * @module dsh-plugin-mcp-toggles/origin
 */

/**
 * Normalize one HTTP Origin value to its serialized origin.
 * Invalid values and non-HTTP(S) schemes are rejected.
 * @param value Raw Origin header or configured value.
 * @returns The normalized origin, or `undefined`.
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/**
 * Whether a request Origin is acceptable. A missing Origin is allowed: the
 * random header token still protects state-changing requests.
 * @param origin The request `Origin` header, when present.
 * @param allowed Set/array of normalized origins.
 * @returns Whether the origin is allowed.
 */
export function originAllowed(origin, allowed) {
  if (origin === undefined || origin === null || origin === '') return true
  const normalized = normalizeOrigin(origin)
  if (normalized === undefined) return false
  if (allowed instanceof Set) return allowed.has(normalized)
  return Array.isArray(allowed) && allowed.includes(normalized)
}
