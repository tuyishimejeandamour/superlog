import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type StsVerifier,
  buildConnectQuickCreateUrl,
  generateExternalId,
  parseAccountIdFromRoleArn,
  verifyConnection,
} from "./cloud-connections-service.js";

test("generateExternalId produces unguessable, url-safe, unique ids", () => {
  const a = generateExternalId();
  const b = generateExternalId();
  assert.notEqual(a, b);
  // high-entropy, url-safe (base64url alphabet), no padding
  assert.match(a, /^[A-Za-z0-9_-]{40,}$/);
});

test("buildConnectQuickCreateUrl builds a CloudFormation quick-create console link", () => {
  const url = buildConnectQuickCreateUrl({
    region: "us-west-2",
    templateUrl: "https://superlog-cfn.s3.amazonaws.com/aws-connect.yaml",
    stackName: "superlog-connect",
    params: {
      ExternalId: "ext-123",
      SuperlogAccountId: "123456789012",
      IngestKey: "sl_public_abc",
      IntakeUrl: "https://intake.example.com/aws/firehose",
    },
  });

  const u = new URL(url);
  assert.equal(u.host, "us-west-2.console.aws.amazon.com");
  assert.equal(u.pathname, "/cloudformation/home");
  assert.equal(u.searchParams.get("region"), "us-west-2");

  // The console keeps its routing + stack params in the fragment.
  assert.ok(u.hash.startsWith("#/stacks/quickcreate?"), `hash was ${u.hash}`);
  const frag = new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1));
  assert.equal(frag.get("templateURL"), "https://superlog-cfn.s3.amazonaws.com/aws-connect.yaml");
  assert.equal(frag.get("stackName"), "superlog-connect");
  assert.equal(frag.get("param_ExternalId"), "ext-123");
  assert.equal(frag.get("param_SuperlogAccountId"), "123456789012");
  assert.equal(frag.get("param_IngestKey"), "sl_public_abc");
  assert.equal(frag.get("param_IntakeUrl"), "https://intake.example.com/aws/firehose");
});

test("buildConnectQuickCreateUrl rejects a region that could hijack the hostname", () => {
  assert.throws(() =>
    buildConnectQuickCreateUrl({
      region: "evil.com/x",
      templateUrl: "https://cfn.example/t.yaml",
      stackName: "s",
      params: {},
    }),
  );
  assert.throws(() =>
    buildConnectQuickCreateUrl({
      region: "us-west-2.attacker.com",
      templateUrl: "https://cfn.example/t.yaml",
      stackName: "s",
      params: {},
    }),
  );
});

test("parseAccountIdFromRoleArn extracts the account id, null on garbage", () => {
  assert.equal(
    parseAccountIdFromRoleArn("arn:aws:iam::123456789012:role/SuperlogScrape"),
    "123456789012",
  );
  assert.equal(parseAccountIdFromRoleArn("not-an-arn"), null);
  assert.equal(parseAccountIdFromRoleArn("arn:aws:iam::short:role/x"), null);
});

const ROLE_ARN = "arn:aws:iam::123456789012:role/SuperlogScrape";

test("verifyConnection returns connected + accountId when assume-role succeeds", async () => {
  const sts: StsVerifier = {
    async verifyAssumeRole(input) {
      assert.equal(input.roleArn, ROLE_ARN);
      assert.equal(input.externalId, "ext-xyz");
      return { accountId: "123456789012" };
    },
  };
  const result = await verifyConnection({ roleArn: ROLE_ARN, externalId: "ext-xyz" }, sts);
  assert.deepEqual(result, { status: "connected", accountId: "123456789012" });
});

test("verifyConnection returns failed (not throw) when assume-role is denied", async () => {
  const sts: StsVerifier = {
    async verifyAssumeRole() {
      throw new Error("AccessDenied: not authorized to assume role");
    },
  };
  const result = await verifyConnection({ roleArn: ROLE_ARN, externalId: "ext-xyz" }, sts);
  assert.equal(result.status, "failed");
});

test("verifyConnection flags account mismatch between ARN and caller identity", async () => {
  const sts: StsVerifier = {
    async verifyAssumeRole() {
      // role assumed, but identity resolves to a different account
      return { accountId: "999999999999" };
    },
  };
  const result = await verifyConnection({ roleArn: ROLE_ARN, externalId: "ext-xyz" }, sts);
  assert.equal(result.status, "account_mismatch");
});
