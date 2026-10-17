/** The new post-MFA landing page is /app, not necessarily /app/inbox.
 * Match pathname only: /login?next=/app must never count as authenticated.
 */
export function isAppUrl(url: URL): boolean {
  return url.pathname === "/app" || url.pathname.startsWith("/app/");
}
