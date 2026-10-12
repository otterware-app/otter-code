import { describe, expect, it } from "@effect/vitest";
import { driveAccountChanged, driveNavigationUrl, driveShouldBeVisible } from "./viewDecisions.ts";

const home = "https://drive.otterware.app/home";
const document = "https://drive.otterware.app/team/document";
describe("Drive IPC decisions", () => {
  it("loads once, preserves the current document on show, and navigates on explicit requests", () => {
    expect(driveNavigationUrl("show", home, null)).toBe(home);
    expect(driveNavigationUrl("show", home, document)).toBeNull();
    expect(driveNavigationUrl("open", document, home)).toBe(document);
    expect(driveNavigationUrl("open", document, document)).toBeNull();
  });
  it("preserves an unknown startup account and an unchanged persisted identity", () => {
    expect(driveAccountChanged(undefined, "a")).toBe(false);
    expect(driveAccountChanged("a", "a")).toBe(false);
    expect(driveAccountChanged(null, "a")).toBe(true);
    expect(driveAccountChanged("a", "b")).toBe(true);
    expect(driveAccountChanged("a", null)).toBe(true);
  });
  it("withdraws the native view on hidden/overlay bounds or failure and restores it on return", () => {
    const bounds = { x: 10, y: 30, width: 800, height: 600 };
    expect(driveShouldBeVisible(bounds, null)).toBe(true);
    expect(driveShouldBeVisible(null, null)).toBe(false);
    expect(driveShouldBeVisible(bounds, "load failed")).toBe(false);
    expect(driveShouldBeVisible(bounds, null)).toBe(true);
  });
});
