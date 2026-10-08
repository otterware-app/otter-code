import { describe, expect, it } from "@effect/vitest";
import { driveViewBounds, isDriveSuiteSignOutUrl, isDriveViewUrl } from "./navigation.ts";

const BASE = "https://drive.otterware.app";

describe("Drive native view navigation", () => {
  it("recognizes only the canonical Drive browser sign-out action", () => {
    expect(isDriveSuiteSignOutUrl(`${BASE}/api/auth/browser-sign-out/start`)).toBe(true);
    for (const url of [
      `${BASE}/api/auth/browser-sign-out`,
      "https://accounts.otterware.app/api/auth/browser-sign-out/start",
      "https://drive.otterware.app.evil.test/api/auth/browser-sign-out/start",
      "http://drive.otterware.app/api/auth/browser-sign-out/start",
      "https://user@drive.otterware.app/api/auth/browser-sign-out/start",
      "invalid",
    ])
      expect(isDriveSuiteSignOutUrl(url)).toBe(false);
  });
  it("keeps Drive and Accounts in the isolated session", () => {
    for (const url of [
      BASE,
      `${BASE}/team/a/notes`,
      "https://accounts.otterware.app/login",
      "https://app.otterware.dev/home",
      "https://drive.otterware.dev/home",
      "https://usercontent.otterware.app/raw/a/id/v1/notes.md",
    ])
      expect(isDriveViewUrl(url, BASE)).toBe(true);
  });
  it("sends other hosts and unsafe schemes outside the view", () => {
    for (const url of [
      "https://example.com",
      "https://drive.otterware.app.evil.test",
      "https://drive.otterware.app:9999",
      "javascript:alert(1)",
      "file:///tmp/a",
      "http://accounts.otterware.app",
      "https://user:password@drive.otterware.app",
    ])
      expect(isDriveViewUrl(url, BASE)).toBe(false);
  });
  it("supports the configured development deployment", () => {
    expect(isDriveViewUrl("http://localhost:8787/home", "http://localhost:8787")).toBe(true);
    expect(isDriveViewUrl("http://localhost:9999/home", "http://localhost:8787")).toBe(false);
  });
  it("positions in native points at application zoom and rejects hidden geometry", () => {
    expect(driveViewBounds({ x: 100, y: 50, width: 800, height: 600 }, 1.25)).toEqual({
      x: 125,
      y: 63,
      width: 1000,
      height: 750,
    });
    expect(driveViewBounds({ x: 0, y: 0, width: 0, height: 100 }, 1)).toBeNull();
    expect(driveViewBounds({ x: NaN, y: 0, width: 800, height: 100 }, 1)).toBeNull();
  });
});
