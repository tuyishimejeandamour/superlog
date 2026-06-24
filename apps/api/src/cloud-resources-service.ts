import { db, schema } from "@superlog/db";
import { and, eq, isNull, notInArray } from "drizzle-orm";

export type ParsedArn = {
  partition: string;
  service: string;
  region: string;
  accountId: string;
  resourceType: string;
  resourceId: string;
};

/**
 * Parse an AWS ARN into its parts. The resource segment can be `type/id`,
 * `type:id`, or a bare `id` (e.g. an S3 bucket) — we normalise all three.
 * Returns null for anything that isn't an ARN.
 */
export function parseArn(arn: string): ParsedArn | null {
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return null;
  const [, partition, service, region, accountId] = parts;
  const rest = parts.slice(5).join(":");
  let resourceType = "";
  let resourceId = rest;
  // Split on whichever delimiter appears FIRST. Some ARNs are mixed-format
  // (e.g. autoscaling: `autoScalingGroup:<id>:autoScalingGroupName/<name>`),
  // where `:` separates the type but `/` appears later inside the id — always
  // preferring `/` would mis-parse the type.
  const slash = rest.indexOf("/");
  const colon = rest.indexOf(":");
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    resourceType = rest.slice(0, colon);
    resourceId = rest.slice(colon + 1);
  } else if (slash !== -1) {
    resourceType = rest.slice(0, slash);
    resourceId = rest.slice(slash + 1);
  }
  return {
    partition: partition ?? "",
    service: service ?? "",
    region: region ?? "",
    accountId: accountId ?? "",
    resourceType,
    resourceId,
  };
}

export type CloudControlRef = { typeName: string; identifier: string };

// (service:resourceType) → Cloud Control type name, for the resources we enrich.
// Best-effort: anything not here is left config-less (Cloud Control only covers
// CloudFormation-registry types anyway).
const CLOUD_CONTROL_TYPES: Record<string, string> = {
  "ec2:instance": "AWS::EC2::Instance",
  "ec2:security-group": "AWS::EC2::SecurityGroup",
  "rds:db": "AWS::RDS::DBInstance",
  "lambda:function": "AWS::Lambda::Function",
  "elasticloadbalancing:loadbalancer": "AWS::ElasticLoadBalancingV2::LoadBalancer",
  "ecs:service": "AWS::ECS::Service",
  "autoscaling:autoScalingGroup": "AWS::AutoScaling::AutoScalingGroup",
};

/**
 * Map an ARN to its Cloud Control `(typeName, identifier)`, or null if we don't
 * enrich that type. Identifier is usually the resource id, with per-type quirks:
 * load balancers key on the full ARN; ECS services use the composite
 * `ServiceArn|Cluster`.
 */
export function arnToCloudControl(arn: string): CloudControlRef | null {
  const parsed = parseArn(arn);
  if (!parsed) return null;
  const typeName = CLOUD_CONTROL_TYPES[`${parsed.service}:${parsed.resourceType}`];
  if (!typeName) return null;

  if (typeName === "AWS::ElasticLoadBalancingV2::LoadBalancer") {
    return { typeName, identifier: arn };
  }
  if (typeName === "AWS::ECS::Service") {
    // resourceId is "cluster/service"; Cloud Control wants "serviceArn|cluster".
    const cluster = parsed.resourceId.split("/")[0] ?? "";
    return { typeName, identifier: `${arn}|${cluster}` };
  }
  if (typeName === "AWS::AutoScaling::AutoScalingGroup") {
    // resourceId is "<id>:autoScalingGroupName/<name>"; the identifier is <name>.
    return { typeName, identifier: parsed.resourceId.split("/").pop() ?? parsed.resourceId };
  }
  return { typeName, identifier: parsed.resourceId };
}

/** A resource as returned by the lister (ResourceGroupsTaggingAPI mapping). */
export type DiscoveredResource = {
  arn: string;
  tags: Record<string, string>;
  raw?: unknown;
};

/**
 * Port: list a connection's AWS resources. The real adapter assumes the scrape
 * role and pages ResourceGroupsTaggingAPI; tests pass a fake.
 */
export type ResourceLister = {
  list(input: {
    roleArn: string;
    externalId: string;
    region: string;
  }): Promise<DiscoveredResource[]>;
};

export type SyncTarget = {
  id: string;
  projectId: string;
  scrapeRoleArn: string;
  externalId: string;
  region: string;
};

/**
 * Sync one connection's inventory: list its resources, upsert each (keyed by
 * project + ARN), and soft-remove any this connection used to have but no longer
 * sees. Idempotent — re-running with the same set is a no-op beyond `lastSeenAt`.
 */
export async function syncConnectionResources(
  target: SyncTarget,
  lister: ResourceLister,
  now: Date = new Date(),
): Promise<{ discovered: number; removed: number }> {
  const discovered = await lister.list({
    roleArn: target.scrapeRoleArn,
    externalId: target.externalId,
    region: target.region,
  });

  for (const r of discovered) {
    const parsed = parseArn(r.arn);
    const name = r.tags.Name ?? parsed?.resourceId ?? null;
    await db
      .insert(schema.cloudResources)
      .values({
        projectId: target.projectId,
        connectionId: target.id,
        arn: r.arn,
        service: parsed?.service ?? "",
        resourceType: parsed?.resourceType || null,
        region: parsed?.region || target.region,
        accountId: parsed?.accountId || null,
        name,
        tags: r.tags,
        raw: r.raw ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        removedAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.cloudResources.projectId, schema.cloudResources.arn],
        set: {
          connectionId: target.id,
          service: parsed?.service ?? "",
          resourceType: parsed?.resourceType || null,
          region: parsed?.region || target.region,
          accountId: parsed?.accountId || null,
          name,
          tags: r.tags,
          raw: r.raw ?? null,
          lastSeenAt: now,
          removedAt: null,
          updatedAt: now,
        },
      });
  }

  // Soft-remove this connection's resources that weren't in the latest sweep.
  // (When nothing was discovered, the notInArray term is omitted, so every live
  // row for this connection is removed — the correct "all gone" result.)
  const seenArns = discovered.map((r) => r.arn);
  const removed = await db
    .update(schema.cloudResources)
    .set({ removedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.cloudResources.connectionId, target.id),
        isNull(schema.cloudResources.removedAt),
        seenArns.length > 0 ? notInArray(schema.cloudResources.arn, seenArns) : undefined,
      ),
    )
    .returning({ id: schema.cloudResources.id });

  return { discovered: discovered.length, removed: removed.length };
}

/**
 * Port: fetch one resource's configuration via the Cloud Control API. Returns
 * null when the resource isn't found or access is denied (best-effort). The real
 * adapter assumes the scrape role; tests pass a fake.
 */
export type ConfigFetcher = {
  get(input: {
    roleArn: string;
    externalId: string;
    region: string;
    ref: CloudControlRef;
  }): Promise<Record<string, unknown> | null>;
};

/**
 * Enrich a connection's live resources with Cloud Control config, best-effort.
 * Skips types we don't map; a fetch failure on one resource doesn't fail the
 * others. Returns how many resources got config.
 */
export async function enrichConnectionResources(
  target: SyncTarget,
  fetcher: ConfigFetcher,
  now: Date = new Date(),
): Promise<{ enriched: number; skipped: number }> {
  const rows = await db.query.cloudResources.findMany({
    where: and(
      eq(schema.cloudResources.connectionId, target.id),
      isNull(schema.cloudResources.removedAt),
    ),
  });

  let enriched = 0;
  let skipped = 0;

  const processOne = async (row: (typeof rows)[number]) => {
    const ref = arnToCloudControl(row.arn);
    if (!ref) {
      skipped++;
      return;
    }
    let config: Record<string, unknown> | null = null;
    try {
      config = await fetcher.get({
        roleArn: target.scrapeRoleArn,
        externalId: target.externalId,
        region: row.region || target.region,
        ref,
      });
    } catch {
      config = null; // best-effort; leave prior config untouched
    }
    if (config === null) {
      skipped++;
      return;
    }
    await db
      .update(schema.cloudResources)
      .set({ config, configFetchedAt: now, updatedAt: now })
      .where(eq(schema.cloudResources.id, row.id));
    enriched++;
  };

  // Bounded worker pool — Cloud Control throttles aggressively, so keep the fan-out
  // small (the SDK's adaptive retry handles the rest).
  const CONCURRENCY = 4;
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      if (row) await processOne(row);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()));

  return { enriched, skipped };
}
