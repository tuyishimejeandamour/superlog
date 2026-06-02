import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LANDING_GITHUB_REPO_URL } from "./landingLinks.ts";

test("landing navbar uses the public Superlog GitHub repository URL", () => {
  assert.equal(LANDING_GITHUB_REPO_URL, "https://github.com/superloglabs/superlog");
});

test("landing top nav renders a GitHub link wired to the repository URL", async () => {
  const source = await readFile(new URL("./Landing.tsx", import.meta.url), "utf8");

  assert.match(source, /href=\{LANDING_GITHUB_REPO_URL\}[\s\S]*<GitHubIcon \/>[\s\S]*GitHub\s*<\/a>/);
});
