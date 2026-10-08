import type { DriveDesktopBridge, DriveDesktopState } from "@t3tools/contracts/suite";
import type { IpcRenderer } from "electron";
import { DRIVE_COMMAND, DRIVE_SIGN_OUT, DRIVE_STATE } from "./channels.ts";

export const createDriveBridge = (ipc: IpcRenderer): DriveDesktopBridge => ({
  syncAccount: (token) => ipc.invoke(DRIVE_COMMAND, { action: "account", token }),
  onSignOut: (listener) => {
    ipc.on(DRIVE_SIGN_OUT, listener);
    return () => {
      ipc.removeListener(DRIVE_SIGN_OUT, listener);
    };
  },
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
