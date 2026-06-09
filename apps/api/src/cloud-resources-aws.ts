import { CloudControlClient, GetResourceCommand } from "@aws-sdk/client-cloudcontrol";
import {
  GetResourcesCommand,
  ResourceGroupsTaggingAPIClient,
} from "@aws-sdk/client-resource-groups-tagging-api";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import type {
  ConfigFetcher,
  DiscoveredResource,
  ResourceLister,
} from "./cloud-resources-service.js";

type TempCreds = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

/** Assume the customer's scrape role and return short-lived credentials. */
async function assumeScrapeRole(
  sts: STSClient,
  roleArn: string,
  externalId: string,
): Promise<TempCreds> {
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      ExternalId: externalId,
      RoleSessionName: "superlog-inventory",
      DurationSeconds: 900,
    }),
  );
  const c = assumed.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error("AssumeRole returned no credentials");
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
  };
}

/**
 * Real {@link ResourceLister}: assume the scrape role, page
 * ResourceGroupsTaggingAPI in the connection's region.
 */
export function createResourceLister(): ResourceLister {
  const sts = new STSClient({});
  return {
    async list({ roleArn, externalId, region }) {
      const credentials = await assumeScrapeRole(sts, roleArn, externalId);
      const tagging = new ResourceGroupsTaggingAPIClient({ region, credentials });

      const out: DiscoveredResource[] = [];
      let paginationToken: string | undefined;
      do {
        const page = await tagging.send(
          new GetResourcesCommand({ ResourcesPerPage: 100, PaginationToken: paginationToken }),
        );
        for (const m of page.ResourceTagMappingList ?? []) {
          if (!m.ResourceARN) continue;
          const tags: Record<string, string> = {};
          for (const t of m.Tags ?? []) {
            if (t.Key) tags[t.Key] = t.Value ?? "";
          }
          out.push({ arn: m.ResourceARN, tags, raw: m });
        }
        paginationToken = page.PaginationToken || undefined;
      } while (paginationToken);
      return out;
    },
  };
}

// Errors that just mean "no config for this one" — swallow to null, don't throw.
const SOFT_ERRORS = new Set([
  "ResourceNotFoundException",
  "AccessDeniedException",
  "UnsupportedActionException",
  "TypeNotFoundException",
  "GeneralServiceException",
  "InvalidRequestException",
]);

/**
 * Real {@link ConfigFetcher}: assume the scrape role, then read one resource's
 * configuration via Cloud Control. Returns null for not-found / denied / types
 * Cloud Control can't read, so enrichment stays best-effort.
 */
export function createConfigFetcher(): ConfigFetcher {
  const sts = new STSClient({});
  return {
    async get({ roleArn, externalId, region, ref }) {
      const credentials = await assumeScrapeRole(sts, roleArn, externalId);
      // Cloud Control throttles aggressively — adaptive retry smooths bursts.
      const client = new CloudControlClient({
        region,
        credentials,
        maxAttempts: 6,
        retryMode: "adaptive",
      });
      try {
        const res = await client.send(
          new GetResourceCommand({ TypeName: ref.typeName, Identifier: ref.identifier }),
        );
        const props = res.ResourceDescription?.Properties;
        return props ? (JSON.parse(props) as Record<string, unknown>) : null;
      } catch (err) {
        const name = (err as { name?: string })?.name ?? "";
        if (SOFT_ERRORS.has(name)) return null;
        // Unexpected (e.g. throttling that outlived retries) — surface it.
        console.warn(`[cloudcontrol] ${ref.typeName} ${ref.identifier}: ${name}`);
        throw err;
      }
    },
  };
}
