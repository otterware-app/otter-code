/**
 * Stands in for Otter Mail's `apps/desktop/src/backend-protocol.ts` in the
 * vendored desktop services: `appInfo()` is where Mail keeps its files
 * (`<stateDir>/mail`). The bundler points `../backend-protocol.js` here.
 */
import { mailWorkerData } from "../workerLink.ts";

declare const __OTTER_MAIL_VERSION__: string;

export function appInfo() {
  return {
    stateDir: mailWorkerData.home,
    version: __OTTER_MAIL_VERSION__,
    packaged: true,
    resourcesPath: "",
  };
}
