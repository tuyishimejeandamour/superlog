import { strict as assert } from "node:assert";
import { test } from "node:test";

// slack.ts transitively imports the db client, which throws at import time
// without a connection string. Set a dummy URL before the dynamic import (the
// porsager client connects lazily, so these pure-function tests never open a
// socket). Same dynamic-import pattern as detail.test.ts / loops.test.ts.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-with-enough-length";
const { preferPinnedInstallation } = await import("./slack.js");

type FakeResponse = { ok: boolean; channels?: unknown[]; error?: string; cursor?: string };

function fakeFetch(pages: FakeResponse[]) {
  const calls: URL[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(input as URL);
    const page = pages[i++] ?? { ok: true, channels: [] };
    const body: Record<string, unknown> = { ok: page.ok };
    if (page.error) body.error = page.error;
    if (page.channels) body.channels = page.channels;
    if (page.cursor) body.response_metadata = { next_cursor: page.cursor };
    return { json: async () => body } as unknown as Response;
  };
  return { fetchImpl, calls };
}

// Regression guard: a workspace installed into multiple Superlog projects owns
// several non-revoked `slack_installations` rows (upsertInstallation keys by
// project). Slack only keeps the most-recently-refreshed bot token live, so an
// unordered team-wide lookup can hand back a stale row whose token fails every
// API call with `invalid_auth` — which is exactly what broke the incident
// feedback modal (views.open -> invalid_auth). Incidents/proposals pin the
// exact installation that posted their thread, so that pin must win.
test("prefers the installation pinned to the incident over a team-wide match", () => {
  const pinned = { id: "pinned", botAccessToken: "live" };
  const teamFallback = { id: "other", botAccessToken: "stale" };
  assert.equal(preferPinnedInstallation(pinned, teamFallback), pinned);
});

test("falls back to the team match when the incident has no pinned installation", () => {
  const teamFallback = { id: "other", botAccessToken: "stale" };
  assert.equal(preferPinnedInstallation(null, teamFallback), teamFallback);
});

test("returns null when neither a pin nor a team match resolves", () => {
  assert.equal(preferPinnedInstallation(null, null), null);
});

test("listSlackChannels requests both public and private channels", async () => {
  const { listSlackChannels } = await import("./slack.js");
  const { fetchImpl, calls } = fakeFetch([{ ok: true, channels: [] }]);

  await listSlackChannels("xoxb-token", fetchImpl);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.searchParams.get("types"), "public_channel,private_channel");
  assert.equal(calls[0]?.searchParams.get("exclude_archived"), "true");
});

test("listSlackChannels follows cursor pagination and aggregates all channels", async () => {
  const { listSlackChannels } = await import("./slack.js");
  const { fetchImpl, calls } = fakeFetch([
    {
      ok: true,
      channels: [{ id: "C1", name: "general", is_private: false }],
      cursor: "page2",
    },
    {
      ok: true,
      channels: [{ id: "G1", name: "secret-room", is_private: true }],
    },
  ]);

  const result = await listSlackChannels("xoxb-token", fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.searchParams.get("cursor"), "page2");
  assert.ok(result.ok);
  assert.deepEqual(result.channels, [
    { id: "C1", name: "general", isPrivate: false },
    { id: "G1", name: "secret-room", isPrivate: true },
  ]);
  // the private channel must survive into the final list
  assert.ok(result.channels.some((c) => c.isPrivate && c.name === "secret-room"));
});

test("listSlackChannels returns the Slack error without paginating further", async () => {
  const { listSlackChannels } = await import("./slack.js");
  const { fetchImpl, calls } = fakeFetch([{ ok: false, error: "token_revoked" }]);

  const result = await listSlackChannels("xoxb-token", fetchImpl);

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.ok(!result.ok);
  assert.equal(result.error, "token_revoked");
});

test("listSlackChannels returns an error when the page cap is exhausted", async () => {
  const { listSlackChannels } = await import("./slack.js");
  const { fetchImpl, calls } = fakeFetch(
    Array.from({ length: 50 }, (_, i) => ({
      ok: true,
      channels: [{ id: `C${i}`, name: `channel-${i}` }],
      cursor: `page-${i + 1}`,
    })),
  );

  const result = await listSlackChannels("xoxb-token", fetchImpl);

  assert.equal(calls.length, 50);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.error, "pagination_limit_exceeded");
});
