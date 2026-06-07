import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildResolvedIncidentSlackRoot,
  runResolvedIncidentSideEffects,
  type ResolvedIncidentOpenPullRequest,
} from "./resolution-side-effects.js";

test("runResolvedIncidentSideEffects closes every open PR and refreshes Slack root", async () => {
  const calls: string[] = [];
  const prs: ResolvedIncidentOpenPullRequest[] = [
    {
      id: "pr-1",
      githubInstallationId: 101,
      repoFullName: "acme/api",
      prNumber: 12,
    },
    {
      id: "pr-2",
      githubInstallationId: 202,
      repoFullName: "acme/web",
      prNumber: 34,
    },
  ];

  const result = await runResolvedIncidentSideEffects({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
    },
    projectName: "Acme",
    deps: {
      listOpenPullRequests: async (incidentId) => {
        calls.push(`list:${incidentId}`);
        return prs;
      },
      closePullRequest: async (pr) => {
        calls.push(`close:${pr.repoFullName}#${pr.prNumber}`);
        return { ok: true };
      },
      markPullRequestClosed: async (pr, closedAt) => {
        calls.push(`mark:${pr.id}:${closedAt instanceof Date}`);
      },
      updateSlackRootMessage: async (input) => {
        calls.push(`slack:${input.incident.id}:${input.text}`);
      },
    },
  });

  assert.deepEqual(result, { closedPullRequestCount: 2, failedPullRequestCount: 0 });
  assert.deepEqual(calls, [
    "list:inc-1",
    "close:acme/api#12",
    "mark:pr-1:true",
    "close:acme/web#34",
    "mark:pr-2:true",
    "slack:inc-1::white_check_mark: Checkout API timeout - Incident resolved",
  ]);
});

test("runResolvedIncidentSideEffects leaves failed PRs open but still refreshes Slack", async () => {
  const calls: string[] = [];
  const result = await runResolvedIncidentSideEffects({
    incident: { id: "inc-1", title: "Checkout API timeout", service: null },
    projectName: "Acme",
    deps: {
      listOpenPullRequests: async () => [
        {
          id: "pr-1",
          githubInstallationId: 101,
          repoFullName: "acme/api",
          prNumber: 12,
        },
      ],
      closePullRequest: async () => {
        calls.push("close");
        return { ok: false, error: "rate_limited" };
      },
      markPullRequestClosed: async () => {
        calls.push("mark");
      },
      updateSlackRootMessage: async () => {
        calls.push("slack");
      },
    },
  });

  assert.deepEqual(result, { closedPullRequestCount: 0, failedPullRequestCount: 1 });
  assert.deepEqual(calls, ["close", "slack"]);
});

test("buildResolvedIncidentSlackRoot removes resolve action and keeps feedback action", () => {
  const update = buildResolvedIncidentSlackRoot({
    incident: {
      id: "inc-1",
      title: "Checkout API timeout",
      service: "checkout-api",
    },
    projectName: "Acme",
  });

  assert.equal(update.text, ":white_check_mark: Checkout API timeout - Incident resolved");
  assert.equal(JSON.stringify(update.blocks).includes("resolve_incident:"), false);
  assert.equal(JSON.stringify(update.blocks).includes("give_feedback:inc-1"), true);
});
