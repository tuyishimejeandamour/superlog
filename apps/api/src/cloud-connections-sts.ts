import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type { StsVerifier } from "./cloud-connections-service.js";

/**
 * Real {@link StsVerifier} backed by @aws-sdk/client-sts. The API task's own role
 * is the trusted principal in the customer's role trust policy, so the default
 * credential chain (the task role) is what AssumeRole runs as.
 *
 * We resolve the account from the AssumedRoleUser ARN that AssumeRole returns
 * (`arn:aws:sts::<accountId>:assumed-role/...`) — no extra GetCallerIdentity call
 * needed. A successful AssumeRole is itself the proof the role + externalId trust
 * is wired correctly.
 */
export function createStsVerifier(opts?: { region?: string }): StsVerifier {
  const client = new STSClient({ region: opts?.region ?? "us-east-1" });
  return {
    async verifyAssumeRole({ roleArn, externalId }) {
      const out = await client.send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          ExternalId: externalId,
          RoleSessionName: "superlog-connect-verify",
          DurationSeconds: 900,
        }),
      );
      const assumedArn = out.AssumedRoleUser?.Arn;
      const accountId = assumedArn
        ? /^arn:aws[a-z-]*:sts::(\d{12}):/.exec(assumedArn)?.[1]
        : undefined;
      if (!accountId) {
        throw new Error("AssumeRole succeeded but returned no account id");
      }
      return { accountId };
    },
  };
}
