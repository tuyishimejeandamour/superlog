import { db, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import { closeAgentPullRequestOnGithub } from "../github-app.js";
import { logger } from "../logger.js";

const log = logger.child({ scope: "incident-resolution-side-effects" });

export async function closeOpenPullRequestsForResolvedIncident(
  incidentId: string,
): Promise<{ closedPullRequestCount: number; failedPullRequestCount: number }> {
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

  let closedPullRequestCount = 0;
  let failedPullRequestCount = 0;
  for (const pr of rows) {
    const closedAt = new Date();
    const result = await closeAgentPullRequestOnGithub({
      installationId: pr.githubInstallationId,
      repoFullName: pr.repoFullName,
      prNumber: pr.prNumber,
    });
    if (!result.ok) {
      failedPullRequestCount += 1;
      log.warn(
        {
          incident_id: incidentId,
          agent_pr_id: pr.id,
          repo: pr.repoFullName,
          pr_number: pr.prNumber,
          error: result.error,
        },
        "failed to close incident PR after resolve",
      );
      continue;
    }
    await db
      .update(schema.agentPullRequests)
      .set({
        state: "closed",
        closedAt,
        lastSyncedAt: closedAt,
        updatedAt: closedAt,
      })
      .where(
        and(eq(schema.agentPullRequests.id, pr.id), eq(schema.agentPullRequests.state, "open")),
      );
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
    closedPullRequestCount += 1;
  }
  return { closedPullRequestCount, failedPullRequestCount };
}
