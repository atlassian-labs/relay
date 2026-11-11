import { describe, expect, test } from "bun:test";
import { RELAY_RELEASE_VARIANTS } from "../../scripts/relay-release-package";

interface WorkflowStep {
  readonly uses?: string;
  readonly run?: string;
}

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly environment?: string;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly strategy?: { readonly matrix?: Readonly<Record<string, readonly string[]>> };
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const workflowText = await Bun.file(".github/workflows/release.yml").text();
const workflow = Bun.YAML.parse(workflowText) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

describe("release workflow", () => {
  test("runs only for version tags and manual dry runs", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({ tags: ["v*.*.*"] });
  });

  test("packages every supported release variant", () => {
    expect(workflow.jobs.package?.strategy?.matrix?.variant).toEqual([...RELAY_RELEASE_VARIANTS]);
  });

  test("refuses a tag that does not match the package.json version", () => {
    const versionScript = workflow.jobs.version?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
    expect(versionScript).toContain("require('./package.json').version");
    expect(versionScript).toContain('"$REF_NAME" != "v$version"');
  });

  test("validates archives on each platform it can smoke test before releasing", () => {
    expect(workflow.jobs.validate?.needs).toContain("package");
    expect(workflow.jobs.validate?.strategy?.matrix?.os).toEqual(["ubuntu-latest", "ubuntu-24.04-arm", "macos-latest"]);
    expect(workflow.jobs.release?.needs).toContain("validate");
  });

  // Only the final job can write, only for a tag push, and only in an
  // environment where admins can require approval.
  test("keeps write access in a gated release job that creates a draft", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name !== "release") expect(job.permissions?.contents).not.toBe("write");
    }
    const release = workflow.jobs.release;
    expect(release?.if).toBe("github.event_name == 'push'");
    expect(release?.environment).toBe("release");
    expect(release?.permissions).toEqual({ contents: "write" });
    expect(
      release?.steps?.some((step) => step.run?.includes("gh release create") && step.run.includes("--draft")),
    ).toBe(true);
  });

  test("pins actions to commit SHAs and keeps expressions out of shell scripts", () => {
    const actionRefs = steps.flatMap((step) => (step.uses ? [step.uses.split("@")[1]] : []));
    expect(actionRefs.length).toBeGreaterThan(0);
    for (const ref of actionRefs) expect(ref).toMatch(/^[0-9a-f]{40}$/);
    // Values reach scripts through `env`, so a crafted tag name cannot inject shell.
    for (const step of steps) expect(step.run ?? "").not.toContain("${{");
    expect(workflowText).not.toContain("secrets.");
  });
});
