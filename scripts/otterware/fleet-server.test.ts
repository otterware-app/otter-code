// @effect-diagnostics nodeBuiltinImport:off -- Exercises flock with disposable homes and stub runtimes only.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

function spawn(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = NodeChildProcess.spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  const listeners = new Set<() => void>();
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
    for (const listener of listeners) listener();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const result = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
  const until = async (marker: string) => {
    let listener: () => void = () => {};
    const observed = new Promise<void>((resolve) => {
      listener = () => {
        if (output.includes(marker)) resolve();
      };
      listeners.add(listener);
      listener();
    });
    try {
      await Promise.race([
        observed,
        result.then(() => {
          if (!output.includes(marker))
            throw new Error(`Process exited before ${marker}: ${output}`);
        }),
      ]);
    } finally {
      listeners.delete(listener);
    }
  };
  return { child, result, until };
}

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("fleet mutations", () => {
  it.each(["install", "use-otterware", "use-otter-code"])(
    "%s waits for the home lock before reading or changing runtime state",
    async (operation) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "otterware-fleet-lock-"));
      const home = NodePath.join(root, "data");
      const bin = NodePath.join(root, "bin");
      const lock = NodePath.join(home, "runtime/fleet-server.lock");
      const version =
        operation === "use-otterware" ? "1.2.3-otterware.20261006.1" : "1.2.3-nightly.20261006.1";
      const runtime = NodePath.join(home, "runtime/versions", version);
      const unit = NodePath.join(root, ".config/systemd/user/otter-code.service");
      const archive = NodePath.join(
        root,
        `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}.tar.gz`,
      );
      const env = {
        ...process.env,
        HOME: root,
        T3CODE_HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
      };
      await NodeFSP.mkdir(runtime, { recursive: true });
      await NodeFSP.mkdir(NodePath.dirname(unit), { recursive: true });
      await NodeFSP.mkdir(bin);
      await NodeFSP.writeFile(NodePath.join(runtime, "t3"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await NodeFSP.writeFile(NodePath.join(runtime, ".install-complete"), version);
      await NodeFSP.writeFile(unit, `Environment=T3CODE_HOME=${home}\n`);
      const realFlock = NodeChildProcess.execFileSync("which", ["flock"], {
        encoding: "utf8",
      }).trim();
      await NodeFSP.writeFile(
        NodePath.join(bin, "flock"),
        `#!/bin/sh\nprintf 'lock-requested\\n' >&2\nexec '${realFlock.replaceAll("'", "'\\''")}' "$@"\n`,
        { mode: 0o755 },
      );
      const holder = spawn(
        realFlock,
        ["--exclusive", lock, "sh", "-c", "printf 'held\\n'; read release"],
        env,
      );
      let fleet: ReturnType<typeof spawn> | undefined;
      try {
        await holder.until("held");
        const script = NodeURL.fileURLToPath(new URL("./fleet-server.sh", import.meta.url));
        fleet = spawn(
          "bash",
          [script, operation, ...(operation === "install" ? [archive] : ["--version", version])],
          env,
        );
        await fleet.until("lock-requested");
        // The inputs appear while the competing writer still holds the lock.
        // Checking before taking the lock would reject these as missing.
        await NodeFSP.writeFile(archive, "already-installed archive fixture");
        await NodeFSP.writeFile(
          NodePath.join(home, "runtime/service-state.json"),
          `{\n  "activeVersion": "${version}"\n}\n`,
        );
        holder.child.stdin.end("release\n");
        expect((await holder.result).code).toBe(0);
        const outcome = await fleet.result;
        expect(outcome.code, outcome.output).toBe(0);
        expect(outcome.output).toContain(
          operation === "install" ? "already installed" : "already active",
        );
        NodeChildProcess.execFileSync(realFlock, ["--exclusive", "--nonblock", lock, "true"]);
      } finally {
        holder.child.stdin.end("release\n");
        // These are only the fixture PIDs captured at spawn.
        holder.child.kill();
        fleet?.child.kill();
        await Promise.allSettled([holder.result, ...(fleet ? [fleet.result] : [])]);
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

// Curl is a fixture transport: no server or live service is started.
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("fleet channel updates", () => {
  it.each(["valid", "corrupt", "missing-sums", "code-version", "duplicate"])(
    "%s channel download verifies before installing and selects the feed version explicitly",
    async (scenario) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "otterware-feed-"));
      const home = NodePath.join(root, "data");
      const bin = NodePath.join(root, "bin");
      const version = "1.2.3-otterware.20261012.4";
      const arch = HostProcess.Architecture.defaultValue();
      const name = `t3-${version}-linux-${arch}.tar.gz`;
      const fixture = NodePath.join(root, "fixture");
      const target = NodePath.join(home, "runtime/versions", version);
      const env = {
        ...process.env,
        HOME: root,
        T3CODE_HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
      };
      try {
        await NodeFSP.mkdir(bin);
        await NodeFSP.mkdir(fixture);
        const runtime = NodePath.join(root, "runtime");
        await NodeFSP.mkdir(runtime);
        await NodeFSP.writeFile(
          NodePath.join(runtime, "t3"),
          `#!/bin/sh\necho 'Otter Code v${version}'\n`,
          { mode: 0o755 },
        );
        NodeChildProcess.execFileSync("tar", [
          "-czf",
          NodePath.join(fixture, name),
          "-C",
          root,
          "runtime",
        ]);
        const sum = NodeChildProcess.execFileSync("sha256sum", [NodePath.join(fixture, name)], {
          encoding: "utf8",
        }).split(" ")[0];
        let sums = `${scenario === "corrupt" ? "0".repeat(64) : sum}  ${name}\n`;
        if (scenario === "code-version")
          sums = `${sum}  t3-1.2.3-nightly.20261012.4-linux-${arch}.tar.gz\n`;
        if (scenario === "duplicate") sums += sums;
        if (scenario !== "missing-sums")
          await NodeFSP.writeFile(NodePath.join(fixture, "SHA256SUMS"), sums);
        await NodeFSP.writeFile(
          NodePath.join(bin, "curl"),
          `#!/bin/bash\nset -eu\nwhile (($#)); do\n case "$1" in\n -o) out="$2"; shift 2 ;;\n http*) url="$1"; shift ;;\n --retry) shift 2 ;;\n *) shift ;;\n esac\ndone\necho "$url" >> '${root}/requests'\ncp '${fixture}/'"\${url##*/}" "$out"\n`,
          { mode: 0o755 },
        );
        // A fixture unit/state avoids any service command: the selected build
        // is already the active version, but is deliberately not installed yet.
        const unit = NodePath.join(root, ".config/systemd/user/otter-code.service");
        await NodeFSP.mkdir(NodePath.dirname(unit), { recursive: true });
        await NodeFSP.writeFile(unit, `Environment=T3CODE_HOME=${home}\n`);
        await NodeFSP.mkdir(NodePath.join(home, "runtime"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(home, "runtime/service-state.json"),
          `{\n  "activeVersion": "${version}"\n}\n`,
        );
        // A newer installed build must not override the version from this feed.
        const newer = NodePath.join(home, "runtime/versions/9.9.9-otterware.20261012.99");
        await NodeFSP.mkdir(newer, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(newer, "t3"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        await NodeFSP.writeFile(
          NodePath.join(newer, ".install-complete"),
          "9.9.9-otterware.20261012.99",
        );
        await NodeFSP.writeFile(
          NodePath.join(bin, "systemctl"),
          "#!/bin/sh\necho 'unexpected service mutation' >&2\nexit 99\n",
          { mode: 0o755 },
        );
        const script = NodeURL.fileURLToPath(new URL("./fleet-server.sh", import.meta.url));
        const result = await spawn("bash", [script, "update", "--channel", "feature-mail"], env)
          .result;
        if (scenario === "valid") {
          expect(result.code, result.output).toBe(0);
          expect(result.output).toContain("checksum verified");
          expect(result.output).toContain(`${version} (otterware) is already active`);
          expect(await NodeFSP.readFile(NodePath.join(target, ".install-complete"), "utf8")).toBe(
            `${version}\n`,
          );
          expect(await NodeFSP.readFile(NodePath.join(root, "requests"), "utf8")).toContain(
            `/channel-feature-mail/SHA256SUMS\n`,
          );
        } else {
          expect(result.code, result.output).not.toBe(0);
          expect(await NodeFSP.stat(target).catch(() => null)).toBeNull();
        }
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
