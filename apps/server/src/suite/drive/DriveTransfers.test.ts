// @effect-diagnostics nodeBuiltinImport:off -- Isolated temporary upload fixtures, never a real Drive.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { Artifact, Sharing } from "@otterware/drive-contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import { afterEach, vi } from "vite-plus/test";
import { makeDriveApi } from "./DriveApi.ts";
import { prepareUploadSource, validateUploadInput } from "./DriveUploadSource.ts";
import { changeSharing } from "./driveSharing.ts";

const ORIGIN = "https://drive.invalid";
const options = { token: "fake-token" };
const version = {
  id: "v1",
  number: 1,
  label: "Upload",
  entryPath: "movie.mov",
  createdAt: "2026-10-12T00:00:00.000Z",
  createdBy: null,
  fileCount: 1,
  byteSize: 6,
  contentHash: "hash",
};
const artifact: Artifact = {
  id: "document",
  folderId: "personal",
  ownerUserId: "user",
  slug: "movie",
  title: "movie.mov",
  description: "",
  createdAt: version.createdAt,
  updatedAt: version.createdAt,
  archivedAt: null,
  currentVersion: version,
  versionCount: 1,
  url: `${ORIGIN}/personal/a/movie/`,
};
const person = { userId: "user", email: "owner@example.com", name: "Owner", image: null };
const initialSharing: Sharing = {
  resource: { type: "artifact", id: "document", name: "movie", folderKind: null },
  drive: { id: "personal", name: "My Drive", kind: "personal", memberCount: 1 },
  owner: person,
  role: "owner",
  canShare: true,
  people: [],
  link: null,
  inheritedLink: null,
};

const jsonBody = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : {};
function fakeDrive(
  config: {
    multipart?: boolean;
    partSize?: number;
    status?: number;
    uploadOrigin?: string;
    wrongReceipt?: boolean;
  } = {},
) {
  const requests: Array<{
    method: string;
    path: string;
    body: ReturnType<typeof jsonBody>;
    folder?: string | undefined;
  }> = [];
  const chunks: Array<number> = [];
  const bytesByPart: Array<number> = [];
  const uploadedHash = NodeCrypto.createHash("sha256");
  let sharing = structuredClone(initialSharing);
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      const path = url.pathname;
      const body = jsonBody(request);
      requests.push({
        method: request.method,
        path: path + url.search,
        body,
        folder: request.headers["x-otterdrive-folder"],
      });
      expect(request.headers.authorization).toBe("Bearer fake-token");
      let bytes = 0;
      if (request.body._tag === "Stream") {
        yield* Stream.runForEach(Stream.orDie(request.body.stream), (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk.byteLength);
            bytes += chunk.byteLength;
            uploadedHash.update(chunk);
          }),
        );
        bytesByPart.push(bytes);
        expect(request.headers["content-length"]).toBe(String(bytes));
      }
      const respond = (data: unknown, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(data, { status }));
      if (config.status && path.endsWith("/uploads"))
        return respond(
          { error: { code: "version_conflict", message: "Current version changed." } },
          config.status,
        );
      if (path === "/api/v1/artifacts" && request.method === "POST")
        return respond({ data: { ...artifact, currentVersion: null, versionCount: 0 } });
      if (path.endsWith("/uploads"))
        return respond({
          data: {
            id: "upload",
            artifactId: "document",
            expiresAt: version.createdAt,
            files: [
              {
                path: body.entryPath,
                uploadUrl: `${config.uploadOrigin ?? ORIGIN}/api/v1/uploads/upload/files/${encodeURIComponent(body.entryPath)}`,
                multipart: config.multipart ?? false,
                ...(config.partSize === undefined ? {} : { partSize: config.partSize }),
              },
            ],
          },
        });
      if (request.method === "PUT" && path.includes("/files/")) {
        const part = Number(url.searchParams.get("part"));
        return part
          ? respond({
              data: { partNumber: config.wrongReceipt ? part + 1 : part, etag: `part-${part}` },
            })
          : HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
      }
      if (path.includes("/files/") && path.endsWith("/complete"))
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
      if (path === "/api/v1/uploads/upload/complete")
        return respond({ data: { artifact, version } });
      if (path.endsWith("/sharing/link")) {
        sharing.link =
          request.method === "DELETE" ? null : { url: `${ORIGIN}/s/token`, role: body.role };
        return respond({ data: sharing });
      }
      if (path.endsWith("/sharing/people")) {
        sharing.people.push(
          ...body.emails.map((email: string) => ({
            ...person,
            userId: null,
            email,
            id: email,
            role: body.role,
            inheritedFrom: null,
            viaLink: false,
          })),
        );
        return respond({ data: sharing });
      }
      if (path.includes("/sharing/people/")) {
        sharing.people = sharing.people.filter(
          (entry) => entry.id !== decodeURIComponent(path.split("/").pop()!),
        );
        return respond({ data: sharing });
      }
      if (path.endsWith("/sharing")) return respond({ data: sharing });
      return respond({ error: { code: "not_found", message: "Unexpected fake endpoint." } }, 404);
    }),
  );
  return {
    http,
    requests,
    chunks,
    bytesByPart,
    uploadedHash,
    setSharing: (value: Sharing) => {
      sharing = value;
    },
  };
}
const apiFor = (fake: ReturnType<typeof fakeDrive>) =>
  makeDriveApi(ORIGIN).pipe(Effect.provideService(HttpClient.HttpClient, fake.http));
const withSource = <A, E>(
  input: Parameters<typeof prepareUploadSource>[0],
  run: (source: Effect.Success<ReturnType<typeof prepareUploadSource>>) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(prepareUploadSource(input), run, (source) =>
    Effect.promise(source.close),
  );
afterEach(() => vi.unstubAllGlobals());

describe("Drive file transfers against a fake API", () => {
  it.effect("streams one binary file, creates metadata, and completes version 1", () =>
    Effect.gen(function* () {
      const fake = fakeDrive();
      const api = yield* apiFor(fake);
      const input = {
        name: "movie.mov",
        contentBase64: Buffer.from([0, 255, 1, 2, 3, 4]).toString("base64"),
      };
      const result = yield* withSource(input, (source) =>
        Effect.gen(function* () {
          const created = yield* api.createArtifact(
            {
              title: input.name,
              slug: "movie",
              entryPath: input.name,
              description: "",
              label: "Upload",
            },
            { ...options, folderId: "shared-otterware" },
          );
          return yield* api.uploadFile(created.id, input.name, source, 0, options);
        }),
      );
      expect(result.artifact.id).toBe("document");
      expect(fake.requests[0]?.folder).toBe("shared-otterware");
      expect(fake.requests[1]?.body).toMatchObject({
        expectedCurrentVersion: 0,
        files: [{ size: 6, contentType: "video/quicktime" }],
      });
      expect(fake.uploadedHash.digest("hex")).toBe(
        NodeCrypto.createHash("sha256")
          .update(Buffer.from([0, 255, 1, 2, 3, 4]))
          .digest("hex"),
      );
      expect(fake.requests.at(-1)?.path).toBe("/api/v1/uploads/upload/complete");
    }),
  );
  it.effect(
    "streams a 44 MiB file as sequential multipart ranges and accepts a 204 file completion",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "drive-test-")),
        );
        yield* Effect.acquireUseRelease(
          Effect.succeed(directory),
          () =>
            Effect.gen(function* () {
              const path = NodePath.join(directory, "large.mov");
              yield* Effect.promise(async () => {
                const file = await NodeFSP.open(path, "w");
                try {
                  await file.truncate(44 * 1024 * 1024);
                } finally {
                  await file.close();
                }
              });
              const fake = fakeDrive({ multipart: true, partSize: 8 * 1024 * 1024 });
              const api = yield* apiFor(fake);
              yield* withSource({ name: "large.mov", path }, (source) =>
                api.uploadFile("document", "large.mov", source, 0, options),
              );
              expect(fake.bytesByPart).toEqual(
                [8, 8, 8, 8, 8, 4].map((size) => size * 1024 * 1024),
              );
              expect(Math.max(...fake.chunks)).toBeLessThanOrEqual(64 * 1024);
              const complete = fake.requests.find((request) =>
                request.path.endsWith("large.mov/complete"),
              );
              expect(complete?.body.parts).toEqual(
                Array.from({ length: 6 }, (_, index) => ({
                  partNumber: index + 1,
                  etag: `part-${index + 1}`,
                })),
              );
            }),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        );
      }),
  );
  it.effect(
    "passes the inspected version to the upload session and stops on 409 without uploading",
    () =>
      Effect.gen(function* () {
        const fake = fakeDrive({ status: 409 });
        const api = yield* apiFor(fake);
        const result = yield* withSource({ name: "update.txt", contentBase64: "YQ==" }, (source) =>
          api.uploadFile("document", "update.txt", source, 7, options),
        ).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(fake.requests[0]?.body.expectedCurrentVersion).toBe(7);
        expect(fake.requests).toHaveLength(1);
      }),
  );
  it.effect("uploads a new version without creating another document", () =>
    Effect.gen(function* () {
      const fake = fakeDrive();
      const api = yield* apiFor(fake);
      yield* withSource(
        { name: "update.txt", contentBase64: "YQ==", documentRef: "document", ifVersion: 1 },
        (source) => api.uploadFile("document", "update.txt", source, 1, options),
      );
      expect(fake.requests[0]?.path).toBe("/api/v1/artifacts/document/uploads");
      expect(fake.requests[0]?.body.expectedCurrentVersion).toBe(1);
      expect(fake.requests.some((request) => request.path === "/api/v1/artifacts")).toBe(false);
    }),
  );
  it.effect("rejects missing multipart sizes, wrong receipts, and foreign upload origins", () =>
    Effect.gen(function* () {
      for (const config of [
        { multipart: true },
        { multipart: true, partSize: 1, wrongReceipt: true },
        { uploadOrigin: "https://other.invalid" },
      ]) {
        const fake = fakeDrive(config);
        const api = yield* apiFor(fake);
        const result = yield* withSource({ name: "a.txt", contentBase64: "YQ==" }, (source) =>
          api.uploadFile("document", "a.txt", source, 0, options),
        ).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(
          fake.requests.some((request) => request.path === "/api/v1/uploads/upload/complete"),
        ).toBe(false);
      }
    }),
  );
  it.effect("spools URL downloads to disk without forwarding Drive authorization", () =>
    Effect.gen(function* () {
      const download = vi.fn<typeof globalThis.fetch>(
        async (_url, _init) => new Response("downloaded"),
      );
      const fake = fakeDrive();
      const api = yield* apiFor(fake);
      yield* withSource({ name: "a.txt", url: "https://source.invalid/file" }, (source) =>
        api.uploadFile("document", "a.txt", source, 0, options),
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, download));
      expect(download.mock.calls[0]?.[1]).not.toHaveProperty("headers");
      expect(fake.bytesByPart).toEqual([10]);
    }),
  );
  it("rejects ambiguous inputs, relative paths, malformed/large base64, drafts and missing version guards", () => {
    for (const input of [
      { name: "a.txt" },
      { name: "a.txt", path: "/tmp/a", url: "https://a.invalid" },
      { name: "a.txt", path: "relative" },
      { name: "../a", contentBase64: "YQ==" },
      { name: "a.txt", contentBase64: "!" },
      { name: "a.txt", contentBase64: "a".repeat(1_398_108) },
      { name: "a.txt", url: "file:///tmp/a" },
      { name: "a.txt", contentBase64: "YQ==", publish: false },
      { name: "a.txt", contentBase64: "YQ==", documentRef: "document" },
    ])
      expect(() => validateUploadInput(input)).toThrow();
  });
  it.effect("reports missing files and failed downloads without touching Drive", () =>
    Effect.gen(function* () {
      const missing = yield* prepareUploadSource({
        name: "a.txt",
        path: "/does-not-exist-otterware-test",
      }).pipe(Effect.result);
      expect(missing._tag).toBe("Failure");
      const download: typeof globalThis.fetch = async () => new Response(null, { status: 404 });
      expect(
        (yield* prepareUploadSource({ name: "a.txt", url: "https://source.invalid/file" }).pipe(
          Effect.provideService(FetchHttpClient.Fetch, download),
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }),
  );
});

describe("Drive sharing against a fake API", () => {
  it.effect("enables, reads, and disables an anyone-with-the-link share", () =>
    Effect.gen(function* () {
      const fake = fakeDrive();
      const api = yield* apiFor(fake);
      const shared = yield* changeSharing(
        api,
        "artifacts",
        "document",
        { linkRole: "viewer" },
        options.token,
      );
      expect(shared.url).toBe(`${ORIGIN}/s/token`);
      expect((yield* api.getSharing("artifacts", "document", options)).link?.role).toBe("viewer");
      expect(
        (yield* changeSharing(api, "artifacts", "document", { linkRole: "none" }, options.token))
          .url,
      ).toBeNull();
      expect(fake.requests.map((request) => request.method)).toEqual([
        "GET",
        "PUT",
        "GET",
        "GET",
        "DELETE",
      ]);
    }),
  );
  it.effect("grants viewer/editor emails without notifications and revokes their access IDs", () =>
    Effect.gen(function* () {
      const fake = fakeDrive();
      const api = yield* apiFor(fake);
      yield* changeSharing(
        api,
        "artifacts",
        "document",
        {
          grant: [
            { email: "VIEW@example.com", role: "viewer" },
            { email: "edit@example.com", role: "editor" },
          ],
        },
        options.token,
      );
      const grants = fake.requests.filter((request) => request.method === "POST");
      expect(grants.map((request) => request.body)).toEqual([
        { emails: ["view@example.com"], role: "viewer", notify: false },
        { emails: ["edit@example.com"], role: "editor", notify: false },
      ]);
      const result = yield* changeSharing(
        api,
        "artifacts",
        "document",
        { revoke: ["view@example.com"] },
        options.token,
      );
      expect(result.people.map((person) => person.email)).toEqual(["edit@example.com"]);
      expect(fake.requests.at(-1)?.path).toBe(
        "/api/v1/artifacts/document/sharing/people/view%40example.com",
      );
    }),
  );
  it.effect(
    "shares folders recursively and manages shared-drive email memberships through the folder API",
    () =>
      Effect.gen(function* () {
        const fake = fakeDrive();
        const api = yield* apiFor(fake);
        yield* changeSharing(api, "folders", "folder", { linkRole: "editor" }, options.token);
        fake.setSharing({
          ...initialSharing,
          resource: { type: "folder", id: "drive", name: "Team", folderKind: "shared" },
        });
        yield* changeSharing(
          api,
          "folders",
          "drive",
          { grant: [{ email: "member@example.com", role: "viewer" }] },
          options.token,
        );
        expect(fake.requests.at(-1)?.path).toBe("/api/v1/folders/drive/sharing/people");
        expect(
          (yield* changeSharing(
            api,
            "folders",
            "drive",
            { linkRole: "viewer" },
            options.token,
          ).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
  );
  it.effect(
    "preflights inherited access, duplicates, missing grants and forbidden sharing before mutations",
    () =>
      Effect.gen(function* () {
        const fake = fakeDrive();
        const api = yield* apiFor(fake);
        for (const input of [
          { revoke: ["missing@example.com"], linkRole: "viewer" as const },
          {
            grant: [{ email: "a@example.com", role: "viewer" as const }],
            revoke: ["a@example.com"],
          },
          {},
        ]) {
          expect(
            (yield* changeSharing(api, "artifacts", "document", input, options.token).pipe(
              Effect.result,
            ))._tag,
          ).toBe("Failure");
        }
        fake.setSharing({ ...initialSharing, canShare: false });
        expect(
          (yield* changeSharing(
            api,
            "artifacts",
            "document",
            { linkRole: "editor" },
            options.token,
          ).pipe(Effect.result))._tag,
        ).toBe("Failure");
        fake.setSharing({
          ...initialSharing,
          people: [
            {
              ...person,
              id: "inherited",
              role: "viewer",
              inheritedFrom: { id: "parent", name: "Parent" },
              viaLink: false,
            },
          ],
        });
        expect(
          (yield* changeSharing(
            api,
            "artifacts",
            "document",
            { revoke: [person.email] },
            options.token,
          ).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
      }),
  );
});

// The production transport must preserve Content-Length. Effect's fetch client
// strips it, and Drive rejects those streamed requests as size_mismatch.
it.effect("preserves the exact Content-Length over the production Node HTTP transport", () =>
  Effect.gen(function* () {
    const received: Array<number> = [];
    const server = NodeHttp.createServer(async (request, response) => {
      try {
        let size = 0;
        for await (const chunk of request) size += chunk.length;
        response.setHeader("content-type", "application/json");
        if (request.method === "PUT") {
          received.push(size);
          if (request.headers["content-length"] !== String(size)) {
            response.writeHead(400);
            response.end(
              JSON.stringify({
                error: { code: "size_mismatch", message: "File size does not match manifest." },
              }),
            );
            return;
          }
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.url?.endsWith("/uploads")) {
          response.end(
            JSON.stringify({
              data: {
                id: "upload",
                artifactId: "document",
                expiresAt: version.createdAt,
                files: [
                  {
                    path: "a.txt",
                    uploadUrl: "/api/v1/uploads/upload/files/a.txt",
                    multipart: false,
                  },
                ],
              },
            }),
          );
          return;
        }
        response.end(JSON.stringify({ data: { artifact, version } }));
      } catch {
        response.writeHead(500);
        response.end();
      }
    });
    yield* Effect.acquireUseRelease(
      Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
      () =>
        Effect.gen(function* () {
          const address = server.address();
          if (address === null || typeof address === "string")
            return yield* Effect.die("No test server port");
          const api = yield* makeDriveApi(`http://127.0.0.1:${address.port}`).pipe(
            Effect.provide(NodeHttpClient.layerNodeHttp),
          );
          yield* withSource(
            { name: "a.txt", contentBase64: Buffer.alloc(100_000, 65).toString("base64") },
            (source) => api.uploadFile("document", "a.txt", source, 0, options),
          );
          expect(received).toEqual([100_000]);
        }),
      () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }).pipe(Effect.scoped),
);
