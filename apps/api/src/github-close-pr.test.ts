import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-with-enough-length";

const { closeGithubPullRequestWithToken } = await import("./github.js");

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

test("closeGithubPullRequestWithToken closes by node id before repo URL fallback", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${input.toString()}`);
    assert.equal(JSON.parse(init?.body as string).variables.pullRequestId, "PR_node_1");
    return jsonResponse({ data: { closePullRequest: { pullRequest: { id: "PR_node_1" } } } });
  };

  const result = await closeGithubPullRequestWithToken({
    token: "token",
    repoFullName: "old-owner/old-repo",
    prNumber: 241,
    prNodeId: "PR_node_1",
    userAgent: "test",
    fetchImpl,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["POST https://api.github.com/graphql"]);
});

test("closeGithubPullRequestWithToken falls back to repo URL when node close fails", async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${input.toString()}`);
    if (input.toString().endsWith("/graphql")) {
      return jsonResponse({ errors: [{ message: "not found" }] });
    }
    assert.equal(init?.body, JSON.stringify({ state: "closed" }));
    return jsonResponse({ state: "closed" });
  };

  const result = await closeGithubPullRequestWithToken({
    token: "token",
    repoFullName: "current-owner/current-repo",
    prNumber: 241,
    prNodeId: "PR_node_1",
    userAgent: "test",
    fetchImpl,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    "POST https://api.github.com/graphql",
    "PATCH https://api.github.com/repos/current-owner/current-repo/pulls/241",
  ]);
});
