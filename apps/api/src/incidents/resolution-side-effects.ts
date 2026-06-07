import { and, eq } from "drizzle-orm";
import { logger } from "../logger.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

const log = logger.child({ scope: "incident-resolution-side-effects" });

export type ResolvedIncidentOpenPullRequest = {
  id: string;
  githubInstallationId: number;
  repoFullName: string;
  prNumber: number;
};

export type ResolvedIncidentSideEffectIncident = {
  id: string;
  title: string;
  service: string | null;
};

export type ResolvedIncidentSlackRoot = {
  text: string;
  blocks: unknown[];
};

export type ResolvedIncidentSideEffectDeps = {
  listOpenPullRequests(incidentId: string): Promise<ResolvedIncidentOpenPullRequest[]>;
  closePullRequest(
    pr: ResolvedIncidentOpenPullRequest,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  markPullRequestClosed(pr: ResolvedIncidentOpenPullRequest, closedAt: Date): Promise<void>;
  updateSlackRootMessage(input: {
    incident: ResolvedIncidentSideEffectIncident;
    text: string;
    blocks: unknown[];
  }): Promise<void>;
};

export async function runResolvedIncidentSideEffects(opts: {
  incident: ResolvedIncidentSideEffectIncident;
  projectName: string;
  deps: ResolvedIncidentSideEffectDeps;
}): Promise<{ closedPullRequestCount: number; failedPullRequestCount: number }> {
  const openPullRequests = await opts.deps.listOpenPullRequests(opts.incident.id);
  let closedPullRequestCount = 0;
  let failedPullRequestCount = 0;

  for (const pr of openPullRequests) {
    const closedAt = new Date();
    const result = await opts.deps.closePullRequest(pr);
    if (!result.ok) {
      failedPullRequestCount += 1;
      log.warn(
        {
          incident_id: opts.incident.id,
          agent_pr_id: pr.id,
          repo: pr.repoFullName,
          pr_number: pr.prNumber,
          error: result.error,
        },
        "failed to close incident PR after resolve",
      );
      continue;
    }
    await opts.deps.markPullRequestClosed(pr, closedAt);
    closedPullRequestCount += 1;
  }

  const slackRoot = buildResolvedIncidentSlackRoot({
    incident: opts.incident,
    projectName: opts.projectName,
  });
  await opts.deps.updateSlackRootMessage({
    incident: opts.incident,
    text: slackRoot.text,
    blocks: slackRoot.blocks,
  });

  return { closedPullRequestCount, failedPullRequestCount };
}

export async function runResolvedIncidentSideEffectsForIncident(opts: {
  incidentId: string;
  closePullRequest: ResolvedIncidentSideEffectDeps["closePullRequest"];
}): Promise<{ closedPullRequestCount: number; failedPullRequestCount: number } | null> {
  const { db, schema } = await import("@superlog/db");
  const incident = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, opts.incidentId),
  });
  if (!incident) return null;
  const project = await db.query.projects.findFirst({
    where: eq(schema.projects.id, incident.projectId),
  });
  return runResolvedIncidentSideEffects({
    incident: {
      id: incident.id,
      title: incident.title,
      service: incident.service,
    },
    projectName: project?.name ?? incident.projectId,
    deps: createResolvedIncidentSideEffectDeps({
      closePullRequest: opts.closePullRequest,
    }),
  });
}

export function buildResolvedIncidentSlackRoot(opts: {
  incident: ResolvedIncidentSideEffectIncident;
  projectName: string;
}): ResolvedIncidentSlackRoot {
  const incidentUrl = `${WEB_ORIGIN}/incidents/${opts.incident.id}`;
  const lines = [
    ":white_check_mark: *Incident resolved*",
    `*${opts.incident.title}*`,
    opts.incident.service
      ? `\`${opts.projectName}\` · \`${opts.incident.service}\``
      : `\`${opts.projectName}\``,
  ];
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in Superlog", emoji: true },
          url: incidentUrl,
          action_id: "open_superlog",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "💬 Give feedback", emoji: true },
          action_id: `give_feedback:${opts.incident.id}`,
        },
      ],
    },
  ];
  return {
    text: `:white_check_mark: ${opts.incident.title} - Incident resolved`,
    blocks,
  };
}

export function createResolvedIncidentSideEffectDeps(opts: {
  closePullRequest: ResolvedIncidentSideEffectDeps["closePullRequest"];
  updateSlackRootMessage?: ResolvedIncidentSideEffectDeps["updateSlackRootMessage"];
}): ResolvedIncidentSideEffectDeps {
  return {
    listOpenPullRequests: listOpenPullRequestsForIncident,
    closePullRequest: opts.closePullRequest,
    markPullRequestClosed: markPullRequestClosedForResolvedIncident,
    updateSlackRootMessage: opts.updateSlackRootMessage ?? updateResolvedIncidentSlackRootMessage,
  };
}

export async function updateResolvedIncidentSlackRootMessage(input: {
  incident: ResolvedIncidentSideEffectIncident;
  text: string;
  blocks: unknown[];
}): Promise<void> {
  const { db, schema } = await import("@superlog/db");
  const row = await db.query.incidents.findFirst({
    where: eq(schema.incidents.id, input.incident.id),
  });
  if (!row?.slackChannelId || !row.slackThreadTs || !row.slackInstallationId) return;

  const installation = await db.query.slackInstallations.findFirst({
    where: and(
      eq(schema.slackInstallations.id, row.slackInstallationId),
      eq(schema.slackInstallations.projectId, row.projectId),
    ),
  });
  if (!installation?.botAccessToken || installation.revokedAt) return;

  try {
    const res = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${installation.botAccessToken}`,
      },
      body: JSON.stringify({
        channel: row.slackChannelId,
        ts: row.slackThreadTs,
        text: input.text,
        blocks: input.blocks,
      }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!data?.ok) {
      log.warn(
        {
          incident_id: input.incident.id,
          channel: row.slackChannelId,
          error: data?.error ?? `status_${res.status}`,
        },
        "failed to update resolved incident Slack root",
      );
    }
  } catch (err) {
    log.warn({ err, incident_id: input.incident.id }, "resolved incident Slack root update threw");
  }
}

async function listOpenPullRequestsForIncident(
  incidentId: string,
): Promise<ResolvedIncidentOpenPullRequest[]> {
  const { db, schema } = await import("@superlog/db");
  const rows = await db
    .select({
      id: schema.agentPullRequests.id,
      repoFullName: schema.agentPullRequests.repoFullName,
      prNumber: schema.agentPullRequests.prNumber,
      githubInstallationId: schema.githubInstallations.installationId,
    })
    .from(schema.agentPullRequests)
    .innerJoin(
      schema.githubInstallations,
      eq(schema.githubInstallations.id, schema.agentPullRequests.installationId),
    )
    .where(
      and(
        eq(schema.agentPullRequests.incidentId, incidentId),
        eq(schema.agentPullRequests.state, "open"),
      ),
    );
  return rows;
}

async function markPullRequestClosedForResolvedIncident(
  pr: ResolvedIncidentOpenPullRequest,
  closedAt: Date,
): Promise<void> {
  const { db, schema } = await import("@superlog/db");
  await db
    .update(schema.agentPullRequests)
    .set({
      state: "closed",
      closedAt,
      lastSyncedAt: closedAt,
      updatedAt: closedAt,
    })
    .where(and(eq(schema.agentPullRequests.id, pr.id), eq(schema.agentPullRequests.state, "open")));

  await db
    .insert(schema.agentPrEvents)
    .values({
      agentPrId: pr.id,
      kind: "pr_closed",
      summary: `Closed PR #${pr.prNumber} because the incident was resolved.`,
      payload: { repoFullName: pr.repoFullName, prNumber: pr.prNumber },
      providerEventId: `pr_closed:incident_resolved:${pr.id}`,
      occurredAt: closedAt,
    })
    .onConflictDoNothing();
}
