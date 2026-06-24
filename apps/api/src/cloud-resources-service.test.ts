import "dotenv/config";
import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { closeDb, db, runMigrations, schema } from "@superlog/db";
import { and, eq } from "drizzle-orm";
import {
  type ConfigFetcher,
  type ResourceLister,
  arnToCloudControl,
  enrichConnectionResources,
  parseArn,
  syncConnectionResources,
} from "./cloud-resources-service.js";

test("parseArn handles type/id, type:id, and bare ids", () => {
  assert.deepEqual(parseArn("arn:aws:ec2:us-west-2:123456789012:instance/i-abc"), {
    partition: "aws",
    service: "ec2",
    region: "us-west-2",
    accountId: "123456789012",
    resourceType: "instance",
    resourceId: "i-abc",
  });
  const rds = parseArn("arn:aws:rds:us-west-2:123456789012:db:mydb");
  assert.equal(rds?.resourceType, "db");
  assert.equal(rds?.resourceId, "mydb");
  const bucket = parseArn("arn:aws:s3:::my-bucket");
  assert.equal(bucket?.service, "s3");
  assert.equal(bucket?.region, "");
  assert.equal(bucket?.resourceType, "");
  assert.equal(bucket?.resourceId, "my-bucket");
  // Mixed-format ARN (autoscaling): `:` separates the type but `/` appears later
  // inside the id — the type must still parse as the part before the first `:`.
  const asg = parseArn(
    "arn:aws:autoscaling:us-west-2:1:autoScalingGroup:uuid-123:autoScalingGroupName/my-asg",
  );
  assert.equal(asg?.service, "autoscaling");
  assert.equal(asg?.resourceType, "autoScalingGroup");
  assert.equal(asg?.resourceId, "uuid-123:autoScalingGroupName/my-asg");
  assert.equal(parseArn("not-an-arn"), null);
});

test("arnToCloudControl maps types + handles ELB-arn and ECS-composite ids", () => {
  assert.deepEqual(arnToCloudControl("arn:aws:ec2:us-west-2:1:instance/i-1"), {
    typeName: "AWS::EC2::Instance",
    identifier: "i-1",
  });
  assert.deepEqual(arnToCloudControl("arn:aws:rds:us-west-2:1:db:prod"), {
    typeName: "AWS::RDS::DBInstance",
    identifier: "prod",
  });
  // ELB keys on the full ARN
  const elbArn = "arn:aws:elasticloadbalancing:us-west-2:1:loadbalancer/app/x/abc";
  assert.deepEqual(arnToCloudControl(elbArn), {
    typeName: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    identifier: elbArn,
  });
  // ECS uses composite serviceArn|cluster
  const ecsArn = "arn:aws:ecs:us-west-2:1:service/my-cluster/my-svc";
  assert.deepEqual(arnToCloudControl(ecsArn), {
    typeName: "AWS::ECS::Service",
    identifier: `${ecsArn}|my-cluster`,
  });
  // ASG: identifier is the group name (after the last "/"), not the whole id
  assert.deepEqual(
    arnToCloudControl(
      "arn:aws:autoscaling:us-west-2:1:autoScalingGroup:uuid-123:autoScalingGroupName/my-asg",
    ),
    { typeName: "AWS::AutoScaling::AutoScalingGroup", identifier: "my-asg" },
  );
  // unsupported type → null
  assert.equal(arnToCloudControl("arn:aws:s3:::my-bucket"), null);
});

// --- DB-backed sync -----------------------------------------------------------

const orgIds: string[] = [];

before(async () => {
  await runMigrations();
});
after(async () => {
  try {
    for (const orgId of orgIds.reverse()) {
      await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
    }
  } finally {
    await closeDb();
  }
});

async function seedConnection() {
  const tag = `cr-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [org] = await db.insert(schema.orgs).values({ name: tag, slug: tag }).returning();
  if (!org) throw new Error("seed org");
  orgIds.push(org.id);
  const [user] = await db
    .insert(schema.users)
    .values({ email: `${tag}@example.com` })
    .returning();
  if (!user) throw new Error("seed user");
  const [project] = await db
    .insert(schema.projects)
    .values({ orgId: org.id, name: "t", slug: tag })
    .returning();
  if (!project) throw new Error("seed project");
  const [conn] = await db
    .insert(schema.cloudConnections)
    .values({
      projectId: project.id,
      region: "us-west-2",
      scrapeRoleArn: "arn:aws:iam::123456789012:role/SuperlogScrapeRole",
      // sync takes the external id as a plaintext arg, so dummy ciphertext is fine.
      externalIdCiphertext: Buffer.from("x"),
      externalIdNonce: Buffer.from("y"),
      status: "connected",
      accountId: "123456789012",
      createdBy: user.id,
    })
    .returning();
  if (!conn) throw new Error("seed connection");
  return {
    id: conn.id,
    projectId: project.id,
    scrapeRoleArn: conn.scrapeRoleArn ?? "",
    externalId: "ext",
    region: "us-west-2",
  };
}

const listerOf = (...arns: string[]): ResourceLister => ({
  async list() {
    return arns.map((arn) => ({ arn, tags: { Name: `name-${arn.split("/").pop()}` } }));
  },
});

test("sync upserts discovered resources with parsed fields", async () => {
  const target = await seedConnection();
  const res = await syncConnectionResources(
    target,
    listerOf(
      "arn:aws:ec2:us-west-2:123456789012:instance/i-1",
      "arn:aws:rds:us-west-2:123456789012:db:mydb",
    ),
  );
  assert.deepEqual(res, { discovered: 2, removed: 0 });

  const rows = await db.query.cloudResources.findMany({
    where: eq(schema.cloudResources.connectionId, target.id),
  });
  assert.equal(rows.length, 2);
  const ec2 = rows.find((r) => r.service === "ec2");
  assert.equal(ec2?.resourceType, "instance");
  assert.equal(ec2?.region, "us-west-2");
  assert.equal(ec2?.accountId, "123456789012");
  assert.equal(ec2?.removedAt, null);
});

test("sync soft-removes resources that disappear, and revives them if they return", async () => {
  const target = await seedConnection();
  const a = "arn:aws:ec2:us-west-2:123456789012:instance/i-a";
  const b = "arn:aws:ec2:us-west-2:123456789012:instance/i-b";

  await syncConnectionResources(target, listerOf(a, b));
  // second sweep only sees `a` → `b` should be soft-removed
  const r2 = await syncConnectionResources(target, listerOf(a));
  assert.equal(r2.removed, 1);
  const bRow = await db.query.cloudResources.findFirst({
    where: and(eq(schema.cloudResources.connectionId, target.id), eq(schema.cloudResources.arn, b)),
  });
  assert.notEqual(bRow?.removedAt, null);

  // `b` comes back → removedAt cleared
  await syncConnectionResources(target, listerOf(a, b));
  const bRevived = await db.query.cloudResources.findFirst({
    where: and(eq(schema.cloudResources.connectionId, target.id), eq(schema.cloudResources.arn, b)),
  });
  assert.equal(bRevived?.removedAt, null);
});

test("enrich stores Cloud Control config for mapped types, skips the rest", async () => {
  const target = await seedConnection();
  await syncConnectionResources(
    target,
    listerOf(
      "arn:aws:ec2:us-west-2:123456789012:instance/i-1", // mapped
      "arn:aws:s3:::my-bucket", // unsupported → skipped
    ),
  );

  const fetcher: ConfigFetcher = {
    async get({ ref }) {
      assert.equal(ref.typeName, "AWS::EC2::Instance");
      return { InstanceType: "t3.micro", SubnetId: "subnet-abc" };
    },
  };
  const res = await enrichConnectionResources(target, fetcher);
  assert.equal(res.enriched, 1);
  assert.equal(res.skipped, 1);

  const ec2 = await db.query.cloudResources.findFirst({
    where: and(
      eq(schema.cloudResources.connectionId, target.id),
      eq(schema.cloudResources.service, "ec2"),
    ),
  });
  assert.equal((ec2?.config as { InstanceType?: string })?.InstanceType, "t3.micro");
  assert.notEqual(ec2?.configFetchedAt, null);
});

test("enrich tolerates a fetch failure without throwing", async () => {
  const target = await seedConnection();
  await syncConnectionResources(target, listerOf("arn:aws:rds:us-west-2:1:db:prod"));
  const fetcher: ConfigFetcher = {
    async get() {
      throw new Error("AccessDenied");
    },
  };
  const res = await enrichConnectionResources(target, fetcher);
  assert.equal(res.enriched, 0);
  assert.equal(res.skipped, 1);
});
