// @effect-diagnostics nodeBuiltinImport:off -- Exercises flock with disposable homes and stub runtimes only.
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
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

describe.skipIf(HostProcessPlatform.defaultValue() !== "linux")("fleet mutations", () => {
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
        `t3-${version}-linux-${HostProcessArchitecture.defaultValue()}.tar.gz`,
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
