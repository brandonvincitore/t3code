import { describe, expect, it } from "vite-plus/test";

import {
  buildKiroSpecContinuePrompt,
  discoverKiroSpecDocuments,
  discoverKiroSpecFolders,
  kiroSpecKind,
  parseKiroTaskProgress,
} from "./kiroSpecs.ts";

describe("Kiro spec discovery", () => {
  it("finds only direct spec folders and known artifacts", () => {
    expect(
      discoverKiroSpecFolders([
        { path: ".kiro/specs/feature-a", kind: "directory" },
        { path: ".kiro/specs/bug-fix", kind: "directory" },
        { path: ".kiro/specs/feature-a/nested", kind: "directory" },
        { path: ".kiro/specs/notes.md", kind: "file" },
      ]),
    ).toEqual(["bug-fix", "feature-a"]);
    const documents = discoverKiroSpecDocuments(
      [
        { path: ".kiro/specs/feature-a/requirements.md", kind: "file" },
        { path: ".kiro/specs/feature-a/design.md", kind: "file" },
        { path: ".kiro/specs/feature-a/tasks.md", kind: "file" },
        { path: ".kiro/specs/feature-a/other.md", kind: "file" },
      ],
      "feature-a",
    );
    expect(documents.map(({ id }) => id)).toEqual(["requirements", "design", "tasks"]);
    expect(kiroSpecKind(documents)).toBe("feature");
  });

  it("recognizes bugfix artifacts and reads nested task checkboxes", () => {
    const documents = discoverKiroSpecDocuments(
      [
        { path: ".kiro/specs/regression/bugfix.md", kind: "file" },
        { path: ".kiro/specs/regression/design.md", kind: "file" },
        { path: ".kiro/specs/regression/tasks.md", kind: "file" },
      ],
      "regression",
    );
    expect(kiroSpecKind(documents)).toBe("bugfix");
    expect(
      parseKiroTaskProgress(
        "# Tasks\n- [x] Fix the bug\n  - [X] Add a regression test\n- [ ] Verify behavior",
      ),
    ).toEqual({ checked: 2, total: 3 });
    expect(parseKiroTaskProgress("No checklist")).toEqual({ checked: 0, total: 0 });
    expect(buildKiroSpecContinuePrompt("regression", "bugfix", documents[0]!)).toContain(
      ".kiro/specs/regression/",
    );
  });
});
