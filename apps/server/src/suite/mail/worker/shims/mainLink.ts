/**
 * Stands in for Otter Mail's `apps/desktop/src/main-link.ts` in the vendored
 * desktop services (gmail-oauth, todoist-oauth): what Mail asks its Electron
 * main process, Otterware answers here. Sealing uses the server's key; what
 * needs a person goes to the client. The bundler points `../main-link.js`
 * here (`buildMailWorker.ts`).
 */
import type { PickedFile } from "@otter-mail/core";

import { sealText, unsealText } from "../seal.ts";
import { mailWorkerData, requestClient } from "../workerLink.ts";

/** Mail's `MainRequests` (apps/desktop/src/backend-protocol.ts); the sync guard watches its shape. */
type MainRequests = {
  seal: { params: { text: string }; result: string };
  unseal: { params: { sealed: string }; result: string };
  openExternal: { params: { url: string }; result: void };
  openFile: { params: { name: string; bytes: Uint8Array }; result: void };
  saveFile: { params: { name: string; bytes: Uint8Array }; result: boolean };
  pickFiles: { params: undefined; result: PickedFile[] };
};

export async function requestMain<K extends keyof MainRequests>(
  kind: K,
  params: MainRequests[K]["params"],
): Promise<MainRequests[K]["result"]> {
  switch (kind) {
    case "seal":
      return sealText(
        mailWorkerData.sealKey,
        (params as MainRequests["seal"]["params"]).text,
      ) as never;
    case "unseal":
      return unsealText(
        mailWorkerData.sealKey,
        (params as MainRequests["unseal"]["params"]).sealed,
      ) as never;
    default:
      return requestClient(kind, params);
  }
}

/** Mail's desktop tells main about effects; the vendored services don't, but keep the export. */
export function tellMain(): void {}
