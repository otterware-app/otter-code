import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { Artifact, Folder, SharedItem } from "@otterware/drive-contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SuiteDatabase from "../SuiteDatabase.ts";
import { runSuiteMigrations } from "../SuiteMigrations.ts";
import { makeDriveApi } from "./DriveApi.ts";
import { DRIVE_SESSION_SECRET } from "./DriveConnection.ts";
import { makeWith } from "./DriveService.ts";
import { DRIVE_MIGRATIONS, makeDriveStore } from "./DriveStore.ts";

const BASE = "https://drive.otterware.app";
const TOKEN = "session-token";
const DOC_ID = "3f2b8c1e-9a4d-4c2e-8f1a-0b6d5e7c9a12";
const SHARED_ID = "7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

/** A tiny Otter Drive: folders, documents with versions, share links, device flow. */
function makeFakeDrive() {
  const folders: Array<Folder> = [
    {
      id: "folder-team",
      name: "Team",
      slug: "team-docs",
      parentId: null,
      kind: "shared",
      ownerUserId: "u-1",
      role: "owner",
    },
  ];
  const documents = new Map<
    string,
    { folderId: string; folderSlug: string; slug: string; title: string; versions: Array<string> }
  >([
    [
      DOC_ID,
      {
        folderId: "folder-team",
        folderSlug: "team-docs",
        slug: "q3-plan",
        title: "Q3 plan",
        versions: ["# Plan v1", "# Plan v2"],
      },
    ],
    [
      SHARED_ID,
      {
        folderId: "folder-bob",
        folderSlug: "bob-drive",
        slug: "notes",
        title: "Bob's notes",
        versions: ["hello"],
      },
    ],
  ]);
  const state = {
    validToken: TOKEN as string | null,
    deviceApproved: false,
    requests: [] as Array<string>,
  };

  const versionOf = (id: string, number: number) => {
    const doc = documents.get(id)!;
    return {
      id: `${id}-v${number}`,
      number,
      label: `Version ${number}`,
      entryPath: `${doc.slug}.md`,
      createdAt: `2026-10-0${number}T10:00:00.000Z`,
      createdBy: { id: "u-2", name: number > 1 ? "Alice" : "Bob", type: "user" as const },
      fileCount: 1,
      byteSize: doc.versions[number - 1]!.length,
      contentHash: `hash-${number}`,
    };
  };
  const artifactOf = (id: string): Artifact => {
    const doc = documents.get(id)!;
    return {
      id,
      folderId: doc.folderId,
      ownerUserId: "u-1",
      slug: doc.slug,
      title: doc.title,
      description: "",
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: `2026-10-0${doc.versions.length}T10:00:00.000Z`,
      archivedAt: null,
      currentVersion: versionOf(id, doc.versions.length),
      versionCount: doc.versions.length,
      url: `${BASE}/${doc.folderSlug}/a/${doc.slug}/`,
      role: "owner",
      shared: false,
    };
  };
  const shared = (): Array<SharedItem> => [
    {
      type: "artifact",
      role: "viewer",
      sharedAt: "2026-10-01T10:00:00.000Z",
      sharedBy: { userId: "u-3", email: "bob@example.com", name: "Bob", image: null },
      owner: { userId: "u-3", email: "bob@example.com", name: "Bob", image: null },
      folderSlug: "bob-drive",
      artifact: artifactOf(SHARED_ID),
    },
  ];

  const respond = (status: number, body: unknown) => Response.json(body, { status });
  const handle = (method: string, url: URL, headers: Record<string, string>): Response => {
    state.requests.push(`${method} ${url.pathname}`);
    const path = url.pathname;
    if (path === "/api/auth/device/code")
      return respond(200, {
        device_code: "dev-code",
        user_code: "ABCD1234",
        verification_uri: `${BASE}/device`,
        verification_uri_complete: `${BASE}/device?user_code=ABCD1234`,
        expires_in: 1800,
        interval: 5,
      });
    if (path === "/api/auth/device/token")
      return state.deviceApproved
        ? respond(200, { access_token: TOKEN, token_type: "Bearer" })
        : respond(400, { error: "authorization_pending", error_description: "pending" });
    if (state.validToken === null || headers.authorization !== `Bearer ${state.validToken}`)
      return respond(401, { error: { code: "unauthenticated", message: "Please log in." } });
    if (path === "/api/v1/me")
      return respond(200, {
        data: { actor: { id: "u-1", type: "user", name: "Ada" }, userId: "u-1", folderId: "p" },
      });
    if (path === "/api/v1/folders") return respond(200, { data: folders });
    if (path === "/api/v1/shared") return respond(200, { data: shared() });
    if (path === "/api/v1/links/share-token" && method === "POST")
      return respond(200, {
        data: {
          type: "artifact",
          folderId: "folder-team",
          folderSlug: "team-docs",
          slug: "q3-plan",
        },
      });
    const match = path.match(/^\/api\/v1\/artifacts\/([^/]+)(?:\/(versions|content))?$/u);
    if (match) {
      const reference = decodeURIComponent(match[1]!);
      const folderId = headers["x-otterdrive-folder"];
      const id = [...documents.entries()].find(
        ([key, doc]) => key === reference || (doc.slug === reference && doc.folderId === folderId),
      )?.[0];
      if (!id)
        return respond(404, {
          error: { code: "artifact_not_found", message: "Document not found." },
        });
      const doc = documents.get(id)!;
      if (match[2] === "versions")
        return respond(200, {
          data: doc.versions.map((_, index) => versionOf(id, index + 1)).toReversed(),
          pagination: { nextCursor: null },
        });
      if (match[2] === "content") {
        const version = Number(url.searchParams.get("version") ?? doc.versions.length);
        return new Response(doc.versions[version - 1]!, {
          headers: { "content-type": "text/markdown" },
        });
      }
      return respond(200, { data: artifactOf(id) });
    }
    return respond(404, { error: { code: "not_found", message: "API endpoint not found." } });
  };

  const http = HttpClient.make((request) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        handle(request.method, new URL(request.url), request.headers as Record<string, string>),
      ),
    ),
  );
  return { http, documents, state };
}

function makeSecretStore(initial: Record<string, string> = {}) {
  const secrets = new Map<string, Uint8Array>(
    Object.entries(initial).map(([key, value]) => [key, new TextEncoder().encode(value)]),
  );
  return Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: (name) => Effect.sync(() => secrets.get(name) ?? new Uint8Array()),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });
}

const connectedSession = {
  [DRIVE_SESSION_SECRET]: JSON.stringify({
    baseUrl: BASE,
    token: TOKEN,
    account: { userId: "u-1", name: "Ada" },
    connectedAt: "2026-10-01T00:00:00.000Z",
  }),
};

const database = SuiteDatabase.layerSqlClient.pipe(Layer.provideMerge(SuiteDatabase.layerMemory));

const setup = (
  fake: ReturnType<typeof makeFakeDrive>,
  secrets = makeSecretStore(connectedSession),
) =>
  Effect.gen(function* () {
    yield* runSuiteMigrations(DRIVE_MIGRATIONS);
    const api = yield* makeDriveApi(BASE).pipe(
      Effect.provideService(HttpClient.HttpClient, fake.http),
    );
    const store = yield* makeDriveStore;
    return yield* makeWith({ api, store }).pipe(Effect.provide(secrets));
  });

const testLayer = Layer.mergeAll(database, NodeServices.layer);

describe("DriveService", () => {
  it.effect("creates its tables in suite.sqlite", () =>
    Effect.gen(function* () {
      yield* runSuiteMigrations(DRIVE_MIGRATIONS);
      yield* runSuiteMigrations(DRIVE_MIGRATIONS);
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'drive_%' ORDER BY name
      `;
      expect(tables.map((row) => row.name)).toEqual([
        "drive_document_views",
        "drive_shared_documents",
        "drive_thread_links",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("links offline with a not-connected snapshot, and unlinks", () =>
    Effect.gen(function* () {
      const fake = makeFakeDrive();
      const drive = yield* setup(fake, makeSecretStore());
      const { link, alreadyLinked } = yield* drive.linkDocument({
        threadId: "thread-1",
        reference: "https://app.otterware.dev/team-docs/a/q3-plan/v2",
        source: "manual",
      });
      expect(alreadyLinked).toBe(false);
      expect(link).toMatchObject({
        threadId: "thread-1",
        artifactId: null,
        url: `${BASE}/team-docs/a/q3-plan/v2`,
        folderSlug: "team-docs",
        slug: "q3-plan",
        version: 2,
        snapshot: null,
        syncState: "not_connected",
      });
      expect(fake.state.requests).toEqual([]);
      const again = yield* drive.linkDocument({
        threadId: "thread-1",
        reference: `${BASE}/team-docs/a/q3-plan/v2/`,
        source: "agent",
      });
      expect(again.alreadyLinked).toBe(true);
      expect(yield* drive.listThreadLinks("thread-1")).toHaveLength(1);
      expect(yield* drive.unlinkDocument("thread-1", link.id)).toEqual({ wasLinked: true });
      expect(yield* drive.listThreadLinks("thread-1")).toEqual([]);
      const error = yield* Effect.flip(
        drive.linkDocument({
          threadId: "thread-1",
          reference: "https://example.com/x",
          source: "manual",
        }),
      );
      expect(error.reason).toBe("invalid_url");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resolves slugs, ids and share links to one document and keys the link by its id", () =>
    Effect.gen(function* () {
      const fake = makeFakeDrive();
      const drive = yield* setup(fake);
      const first = yield* drive.linkDocument({
        threadId: "thread-1",
        reference: `${BASE}/team-docs/a/q3-plan`,
        source: "manual",
      });
      expect(first.link).toMatchObject({
        artifactId: DOC_ID,
        syncState: "synced",
        changed: false,
        snapshot: { title: "Q3 plan", version: 2, updatedBy: "Alice", kind: "markdown" },
      });
      const byId = yield* drive.linkDocument({
        threadId: "thread-1",
        reference: DOC_ID,
        source: "agent",
      });
      expect(byId.alreadyLinked).toBe(true);
      const byShare = yield* drive.linkDocument({
        threadId: "thread-1",
        reference: `${BASE}/s/share-token`,
        source: "manual",
      });
      expect(byShare).toMatchObject({ alreadyLinked: true, link: { id: first.link.id } });
      expect(yield* drive.listThreadLinks("thread-1")).toHaveLength(1);
      // A document shared on its own resolves through "Shared with me".
      const standalone = yield* drive.linkDocument({
        threadId: "thread-2",
        reference: `${BASE}/bob-drive/a/notes`,
        source: "manual",
      });
      expect(standalone.link).toMatchObject({
        artifactId: SHARED_ID,
        snapshot: { title: "Bob's notes" },
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("syncs new versions onto links, marks them changed until viewed, and feeds Home", () =>
    Effect.gen(function* () {
      const fake = makeFakeDrive();
      const drive = yield* setup(fake);
      yield* drive.linkDocument({ threadId: "thread-1", reference: DOC_ID, source: "manual" });
      fake.documents.get(DOC_ID)!.versions.push("# Plan v3");
      yield* drive.syncNow;
      const [link] = yield* drive.listThreadLinks("thread-1");
      expect(link).toMatchObject({ changed: true, snapshot: { version: 3 } });
      const home = yield* drive.changedDocuments;
      expect(home).toEqual([
        expect.objectContaining({
          artifactId: DOC_ID,
          version: 3,
          viewedVersion: 2,
          threadIds: ["thread-1"],
        }),
      ]);
      const latest = yield* drive.linkChanges.pipe(Stream.take(1), Stream.runCollect);
      expect(latest[0]?.links[0]?.changed).toBe(true);
      yield* drive.markViewed(DOC_ID, 3);
      expect((yield* drive.listThreadLinks("thread-1"))[0]?.changed).toBe(false);
      expect(yield* drive.changedDocuments).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reads detail with a text preview of the version a link names", () =>
    Effect.gen(function* () {
      const fake = makeFakeDrive();
      const drive = yield* setup(fake);
      const detail = yield* drive.documentDetail(`${BASE}/team-docs/a/q3-plan/v1`);
      expect(detail.document.title).toBe("Q3 plan");
      expect(detail.versions.map((version) => version.number)).toEqual([2, 1]);
      expect(detail.preview).toEqual({
        type: "text",
        version: 1,
        text: "# Plan v1",
        truncated: false,
      });
      const read = yield* drive.readDocument(DOC_ID);
      expect(read).toMatchObject({ version: 2, text: "# Plan v2" });
      expect(yield* drive.readDocument(`${BASE}/team-docs/a/q3-plan/v1`)).toMatchObject({
        version: 1,
        text: "# Plan v1",
      });
      expect(
        (yield* Effect.flip(drive.documentDetail(`${BASE}/team-docs/a/q3-plan/v99`))).reason,
      ).toBe("not_found");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("a token Drive rejects signs the server out and links say not connected", () =>
    Effect.gen(function* () {
      const fake = makeFakeDrive();
      const drive = yield* setup(fake);
      yield* drive.linkDocument({ threadId: "thread-1", reference: DOC_ID, source: "manual" });
      fake.state.validToken = null;
      yield* drive.syncNow;
      expect((yield* drive.status).status).toBe("error");
      expect((yield* drive.listThreadLinks("thread-1"))[0]).toMatchObject({
        syncState: "not_connected",
        snapshot: { title: "Q3 plan" },
      });
      const error = yield* Effect.flip(drive.listFolders);
      expect(error.reason).toBe("not_connected");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resolves offline links after connection and preserves snapshots on API failure", () =>
    Effect.gen(function* () {
      const fake = makeFakeDrive();
      const drive = yield* setup(fake, makeSecretStore());
      const { link } = yield* drive.linkDocument({
        threadId: "thread-1",
        reference: `${BASE}/team-docs/a/q3-plan/v1?sheet=Summary%202026`,
        source: "manual",
      });
      expect(link.syncState).toBe("not_connected");
      expect(link.url).toBe(`${BASE}/team-docs/a/q3-plan/v1?sheet=Summary%202026`);
      fake.state.deviceApproved = true;
      yield* drive.connect;
      yield* TestClock.adjust(Duration.seconds(5));
      yield* drive.syncNow;
      expect((yield* drive.listThreadLinks("thread-1"))[0]).toMatchObject({
        artifactId: DOC_ID,
        url: `${BASE}/team-docs/a/q3-plan/v1?sheet=Summary+2026`,
        version: 1,
        syncState: "synced",
        changed: false,
        snapshot: { title: "Q3 plan", version: 2 },
      });
      fake.documents.delete(DOC_ID);
      yield* drive.syncNow;
      expect((yield* drive.listThreadLinks("thread-1"))[0]).toMatchObject({
        artifactId: DOC_ID,
        url: `${BASE}/team-docs/a/q3-plan/v1?sheet=Summary+2026`,
        version: 1,
        syncState: "not_found",
        snapshot: { title: "Q3 plan", version: 2 },
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("connects through Drive's device flow", () =>
    Effect.gen(function* () {
      const fake = makeFakeDrive();
      const drive = yield* setup(fake, makeSecretStore());
      expect((yield* drive.status).status).toBe("disconnected");
      const pending = yield* drive.connect;
      expect(pending).toMatchObject({
        status: "pending",
        userCode: "ABCD1234",
        verificationUri: `${BASE}/device`,
        verificationUriComplete: `${BASE}/device?user_code=ABCD1234`,
      });
      yield* TestClock.adjust(Duration.seconds(5));
      expect((yield* drive.status).status).toBe("pending");
      fake.state.deviceApproved = true;
      yield* TestClock.adjust(Duration.seconds(5));
      expect(yield* drive.status).toEqual({
        status: "connected",
        baseUrl: BASE,
        account: { userId: "u-1", name: "Ada" },
      });
      expect((yield* drive.listFolders).map((folder) => folder.slug)).toEqual(["team-docs"]);
      expect((yield* drive.disconnect).status).toBe("disconnected");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
