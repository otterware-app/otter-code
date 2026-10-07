// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Isolated OAuth callback listeners; no Google or database writes.
import * as NodeHttp from "node:http";
import { describe, expect, it, vi } from "vite-plus/test";

const { requestClient } = vi.hoisted(() => ({ requestClient: vi.fn() }));
vi.mock("./workerLink.ts", () => ({ requestClient }));

import { receiveRemoteGoogleCallback, runGoogleSignIn } from "./googleAuthRemote.ts";

function authorizationUrl(redirectUri: string, state = "m".repeat(22)) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: "1234-test.apps.googleusercontent.com",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email https://www.googleapis.com/auth/gmail.modify",
    state,
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

async function withListener(run: (origin: string, received: string[]) => Promise<void>) {
  const received: string[] = [];
  const server = NodeHttp.createServer((request, response) => {
    received.push(request.url!);
    response.writeHead(
      new URL(request.url!, "http://127.0.0.1").searchParams.has("error") ? 400 : 200,
    );
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    await run(`http://127.0.0.1:${address.port}`, received);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    requestClient.mockReset();
  }
}

describe("Mail's remote Google callback adapter", () => {
  it("delivers the client's validated callback to the server while leaving PKCE with Mail", async () => {
    await withListener(async (origin, received) => {
      const url = authorizationUrl(origin);
      requestClient.mockResolvedValue(`${origin}/?state=${"m".repeat(22)}&code=test-code`);
      await runGoogleSignIn(() => receiveRemoteGoogleCallback(url));
      expect(requestClient).toHaveBeenCalledWith(
        "googleAuth",
        { authorizationUrl: expect.any(String) },
        expect.any(AbortSignal),
      );
      const browserUrl = new URL(requestClient.mock.calls[0]![1].authorizationUrl);
      expect(browserUrl.searchParams.get("state")).toBe("m".repeat(22));
      expect(browserUrl.searchParams.get("code_challenge")).toBe("c".repeat(43));
      expect(browserUrl.searchParams.has("code_verifier")).toBe(false);
      expect(received).toEqual([`/?state=${"m".repeat(22)}&code=test-code`]);
      expect(requestClient.mock.calls[0]![2].aborted).toBe(true);
    });
  });

  it.each([
    ["a stale state", `/?state=${"x".repeat(22)}&code=test-code`],
    ["another path", `/other?state=${"m".repeat(22)}&code=test-code`],
    ["duplicate codes", `/?state=${"m".repeat(22)}&code=a&code=b`],
    ["another issuer", `/?state=${"m".repeat(22)}&code=a&iss=https://evil.test`],
  ])("does not forward %s to Mail's pending listener", async (_, callback) => {
    await withListener(async (origin, received) => {
      requestClient.mockResolvedValue(`${origin}${callback}`);
      await expect(
        runGoogleSignIn(() => receiveRemoteGoogleCallback(authorizationUrl(origin))),
      ).rejects.toThrow("does not belong");
      expect(received).toEqual([]);
    });
  });

  it("does not forward to a different origin", async () => {
    await withListener(async (origin, received) => {
      requestClient.mockResolvedValue(`http://example.test/?state=${"m".repeat(22)}&code=a`);
      await expect(
        runGoogleSignIn(() => receiveRemoteGoogleCallback(authorizationUrl(origin))),
      ).rejects.toThrow();
      expect(received).toEqual([]);
    });
  });

  it("delivers declined consent to Mail so its original sign-in rejects", async () => {
    await withListener(async (origin, received) => {
      requestClient.mockResolvedValue(`${origin}/?state=${"m".repeat(22)}&error=access_denied`);
      await runGoogleSignIn(() => receiveRemoteGoogleCallback(authorizationUrl(origin)));
      expect(received).toEqual([`/?state=${"m".repeat(22)}&error=access_denied`]);
    });
  });

  it("aborts the client ask when Mail finishes locally or cancels, and ignores its late reply", async () => {
    await withListener(async (origin, received) => {
      const reply = Promise.withResolvers<string>();
      requestClient.mockReturnValue(reply.promise);
      let handoff!: Promise<void>;
      await runGoogleSignIn(async () => {
        handoff = receiveRemoteGoogleCallback(authorizationUrl(origin));
      });
      expect(requestClient.mock.calls[0]![2].aborted).toBe(true);
      reply.resolve(`${origin}/?state=${"m".repeat(22)}&code=late-code`);
      await expect(handoff).rejects.toThrow("ended");
      expect(received).toEqual([]);
    });
  });
});
