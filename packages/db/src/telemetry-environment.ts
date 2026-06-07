// Pull the deployment environment (e.g. "production", "staging") out of a
// telemetry resource-attribute map. Errors carry this on their trace/log
// resource attributes; we surface it on incidents, issues, and Slack alerts.
//
// Keys are checked in priority order: the current OTel semantic-convention
// key first, then the older/deprecated form, then the bare `env` shorthand
// that plenty of SDKs still emit. Matching mirrors the defaults the Settings
// attribute preview uses (`apps/web/src/Settings.tsx`) and the resource keys
// the trace-context formatter pulls (`infra/clickhouse/trace-context.ts`).
const ENVIRONMENT_ATTR_KEYS = [
  "deployment.environment.name",
  "deployment.environment",
  "env",
] as const;

export function environmentFromResourceAttrs(
  attrs: Record<string, string> | null | undefined,
): string | null {
  if (!attrs) return null;
  for (const key of ENVIRONMENT_ATTR_KEYS) {
    const value = attrs[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}
