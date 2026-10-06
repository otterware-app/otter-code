import { describe, expect, it } from "vite-plus/test";

import { remapImports, selectFiles, transformFile, updateManifestText } from "./vendorSync.ts";

describe("vendorSync", () => {
  it("selects directories and files, renames, and honours excludes", () => {
    const files = selectFiles(
      {
        paths: [
          "apps/server/src/calendar/",
          { upstream: "apps/server/src/persistence/Migrations/003_Calendar.ts", local: "x/003.ts" },
        ],
        exclude: ["apps/server/src/calendar/skip.test.ts"],
      },
      [
        "apps/server/src/calendar/A.ts",
        "apps/server/src/calendar/skip.test.ts",
        "apps/server/src/calendar/google/B.ts",
        "apps/server/src/persistence/Migrations/003_Calendar.ts",
        "apps/server/src/other.ts",
      ],
    );
    expect(files).toEqual([
      { upstreamPath: "apps/server/src/calendar/A.ts", localPath: "apps/server/src/calendar/A.ts" },
      {
        upstreamPath: "apps/server/src/calendar/google/B.ts",
        localPath: "apps/server/src/calendar/google/B.ts",
      },
      {
        upstreamPath: "apps/server/src/persistence/Migrations/003_Calendar.ts",
        localPath: "x/003.ts",
      },
    ]);
    expect(() => selectFiles({ paths: ["missing.ts"] }, [])).toThrow(/missing\.ts/);
  });

  it("points relative imports of the target at the replacement, keeping the extension style", () => {
    const remaps = [
      {
        importer: "apps/web/src/components/calendar/",
        target: "apps/web/src/state/server",
        replacement: "apps/web/src/suite/calendar/shims/serverState",
      },
      {
        importer: "apps/server/src/calendar/",
        target: "apps/server/src/persistence/Layers/Sqlite",
        replacement: "apps/server/src/suite/calendar/testing/db",
      },
    ];
    const web = remapImports(
      "apps/web/src/components/calendar/engine/TimeGrid.tsx",
      `import { a } from "../../../state/server";\nimport { b } from "../../../state/serverless";\nconst c = import("../../../state/server");`,
      remaps,
    );
    expect(web).toBe(
      `import { a } from "../../../suite/calendar/shims/serverState";\nimport { b } from "../../../state/serverless";\nconst c = import("../../../suite/calendar/shims/serverState");`,
    );
    const server = remapImports(
      "apps/server/src/calendar/X.test.ts",
      `import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";`,
      remaps,
    );
    expect(server).toBe(
      `import { SqlitePersistenceMemory } from "../suite/calendar/testing/db.ts";`,
    );
    // Files outside the importer prefix keep their imports.
    expect(remapImports("apps/web/src/other.ts", `from "./state/server"`, remaps)).toBe(
      `from "./state/server"`,
    );
  });

  it("applies rewrites to text files only, scoped when asked", () => {
    const manifest = {
      rewrites: [
        { from: '"effect/unstable/', to: '"effect/' },
        { from: "WS_METHODS", to: "SUITE_METHODS", files: ["a/state.ts"] },
      ],
    };
    const source = Buffer.from(
      `import * as S from "effect/unstable/sql/SqlClient";\nWS_METHODS.x;`,
    );
    expect(transformFile(manifest, "a/state.ts", source).toString()).toBe(
      `import * as S from "effect/sql/SqlClient";\nSUITE_METHODS.x;`,
    );
    expect(transformFile(manifest, "a/other.ts", source).toString()).toBe(
      `import * as S from "effect/sql/SqlClient";\nWS_METHODS.x;`,
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(transformFile(manifest, "a/image.png", png)).toBe(png);
  });

  it("rewrites only the pinned commit and the file list of a manifest", () => {
    const previous = `{
  "upstream": { "name": "x", "repo": "r", "ref": "main", "commit": "old" },
  "paths": ["a/"],
  "rewrites": [{ "files": ["a/b.ts"], "from": "A", "to": "B" }],
  "files": ["a/gone.ts"]
}
`;
    const next = updateManifestText(previous, {
      upstream: { name: "x", repo: "r", ref: "main", commit: "new" },
      paths: ["a/"],
      files: ["a/b.ts", "a/c.ts"],
    });
    expect(next).toBe(`{
  "upstream": { "name": "x", "repo": "r", "ref": "main", "commit": "new" },
  "paths": ["a/"],
  "rewrites": [{ "files": ["a/b.ts"], "from": "A", "to": "B" }],
  "files": [
    "a/b.ts",
    "a/c.ts"
  ]
}
`);
  });
});
