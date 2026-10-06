import { assert, describe, it } from "@effect/vitest";

import { resolveCatalogDependencies } from "./resolve-catalog.ts";

const catalog = {
  effect: "4.0.0-rc.115",
  jose: "6.2.12",
  react: "19.2.0",
  undici: "8.11.2",
};

describe("resolveCatalogDependencies", () => {
  it("resolves bare, named and override-selector catalog specs like pnpm", () => {
    assert.deepStrictEqual(
      resolveCatalogDependencies(
        {
          jose: "catalog:",
          "react-dom": "catalog:react",
          "@opencode/protocol>effect": "catalog:",
          "undici@^8": "catalog:",
          "jose@^6": "catalog:",
          "dbus-next>usocket": "-",
          lodash: "4.17.21",
        },
        catalog,
        "apps/desktop",
      ),
      {
        jose: "6.2.12",
        "react-dom": "19.2.0",
        "@opencode/protocol>effect": "4.0.0-rc.115",
        "undici@^8": "8.11.2",
        "jose@^6": "6.2.12",
        "dbus-next>usocket": "-",
        lodash: "4.17.21",
      },
    );
  });

  it("fails on a catalog entry that does not exist", () => {
    assert.throws(
      () => resolveCatalogDependencies({ "a>missing": "catalog:" }, catalog, "apps/desktop"),
      /Expected key 'missing' in root workspace catalog/,
    );
  });
});
