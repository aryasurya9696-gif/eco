/**
 * Returns the URL only when it is an absolute http(s) link.
 *
 * Post URLs come from third-party search results, so a `javascript:` or
 * `data:` value must never reach an href.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
