import { describe, expect, it } from "@effect/vitest";

import { driveDocumentKind, driveDocumentUrl, parseDriveUrl } from "./drive.ts";

const ID = "3f2b8c1e-9a4d-4c2e-8f1a-0b6d5e7c9a12";

describe("parseDriveUrl", () => {
  it("reads a document URL, with and without the trailing slash Drive's API adds", () => {
    for (const url of [
      "https://drive.otterware.app/team-docs/a/q3-plan",
      "https://drive.otterware.app/team-docs/a/q3-plan/",
    ]) {
      expect(parseDriveUrl(url)).toEqual({
        type: "document",
        folderSlug: "team-docs",
        reference: "q3-plan",
        version: null,
        sheet: null,
        url: "https://drive.otterware.app/team-docs/a/q3-plan",
      });
    }
  });

  it("reads a pinned version from /v<N> and from the legacy ?version= query", () => {
    expect(parseDriveUrl("https://drive.otterware.app/team-docs/a/q3-plan/v3")).toMatchObject({
      version: 3,
      url: "https://drive.otterware.app/team-docs/a/q3-plan/v3",
    });
    expect(
      parseDriveUrl("https://drive.otterware.app/team-docs/a/q3-plan/?version=2"),
    ).toMatchObject({
      version: 2,
      url: "https://drive.otterware.app/team-docs/a/q3-plan/v2",
    });
    expect(parseDriveUrl("https://drive.otterware.app/team-docs/a/q3-plan/v0")).toBeNull();
    expect(parseDriveUrl("https://drive.otterware.app/team-docs/a/q3-plan/edit")).toBeNull();
  });

  it("keeps the workbook sheet", () => {
    expect(
      parseDriveUrl("https://drive.otterware.app/finance/a/budget?sheet=Summary%202026"),
    ).toMatchObject({
      reference: "budget",
      sheet: "Summary 2026",
      url: "https://drive.otterware.app/finance/a/budget?sheet=Summary%202026",
    });
    expect(
      parseDriveUrl("https://app.otterware.dev/finance/a/budget/v2?sheet=Summary%202026"),
    ).toMatchObject({
      version: 2,
      url: "https://drive.otterware.app/finance/a/budget/v2?sheet=Summary%202026",
    });
  });

  it("reads a standalone shared document by its id in the slug position", () => {
    expect(parseDriveUrl(`https://drive.otterware.app/alice-drive/a/${ID}`)).toMatchObject({
      type: "document",
      folderSlug: "alice-drive",
      reference: ID,
    });
  });

  it("moves legacy hosts onto drive.otterware.app", () => {
    for (const host of ["app.otterware.dev", "drive.otterware.dev"]) {
      expect(parseDriveUrl(`https://${host}/team-docs/a/q3-plan/v4`)).toMatchObject({
        type: "document",
        url: "https://drive.otterware.app/team-docs/a/q3-plan/v4",
      });
    }
  });

  it("reads share links, folders and raw content URLs", () => {
    expect(parseDriveUrl("https://drive.otterware.app/s/AbC123_x")).toEqual({
      type: "share-link",
      token: "AbC123_x",
      url: "https://drive.otterware.app/s/AbC123_x",
    });
    expect(parseDriveUrl("https://drive.otterware.app/home?folder=f-1")).toEqual({
      type: "folder",
      folderId: "f-1",
      url: "https://drive.otterware.app/home?folder=f-1",
    });
    expect(
      parseDriveUrl(`https://usercontent.otterware.app/raw/a/${ID}/version-1/index.md`),
    ).toMatchObject({ type: "document", folderSlug: null, reference: ID });
  });

  it("follows a configured Drive deployment and rejects everything else", () => {
    expect(
      parseDriveUrl("http://localhost:3000/team-docs/a/q3-plan", "http://localhost:3000"),
    ).toMatchObject({ url: "http://localhost:3000/team-docs/a/q3-plan" });
    expect(parseDriveUrl("https://example.com/team-docs/a/q3-plan")).toBeNull();
    expect(parseDriveUrl("https://drive.otterware.app/api/a/q3-plan")).toBeNull();
    expect(parseDriveUrl("https://drive.otterware.app/settings")).toBeNull();
    expect(parseDriveUrl("not a url")).toBeNull();
    expect(parseDriveUrl("ftp://drive.otterware.app/team-docs/a/q3-plan")).toBeNull();
  });
});

describe("driveDocumentUrl", () => {
  it("builds the document URL Drive routes", () => {
    expect(driveDocumentUrl("https://drive.otterware.app/", "team docs", "q3-plan", 2)).toBe(
      "https://drive.otterware.app/team%20docs/a/q3-plan/v2",
    );
  });
});

describe("driveDocumentKind", () => {
  it("matches Drive's own format decision", () => {
    expect(driveDocumentKind("", "notes.md")).toBe("markdown");
    expect(driveDocumentKind("text/plain", "notes")).toBe("text");
    expect(driveDocumentKind("", "data.tsv")).toBe("tsv");
    expect(driveDocumentKind("", "book.xlsx")).toBe("workbook");
    expect(driveDocumentKind("", "clip.webm")).toBe("video");
    expect(driveDocumentKind("", "index.html")).toBe("frame");
  });
});
