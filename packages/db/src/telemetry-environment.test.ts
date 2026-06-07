import assert from "node:assert/strict";
import { test } from "node:test";
import { environmentFromResourceAttrs } from "./telemetry-environment.js";

test("returns null for missing attrs", () => {
  assert.equal(environmentFromResourceAttrs(null), null);
  assert.equal(environmentFromResourceAttrs(undefined), null);
  assert.equal(environmentFromResourceAttrs({}), null);
});

test("prefers the current OTel semconv key", () => {
  assert.equal(
    environmentFromResourceAttrs({
      "deployment.environment.name": "production",
      "deployment.environment": "staging",
      env: "dev",
    }),
    "production",
  );
});

test("falls back to the deprecated key then to env", () => {
  assert.equal(environmentFromResourceAttrs({ "deployment.environment": "staging" }), "staging");
  assert.equal(environmentFromResourceAttrs({ env: "dev" }), "dev");
});

test("ignores blank values and trims", () => {
  assert.equal(
    environmentFromResourceAttrs({ "deployment.environment.name": "   ", env: "prod" }),
    "prod",
  );
  assert.equal(
    environmentFromResourceAttrs({ "deployment.environment": "  staging  " }),
    "staging",
  );
});
