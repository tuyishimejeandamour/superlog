import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createProjectInputSchema,
  projectResponseSchema,
  updateProjectInputSchema,
} from "./management-schemas.js";

test("management API project schemas accept project context", () => {
  const create = createProjectInputSchema.parse({
    name: "Billing",
    slug: "billing",
    project_context: "Stripe customer IDs are scoped per org.",
  });
  assert.equal(create.project_context, "Stripe customer IDs are scoped per org.");

  const update = updateProjectInputSchema.parse({
    project_context: "Billing jobs run from apps/worker.",
  });
  assert.equal(update.project_context, "Billing jobs run from apps/worker.");

  const response = projectResponseSchema.parse({
    project: {
      id: "00000000-0000-4000-8000-000000000000",
      name: "Billing",
      slug: "billing",
      project_context: "Stripe customer IDs are scoped per org.",
      automerge_fix_prs: "never",
      automerge_method: "squash",
      pr_base_branch: null,
    },
  });
  assert.equal(response.project.project_context, "Stripe customer IDs are scoped per org.");
});

test("management API project context is capped", () => {
  assert.throws(
    () => updateProjectInputSchema.parse({ project_context: "x".repeat(8001) }),
    /Too big/,
  );
});
