export function siteRoute(siteUrl: string, route: string): string {
  const base = siteUrl.trim().replace(/\/?$/, '/');
  return new URL(route.replace(/^\//, ''), base).toString();
}
