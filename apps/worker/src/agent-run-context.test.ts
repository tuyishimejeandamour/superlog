import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentRunInstructions } from "./agent-run-instructions.js";

test("agent run instructions include org guidance, project context, and project instructions", () => {
  const instructions = buildAgentRunInstructions({
    orgInstructions: "Prefer small patches.",
    projectContext: "This project is the billing API. Stripe IDs are customer-scoped.",
    projectInstructions: "Run billing tests before opening a PR.",
  });

  assert.equal(
    instructions,
    [
      "Prefer small patches.",
      "Project context:\nThis project is the billing API. Stripe IDs are customer-scoped.",
      "Run billing tests before opening a PR.",
    ].join("\n\n"),
  );
});

test("agent run instructions skip blank project context", () => {
  const instructions = buildAgentRunInstructions({
    orgInstructions: "Prefer small patches.",
    projectContext: "   ",
    projectInstructions: "Run billing tests before opening a PR.",
  });

  assert.equal(instructions, "Prefer small patches.\n\nRun billing tests before opening a PR.");
});
