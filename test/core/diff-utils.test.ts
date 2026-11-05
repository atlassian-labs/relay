import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff } from "../../src/core/diff-utils";

describe("parseUnifiedDiff", () => {
  test("parses modified file counts", () => {
    const files = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-old
+new
 context`);
    expect(files).toEqual([
      {
        path: "src/a.ts",
        oldPath: "src/a.ts",
        patch: expect.any(String),
        additions: 1,
        deletions: 1,
        status: "modified",
      },
    ]);
  });

  test("parses added and deleted files", () => {
    const files = parseUnifiedDiff(`diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-goodbye`);
    expect(
      files.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        status: file.status,
      })),
    ).toEqual([
      { path: "new.txt", additions: 1, deletions: 0, status: "added" },
      { path: "old.txt", additions: 0, deletions: 1, status: "deleted" },
    ]);
  });

  test("parses renamed files", () => {
    const files = parseUnifiedDiff(`diff --git a/a.txt b/b.txt
similarity index 90%
rename from a.txt
rename to b.txt
--- a/a.txt
+++ b/b.txt
@@ -1 +1 @@
-a
+b`);
    expect(files[0]?.path).toBe("b.txt");
    expect(files[0]?.oldPath).toBe("a.txt");
    expect(files[0]?.status).toBe("renamed");
  });

  test("preserves trailing blank context lines in patches", () => {
    const files = parseUnifiedDiff(
      "diff --git a/src/a.ts b/src/a.ts\n" +
        "index 111..222 100644\n" +
        "--- a/src/a.ts\n" +
        "+++ b/src/a.ts\n" +
        "@@ -1,2 +1,2 @@\n" +
        "-old\n" +
        "+new\n" +
        " \n",
    );

    expect(files[0]?.patch.split("\n").at(-2)).toBe(" ");
  });
});
