import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { npmReleasePublishedAtom } from "./npmRelease";

const version = "0.1.3-nightly.20261024.463";
const releaseUrl = `https://registry.npmjs.org/otter-code/${version}`;

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

async function settledCheck() {
  const atom = npmReleasePublishedAtom(version);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    return registry.get(atom);
  } finally {
    unmount();
    registry.dispose();
  }
}

describe("npmReleasePublishedAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes an Otter release without tracing headers that trigger an npm preflight", async () => {
    fetchMock.mockImplementation(async (input, init) =>
      new Request(input, init).url === releaseUrl
        ? Response.json({ version })
        : new Response(null, { status: 404 }),
    );

    const result = await settledCheck();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(releaseUrl);
    expect(request.headers.get("traceparent")).toBeNull();
    expect(request.headers.get("b3")).toBeNull();
    expect(AsyncResult.getOrElse(result, () => false)).toBe(true);
  });

  it("does not offer an upstream release when the Otter version is unpublished", async () => {
    fetchMock.mockImplementation(async (input, init) =>
      new Request(input, init).url === releaseUrl
        ? new Response(null, { status: 404 })
        : Response.json({ version }),
    );

    const result = await settledCheck();

    expect(AsyncResult.getOrElse(result, () => true)).toBe(false);
  });

  // regression: #18709 update-everything skipped npm-installed servers
  it("leaves a failed first check unknown, which callers read as unpublished", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await settledCheck();

    expect(AsyncResult.isFailure(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => false)).toBe(false);
  });
});
