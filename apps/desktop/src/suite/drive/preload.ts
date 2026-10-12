import type { DriveDesktopBridge, DriveDesktopState } from "@t3tools/contracts/suite";
import type { IpcRenderer } from "electron";
import { DRIVE_COMMAND, DRIVE_SIGN_OUT, DRIVE_STATE, DRIVE_RENEW_ACCOUNT } from "./channels.ts";

export const createDriveBridge = (ipc: IpcRenderer): DriveDesktopBridge => ({
  syncAccount: (token) => ipc.invoke(DRIVE_COMMAND, { action: "account", token }),
  onRenewAccount: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, recover: boolean, id: number) => {
      void Promise.resolve()
        .then(() => listener(recover))
        .then(
          () => ipc.invoke(DRIVE_COMMAND, { action: "renewal-result", id, ok: true }),
          () => ipc.invoke(DRIVE_COMMAND, { action: "renewal-result", id, ok: false }),
        )
        .catch(() => undefined);
    };
    ipc.on(DRIVE_RENEW_ACCOUNT, handler);
    return () => ipc.removeListener(DRIVE_RENEW_ACCOUNT, handler);
  },
  onSignOut: (listener) => {
    ipc.on(DRIVE_SIGN_OUT, listener);
    return () => {
      ipc.removeListener(DRIVE_SIGN_OUT, listener);
    };
  },
  show: (url, baseUrl) => ipc.invoke(DRIVE_COMMAND, { action: "show", url, baseUrl }),
  openDriveUrl: (url, baseUrl) => ipc.invoke(DRIVE_COMMAND, { action: "open", url, baseUrl }),
  setBounds: (bounds) => ipc.invoke(DRIVE_COMMAND, { action: "bounds", bounds }),
  command: (command) => ipc.invoke(DRIVE_COMMAND, { action: command }),
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DriveDesktopState) =>
      listener(state);
    ipc.on(DRIVE_STATE, handler);
    return () => {
      ipc.removeListener(DRIVE_STATE, handler);
    };
  },
});
