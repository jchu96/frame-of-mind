export function isHostedSensitivePath(path: string): boolean {
  return path.startsWith("apps/web/server-hosted/")
    || path.startsWith("apps/workflows/")
    || /^scripts\/test-hosted-/.test(path)
    || path.startsWith("apps/web/db/migrations/");
}
