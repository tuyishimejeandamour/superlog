import { strict as assert } from "node:assert";
import { test } from "node:test";

// slack.ts transitively imports the db client, which throws at import time
// without a connection string. Set a dummy URL before the dynamic import (the
// porsager client connects lazily, so these pure-function tests never open a
// socket). Same dynamic-import pattern as detail.test.ts / loops.test.ts.
process.env.DATABASE_URL ??= "postgres://localhost:5434/superlog";
process.env.BETTER_AUTH_SECRET ??= "test-secret";
const { preferPinnedInstallation } = await import("./slack.js");

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
