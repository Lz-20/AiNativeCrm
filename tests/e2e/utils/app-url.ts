/** The new post-MFA landing page is /app, not necessarily /app/inbox.
 * Match pathname only: /login?next=/app must never count as authenticated.
 */
export function isAppUrl(url: URL): boolean {
  return url.pathname === "/app" || url.pathname.startsWith("/app/");
}

/** Login/MFA may finish at /app itself. Require the configured app origin too:
 * a foreign /app or /login?next=/app is not a successful authenticated landing.
 */
export function appUrlAtOrigin(origin: string): (url: URL) => boolean {
  const expectedOrigin = new URL(origin).origin;
  return (url) => url.origin === expectedOrigin && isAppUrl(url);
}
