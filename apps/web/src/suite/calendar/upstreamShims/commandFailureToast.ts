/**
 * `../../lib/commandFailureToast` for the vendored calendar (a manifest import remap); Otter
 * Calendar's scaffold helper, which Otter Code does not have.
 */
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../../../components/ui/toast";

/** Shows a failed command's reason; success and interruption stay quiet. Returns whether it failed. */
export function toastCommandFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error && error.message ? error.message : "Something went wrong.",
  });
  return true;
}
