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

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("fleet SSH handoff", () => {
  it.each([
    "forward",
    "backward",
    "force-kill",
    "unmanaged",
    "unrecorded",
    "reused-pid",
    "other-home",
  ])(
    "%s only stops verified SSH owners and catches a launch during the stopped-service gap",
    async (scenario) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "otterware-ssh-handoff-"));
      const home = NodePath.join(root, "data");
      const bin = NodePath.join(root, "bin");
      const code = "1.2.3-nightly.20261012.1";
      const ware = "1.2.3-otterware.20261012.1";
      const active = scenario === "backward" ? ware : code;
      const target = scenario === "backward" ? code : ware;
      const env = {
        ...process.env,
        HOME: root,
        T3CODE_HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        OTTERWARE_FLEET_SSH_STOP_TIMEOUT: scenario === "force-kill" ? "0" : "2",
      };
      const children: ReturnType<typeof spawn>[] = [];
      const record = async (pid: number, slot: string, managed = true) => {
        const dir = NodePath.join(home, "ssh-launch", slot);
        await NodeFSP.mkdir(dir, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(dir, "pid"), String(pid));
        await NodeFSP.writeFile(NodePath.join(dir, "port"), "45678");
        if (managed) await NodeFSP.writeFile(NodePath.join(dir, "managed"), "managed");
        return dir;
      };
      try {
        await NodeFSP.mkdir(bin, { recursive: true });
        await NodeFSP.mkdir(NodePath.join(home, "userdata"), { recursive: true });
        const unit = NodePath.join(root, ".config/systemd/user/otter-code.service");
        await NodeFSP.mkdir(NodePath.dirname(unit), { recursive: true });
        await NodeFSP.writeFile(unit, `Environment=T3CODE_HOME=${home}\n`);
        for (const version of [code, ware]) {
          const runtime = NodePath.join(home, "runtime/versions", version);
          await NodeFSP.mkdir(runtime, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(runtime, ".install-complete"), version);
          await NodeFSP.writeFile(
            NodePath.join(runtime, "t3"),
            `#!/bin/bash\nif [[ "$1" == __service-preflight ]]; then echo '{"status":"ready"}'; else echo 'installed-target'; fi\n`,
            { mode: 0o755 },
          );
        }
        await NodeFSP.writeFile(
          NodePath.join(home, "runtime/service-state.json"),
          `{\n  "activeVersion": "${active}"\n}\n`,
        );
        await NodeFSP.writeFile(
          NodePath.join(bin, "systemctl"),
          `#!/bin/bash\ncase "$2" in\nstop) echo service-stopped; read -r release ;;\nstart) sed -i 's/"pending"/"committed"/' "$T3CODE_HOME/runtime/service-state.json" ;;\nesac\n`,
          { mode: 0o755 },
        );
        await NodeFSP.writeFile(
          NodePath.join(bin, "curl"),
          `#!/bin/bash\necho '{"serverVersion":"${target}"}'\n`,
          { mode: 0o755 },
        );
        const fake = NodePath.join(bin, "t3");
        await NodeFSP.writeFile(
          fake,
          `#!/bin/bash\ntrap '${scenario === "force-kill" ? ":" : "exit 0"}' TERM\necho fake-ready\nwhile read -r input; do :; done\n`,
          { mode: 0o755 },
        );
        const fakeServer = (base: string) => {
          const child = spawn(fake, ["serve", "--base-dir", base], env);
          children.push(child);
          return child;
        };
        const initial =
          scenario === "reused-pid"
            ? spawn("bash", ["-c", "echo fake-ready; read -r release"], env)
            : fakeServer(scenario === "other-home" ? NodePath.join(root, "another-home") : home);
        if (scenario === "reused-pid") children.push(initial);
        await initial.until("fake-ready");
        const firstDir = await record(
          initial.child.pid!,
          "first",
          scenario !== "unmanaged" && scenario !== "unrecorded",
        );
        // A runtime record may name SSH or unmanaged servers; it must not bypass cleanup/refusal.
        await NodeFSP.writeFile(
          NodePath.join(home, "userdata/server-runtime.json"),
          JSON.stringify({
            pid: initial.child.pid,
            serviceManaged: false,
            origin: "http://fixture.test",
          }),
        );
        if (scenario === "other-home" || scenario === "reused-pid" || scenario === "unrecorded")
          await NodeFSP.writeFile(
            NodePath.join(home, "userdata/server-runtime.json"),
            JSON.stringify({ pid: 0, origin: "http://fixture.test" }),
          );
        const script = NodeURL.fileURLToPath(new URL("./fleet-server.sh", import.meta.url));
        const fleet = spawn(
          "bash",
          [
            script,
            scenario === "backward" ? "use-otter-code" : "use-otterware",
            "--version",
            target,
          ],
          env,
        );
        children.push(fleet);
        if (scenario === "unmanaged" || scenario === "unrecorded") {
          const result = await fleet.result;
          expect(result.code).not.toBe(0);
          expect(result.output).toContain(
            scenario === "unmanaged" ? "server started by hand" : "non-service server owns",
          );
          expect(result.output).not.toContain("service-stopped");
          expect(initial.child.exitCode).toBeNull();
          return;
        }
        await fleet.until("service-stopped");
        if (scenario !== "other-home" && scenario !== "reused-pid") {
          await initial.result;
          expect(await NodeFSP.stat(NodePath.join(firstDir, "pid")).catch(() => null)).toBeNull();
          expect(await NodeFSP.stat(NodePath.join(firstDir, "port")).catch(() => null)).toBeNull();
          expect(
            await NodeFSP.stat(NodePath.join(firstDir, "managed")).catch(() => null),
          ).toBeNull();
        } else {
          expect(initial.child.exitCode).toBeNull();
          expect(await NodeFSP.readFile(NodePath.join(firstDir, "pid"), "utf8")).toBe(
            String(initial.child.pid),
          );
        }
        const gap = fakeServer(home);
        await gap.until("fake-ready");
        const gapDir = await record(gap.child.pid!, "gap");
        await NodeFSP.writeFile(
          NodePath.join(home, "userdata/server-runtime.json"),
          JSON.stringify({
            pid: gap.child.pid,
            serviceManaged: false,
            origin: "http://fixture.test",
          }),
        );
        fleet.child.stdin.write("release\n");
        const result = await fleet.result;
        await gap.result;
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain(`stopping SSH-launched server pid ${gap.child.pid}`);
        if (scenario === "force-kill") expect(result.output).toContain("sending SIGKILL");
        else expect(result.output).not.toContain("sending SIGKILL");
        expect(await NodeFSP.stat(NodePath.join(gapDir, "pid")).catch(() => null)).toBeNull();
      } finally {
        // Only captured fixture processes; never touch a real service or data home.
        for (const item of children) item.child.kill("SIGKILL");
        await Promise.allSettled(children.map((item) => item.result));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});
