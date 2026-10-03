// @effect-diagnostics nodeBuiltinImport:off
// Runs before any Effect runtime is built, so it stays on Node built-ins.
import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";

/**
 * How to run a JavaScript file shipped with T3 (tsserver, Pyright) on T3's own runtime.
 * The single-executable build always starts its embedded entry and ignores a script
 * argument, so it goes through `t3 __run-node-script`, which loads the script itself.
 */
export function nodeScriptCommand(script: string, args: ReadonlyArray<string>) {
  return {
    command: process.execPath,
    args: NodeSea.isSea() ? ["__run-node-script", script, ...args] : [script, ...args],
  };
}

/** Entry for `t3 __run-node-script <script> [args]`: runs the script as if Node started it. */
export function runNodeScript([script, ...args]: ReadonlyArray<string>) {
  if (!script) throw new Error("Usage: t3 __run-node-script <script> [args...]");
  process.argv = [process.execPath, script, ...args];
  NodeModule.createRequire(script)(script);
}
