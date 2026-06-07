import {
  type Incident,
  type IncidentSeverity,
  type IncidentStatus,
  db,
  schema,
} from "@superlog/db";
import { and, desc, eq, gte, ilike, lte, ne, or } from "drizzle-orm";

const INCIDENT_STATUSES: readonly IncidentStatus[] = [
  "open",
  "resolved",
  "autoresolved_noise",
  "merged",
];

function isIncidentStatus(value: string): value is IncidentStatus {
  return (INCIDENT_STATUSES as readonly string[]).includes(value);
}

export type IncidentSearchStatusFilter =
  | { kind: "exclude_noise" }
  | { kind: "all" }
  | { kind: "only"; status: IncidentStatus };

/**
 * Mirror the web list endpoint's default: with no status given, hide
 * agent-classified noise. `all` opts into every status; any concrete status
 * narrows to exactly that one. An unrecognised value is rejected so a typo
 * doesn't silently return the whole backlog.
 */
export function resolveIncidentSearchStatus(
  status: string | undefined,
): IncidentSearchStatusFilter {
  if (!status) return { kind: "exclude_noise" };
  if (status === "all") return { kind: "all" };
  if (isIncidentStatus(status)) return { kind: "only", status };
  throw new Error(`invalid incident status: ${status}`);
}

export type IncidentSummary = {
  id: string;
  projectId: string;
  codename: string;
  title: string;
  service: string | null;
  environment: string | null;
  severity: IncidentSeverity | null;
  status: IncidentStatus;
  firstSeen: string;
  lastSeen: string;
  issueCount: number;
  agentSummary: string | null;
  rootCauseText: string | null;
  rootCauseConfidence: number | null;
  estimatedImpactText: string | null;
  resolvedAt: string | null;
  resolvedReasonCode: string | null;
  mergedIntoId: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
};

/**
 * Compact, agent-friendly projection of an incident. Drops the heavy/internal
 * columns (noise & resolution classification blobs, slack install pointers,
 * autorecovery bookkeeping) and renders timestamps as ISO strings.
 */
export function toIncidentSummary(incident: Incident): IncidentSummary {
  return {
    id: incident.id,
    projectId: incident.projectId,
    codename: incident.codename,
    title: incident.title,
    service: incident.service,
    environment: incident.environment,
    severity: incident.severity,
    status: incident.status,
    firstSeen: incident.firstSeen.toISOString(),
    lastSeen: incident.lastSeen.toISOString(),
    issueCount: incident.issueCount,
    agentSummary: incident.agentSummary,
    rootCauseText: incident.rootCauseText,
    rootCauseConfidence: incident.rootCauseConfidence,
    estimatedImpactText: incident.estimatedImpactText,
    resolvedAt: incident.resolvedAt ? incident.resolvedAt.toISOString() : null,
    resolvedReasonCode: incident.resolvedReasonCode,
    mergedIntoId: incident.mergedIntoId,
    slackChannelId: incident.slackChannelId,
    slackThreadTs: incident.slackThreadTs,
  };
}

export type IncidentSearchInput = {
  status?: string;
  severity?: IncidentSeverity;
  service?: string;
  query?: string;
  since?: string;
  until?: string;
  limit?: number;
};

function parseTimestamp(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid ${label} timestamp: ${value}`);
  }
  return date;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

/**
 * Search a project's incidents by status, severity, service, free-text
 * (title/codename substring), and `last_seen` window. Newest activity first.
 */
export async function searchIncidents(
  projectId: string,
  input: IncidentSearchInput,
): Promise<IncidentSummary[]> {
  const conditions = [eq(schema.incidents.projectId, projectId)];

  const status = resolveIncidentSearchStatus(input.status);
  if (status.kind === "exclude_noise") {
    conditions.push(ne(schema.incidents.status, "autoresolved_noise"));
  } else if (status.kind === "only") {
    conditions.push(eq(schema.incidents.status, status.status));
  }

  if (input.severity) conditions.push(eq(schema.incidents.severity, input.severity));
  if (input.service) conditions.push(eq(schema.incidents.service, input.service));

  if (input.query) {
    const like = `%${input.query}%`;
    const textMatch = or(
      ilike(schema.incidents.title, like),
      ilike(schema.incidents.codename, like),
    );
    if (textMatch) conditions.push(textMatch);
  }

  const since = parseTimestamp(input.since, "since");
  if (since) conditions.push(gte(schema.incidents.lastSeen, since));
  const until = parseTimestamp(input.until, "until");
  if (until) conditions.push(lte(schema.incidents.lastSeen, until));

  const rows = await db.query.incidents.findMany({
    where: and(...conditions),
    orderBy: [desc(schema.incidents.lastSeen)],
    limit: clampLimit(input.limit),
  });

  return rows.map(toIncidentSummary);
}
