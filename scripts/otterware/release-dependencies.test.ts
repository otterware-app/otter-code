import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

it.each([
  "otterware-release.yml",
  "release-desktop.yml",
  "release.yml",
  "desktop-macos-preview.yml",
  "otter-web-deploy.yml",
  "web-preview.yml",
])("%s installs the vendored Mail dependency roots for clean builds", (workflow) => {
  const file = NodeURL.fileURLToPath(
    new URL(`../../.github/workflows/${workflow}`, import.meta.url),
  );
  const contents = NodeFS.readFileSync(file, "utf8");
  const installs = [
    ...contents.matchAll(/run: vp install --filter=[^\n]+/g),
    ...contents.matchAll(/run-install: \|\n\s+args:\n(?:\s+- --filter=[^\n]+\n)+/g),
  ]
    .map((match) => match[0])
    .filter(
      (command) =>
        command.includes("--filter=@t3tools/web...") ||
        command.includes("--filter=@t3tools/desktop..."),
    );
  expect(installs.length).toBeGreaterThan(0);
  for (const command of installs) {
    expect(command).toContain("--filter=@otter-mail/web...");
    expect(command).toContain("--filter=@otter-mail/core...");
  }
});
