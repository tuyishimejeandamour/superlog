import "../../agent-run.test-env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { incidentBlocks } from "./incident-messages.js";

function contextLine(blocks: unknown[]): string {
  const section = blocks[0] as { text: { text: string } };
  const lines = section.text.text.split("\n");
  return lines.at(-1) ?? "";
}

test("incidentBlocks renders project · service · environment as code chips", () => {
  const line = contextLine(
    incidentBlocks({
      emoji: "rotating_light",
      status: "New Incident",
      title: "boom",
      projectName: "Acme",
      service: "api",
      environment: "production",
      buttons: [],
    }),
  );
  assert.equal(line, "`Acme` · `api` · `production`");
});

test("incidentBlocks omits environment when absent", () => {
  const line = contextLine(
    incidentBlocks({
      emoji: "rotating_light",
      status: "New Incident",
      title: "boom",
      projectName: "Acme",
      service: "api",
      environment: null,
      buttons: [],
    }),
  );
  assert.equal(line, "`Acme` · `api`");
});
