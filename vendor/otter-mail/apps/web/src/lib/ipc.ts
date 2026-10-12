export const ipc = <T = unknown>(channel: string, params?: unknown): Promise<T> =>
  window.desktopBridge.invoke<T>(channel, params);

/**
 * For calls that can outlast the 5s IPC timeout (file dialogs, big downloads):
 * the backend acknowledges at once and reports the outcome as a `task:done`
 * notification carrying our task id (see `runAsTask` in the gmail handlers).
 */
export const task = <T>(channel: string, params: Record<string, unknown>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const taskId = crypto.randomUUID();
    const off = window.desktopBridge.on("task:done", (payload: unknown) => {
      const p = payload as { taskId?: string; result?: T; error?: string } | undefined;
      if (p?.taskId !== taskId) return;
      off();
      if (p.error) reject(new Error(p.error));
      else resolve(p.result as T);
    });
    ipc(channel, { ...params, taskId }).catch((err: unknown) => {
      off();
      reject(err);
    });
  });
