import { describe, expect, it, vi } from "vite-plus/test";

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock("node:worker_threads", () => ({ parentPort: { postMessage }, workerData: {} }));

import { currentClient, requestClient, settleClientRequest } from "./workerLink.ts";

describe("Mail client requests", () => {
  it("carries the invoking client and releases a cancelled OAuth ask before a late reply", async () => {
    const controller = new AbortController();
    const request = currentClient.run("remote-frame", () =>
      requestClient("googleAuth", { authorizationUrl: "test" }, controller.signal),
    );
    const sent = postMessage.mock.calls.at(-1)![0];
    expect(sent).toMatchObject({ type: "request", kind: "googleAuth", clientId: "remote-frame" });
    const failure = expect(request).rejects.toThrow("ended");
    controller.abort();
    expect(postMessage.mock.calls.at(-1)![0]).toEqual({ type: "requestCancelled", id: sent.id });
    settleClientRequest(sent.id, "late callback", undefined);
    await failure;
  });

  it("removes cancellation listeners when the client has already replied", async () => {
    const controller = new AbortController();
    const request = requestClient<string>("googleAuth", {}, controller.signal);
    const sent = postMessage.mock.calls.at(-1)![0];
    settleClientRequest(sent.id, "callback", undefined);
    expect(await request).toBe("callback");
    const calls = postMessage.mock.calls.length;
    controller.abort();
    expect(postMessage.mock.calls.length).toBe(calls);
  });
});
