import { describe, expect, test } from "bun:test";

interface WorkflowStep {
  readonly uses?: string;
  readonly run?: string;
}

interface WorkflowInput {
  readonly type: string;
  readonly default?: unknown;
  readonly options?: readonly string[];
}

interface WorkflowJob {
  readonly environment?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly on: { readonly workflow_dispatch?: { readonly inputs: Readonly<Record<string, WorkflowInput>> } };
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const workflowText = await Bun.file(".github/workflows/publish-plugin-sdk.yml").text();
const workflow = Bun.YAML.parse(workflowText) as Workflow;
const publishScript = await Bun.file("scripts/ci-publish-plugin-sdk.ts").text();

describe("plugin SDK publish workflow", () => {
  test("runs only when started by hand, as a dry run by default", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const inputs = workflow.on.workflow_dispatch?.inputs;
    expect(inputs?.version?.type).toBe("string");
    expect(inputs?.dist_tag?.options).toEqual(["latest", "next", "beta"]);
    expect(inputs?.dry_run).toMatchObject({ type: "boolean", default: true });
  });

  // The publish token lives in the `npm` environment, so admins can require an
  // approval and no other workflow can read it.
  test("publishes from a gated environment with read-only repository access", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    const publish = workflow.jobs.publish;
    expect(publish?.environment).toBe("npm");
    expect(publish?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(workflowText).toContain("secrets.NPM_TOKEN");
  });

  test("pins actions to commit SHAs and keeps expressions out of shell scripts", () => {
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const actionRefs = steps.flatMap((step) => (step.uses ? [step.uses.split("@")[1]] : []));
    expect(actionRefs.length).toBeGreaterThan(0);
    for (const ref of actionRefs) expect(ref).toMatch(/^[0-9a-f]{40}$/);
    // Inputs reach scripts through `env`, so a crafted version cannot inject shell.
    for (const step of steps) expect(step.run ?? "").not.toContain("${{");
  });

  test("publishes the SDK as a public npm package", () => {
    expect(publishScript).toContain('"--access", "public"');
    expect(publishScript).not.toContain('"restricted"');
    expect(publishScript).toContain("PUBLISH_PROVENANCE");
  });
});
