// @effect-diagnostics nodeBuiltinImport:off
/**
 * Otter Drive's REST API (`/api/v1/*`) and its device authorization
 * endpoints, typed and validated by Drive's own Zod contracts (vendored from
 * the otter-drive repository, see `scripts/otterware/sync-otter-drive.ts`).
 * Requests carry the device-flow session as a Bearer token; mutations with a
 * bearer need no Origin header. Folder context goes in `x-otterdrive-folder`.
 */
import {
  acceptLinkResponseSchema,
  apiErrorSchema,
  artifactListResponseSchema,
  artifactResponseSchema,
  artifactVersionsResponseSchema,
  completeUploadResponseSchema,
  deviceCodeResponseSchema,
  deviceTokenResponseSchema,
  folderListResponseSchema,
  sharedWithMeResponseSchema,
  uploadSessionResponseSchema,
  multipartUploadPartResponseSchema,
  sharingResponseSchema,
  type ShareRole,
  type AcceptLinkResponse,
  type Artifact,
  type ArtifactVersion,
  type CompleteUploadResponse,
  type CreateArtifactInput,
  type Folder,
  type SharedItem,
} from "@otterware/drive-contracts";
import type { DriveUploadSource } from "./DriveUploadSource.ts";
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

/** The CLI client id Drive accepts for Otterware's device authorization. */
export const DRIVE_DEVICE_CLIENT_ID = "otterware-cli";
const DEVICE_SCOPE = "openid profile email offline_access";
const REQUEST_TIMEOUT = "20 seconds";

export class DriveApiError extends Schema.TaggedError<DriveApiError>()("DriveApiError", {
  /** HTTP status; 0 when Drive could not be reached or answered something unreadable. */
  status: Schema.Number,
  code: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** What the vendored Zod schemas offer; the server itself does not depend on zod. */
interface Parser<T> {
  readonly safeParse: (
    body: unknown,
  ) => { readonly success: true; readonly data: T } | { readonly success: false };
}

/** `GET /api/v1/me` is untyped upstream; its shape is read from `api.v1.$.ts`. */
const MeResponse = Schema.Struct({
  data: Schema.Struct({
    actor: Schema.Struct({ id: Schema.String, type: Schema.String, name: Schema.String }),
    userId: Schema.optional(Schema.NullOr(Schema.String)),
    folderId: Schema.String,
  }),
});
export type DriveMe = (typeof MeResponse.Type)["data"];

/** RFC 8628 errors from Better Auth's device token endpoint. */
const DeviceError = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});

const effectParser = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
): Parser<S["Type"]> => {
  const decode = Schema.decodeUnknownOption(schema);
  return {
    safeParse: (body) => {
      const decoded = decode(body);
      return decoded._tag === "Some" ? { success: true, data: decoded.value } : { success: false };
    },
  };
};
const meResponseSchema = effectParser(MeResponse);
const deviceErrorSchema = effectParser(DeviceError);
export type DeviceTokenResult =
  | { readonly _tag: "Token"; readonly accessToken: string }
  | { readonly _tag: "Pending"; readonly slowDown: boolean }
  | { readonly _tag: "Denied"; readonly reason: string };

export interface DriveRequestOptions {
  readonly token: string;
  /** Sent as `x-otterdrive-folder`: the folder a slug is resolved in, or new documents go to. */
  readonly folderId?: string | undefined;
}

const parseWith = <T>(schema: Parser<T>, body: unknown, what: string) => {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new DriveApiError({
          status: 0,
          code: "invalid_response",
          detail: `Otter Drive sent an unexpected ${what}.`,
        }),
      );
};

/** Drive's API client for one base URL. Build with an `HttpClient` in context. */
export const makeDriveApi = (baseUrl: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const origin = new URL(baseUrl).origin;

    const failureOf = (response: HttpClientResponse.HttpClientResponse) =>
      response.json.pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((body) => {
          const parsed = apiErrorSchema.safeParse(body);
          return Effect.fail(
            new DriveApiError({
              status: response.status,
              code: parsed.success ? parsed.data.error.code : `http_${response.status}`,
              detail: parsed.success
                ? parsed.data.error.message
                : `Otter Drive answered ${response.status}.`,
            }),
          );
        }),
      );

    const send = (request: HttpClientRequest.HttpClientRequest, transfer = false) =>
      client.execute(request).pipe(
        Effect.timeout(transfer ? "30 minutes" : REQUEST_TIMEOUT),
        Effect.mapError(
          () =>
            new DriveApiError({
              status: 0,
              code: "unreachable",
              detail: `Could not reach Otter Drive at ${origin}.`,
            }),
        ),
      );

    const authorized = (
      request: HttpClientRequest.HttpClientRequest,
      options: DriveRequestOptions,
    ) =>
      request.pipe(
        HttpClientRequest.setHeaders({
          accept: "application/json",
          authorization: `Bearer ${options.token}`,
          ...(options.folderId ? { "x-otterdrive-folder": options.folderId } : {}),
        }),
      );

    const json = <T>(
      request: HttpClientRequest.HttpClientRequest,
      options: DriveRequestOptions,
      schema: Parser<T>,
      what: string,
    ) =>
      send(authorized(request, options)).pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? response.json.pipe(
                Effect.mapError(
                  () =>
                    new DriveApiError({
                      status: response.status,
                      code: "invalid_response",
                      detail: `Otter Drive sent an unreadable ${what}.`,
                    }),
                ),
                Effect.flatMap((body) => parseWith(schema, body, what)),
              )
            : failureOf(response),
        ),
      );

    const url = (path: string, query?: Record<string, string | number | undefined>) => {
      const target = new URL(path, origin);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) target.searchParams.set(key, String(value));
      }
      return target.toString();
    };
    const ref = (reference: string) => encodeURIComponent(reference);

    /** Starts the device authorization a person approves at `verification_uri`. */
    const deviceCode = send(
      HttpClientRequest.post(url("/api/auth/device/code")).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
        HttpClientRequest.bodyJsonUnsafe({
          client_id: DRIVE_DEVICE_CLIENT_ID,
          scope: DEVICE_SCOPE,
        }),
      ),
    ).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? response.json.pipe(
              Effect.orElseSucceed(() => null),
              Effect.flatMap((body) => parseWith(deviceCodeResponseSchema, body, "device code")),
            )
          : failureOf(response),
      ),
    );

    /** One poll of the device authorization. */
    const deviceToken = (code: string) =>
      send(
        HttpClientRequest.post(url("/api/auth/device/token")).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.bodyJsonUnsafe({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: code,
            client_id: DRIVE_DEVICE_CLIENT_ID,
          }),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.orElseSucceed(() => null),
            Effect.flatMap((body): Effect.Effect<DeviceTokenResult, DriveApiError> => {
              const token = deviceTokenResponseSchema.safeParse(body);
              if (response.status === 200 && token.success)
                return Effect.succeed({ _tag: "Token", accessToken: token.data.access_token });
              const error = deviceErrorSchema.safeParse(body);
              if (!error.success) return failureOf(response);
              if (error.data.error === "authorization_pending")
                return Effect.succeed({ _tag: "Pending", slowDown: false });
              if (error.data.error === "slow_down")
                return Effect.succeed({ _tag: "Pending", slowDown: true });
              return Effect.succeed({
                _tag: "Denied",
                reason: error.data.error_description ?? error.data.error,
              });
            }),
          ),
        ),
      );

    return {
      origin,
      uploadFile: (
        artifactId: string,
        name: string,
        source: DriveUploadSource,
        ifVersion: number,
        options: DriveRequestOptions,
      ) =>
        Effect.gen(function* () {
          const session = (yield* json(
            HttpClientRequest.post(url(`/api/v1/artifacts/${ref(artifactId)}/uploads`)).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                entryPath: name,
                label: `Upload ${name}`.slice(0, 300),
                expectedCurrentVersion: ifVersion,
                files: [
                  {
                    path: name,
                    size: source.size,
                    sha256: source.sha256,
                    contentType: source.contentType,
                  },
                ],
              }),
            ),
            options,
            uploadSessionResponseSchema,
            "upload session",
          )).data;
          if (session.files.length !== 1 || session.files[0]?.path !== name)
            return yield* new DriveApiError({
              status: 0,
              code: "invalid_response",
              detail: "Drive requested an unexpected upload file.",
            });
          const remote = session.files[0];
          if (!URL.canParse(remote.uploadUrl, origin))
            return yield* new DriveApiError({
              status: 0,
              code: "invalid_response",
              detail: "Drive returned an invalid upload URL.",
            });
          const target = new URL(remote.uploadUrl, origin);
          // Never send the user's token to an arbitrary origin from a malformed API response.
          if (target.origin !== origin)
            return yield* new DriveApiError({
              status: 0,
              code: "invalid_response",
              detail: "Drive requested an upload outside its API origin.",
            });
          const upload = (start: number, size: number, part?: number) => {
            const destination = new URL(target);
            if (part !== undefined) destination.searchParams.set("part", String(part));
            const stream = size === 0 ? Stream.empty : source.stream(start, start + size - 1);
            return send(
              authorized(
                HttpClientRequest.put(destination.toString()).pipe(
                  HttpClientRequest.setHeader("x-content-sha256", source.sha256),
                  HttpClientRequest.bodyStream(stream, {
                    contentType: source.contentType,
                    contentLength: size,
                  }),
                ),
                options,
              ),
              true,
            ).pipe(
              Effect.flatMap((response) =>
                response.status >= 200 && response.status < 300
                  ? Effect.succeed(response)
                  : failureOf(response),
              ),
            );
          };
          if (remote.multipart) {
            const size = remote.partSize;
            if (size === undefined || !Number.isSafeInteger(size) || size < 1)
              return yield* new DriveApiError({
                status: 0,
                code: "invalid_response",
                detail: "Drive omitted the multipart part size.",
              });
            const parts: Array<{ partNumber: number; etag: string }> = [];
            for (let start = 0; start < source.size; start += size) {
              const partNumber = parts.length + 1;
              const response = yield* upload(
                start,
                Math.min(size, source.size - start),
                partNumber,
              );
              const body = yield* response.json.pipe(
                Effect.mapError(
                  () =>
                    new DriveApiError({
                      status: 0,
                      code: "invalid_response",
                      detail: "Drive sent an unreadable multipart receipt.",
                    }),
                ),
              );
              const receipt = yield* parseWith(
                multipartUploadPartResponseSchema,
                body,
                "multipart receipt",
              );
              if (receipt.data.partNumber !== partNumber)
                return yield* new DriveApiError({
                  status: 0,
                  code: "invalid_response",
                  detail: "Drive returned the wrong multipart part number.",
                });
              parts.push(receipt.data);
            }
            const completed = yield* send(
              authorized(
                HttpClientRequest.post(`${target}/complete`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({ parts }),
                ),
                options,
              ),
              true,
            );
            if (completed.status < 200 || completed.status >= 300)
              return yield* failureOf(completed);
          } else {
            yield* upload(0, source.size);
          }
          return (yield* json(
            HttpClientRequest.post(url(`/api/v1/uploads/${ref(session.id)}/complete`)),
            options,
            completeUploadResponseSchema,
            "published version",
          )).data;
        }),
      createArtifact: (input: CreateArtifactInput, options: DriveRequestOptions) =>
        json(
          HttpClientRequest.post(url("/api/v1/artifacts")).pipe(
            HttpClientRequest.bodyJsonUnsafe(input),
          ),
          options,
          artifactResponseSchema,
          "document",
        ).pipe(Effect.map((body) => body.data)),
      deleteDraft: (id: string, options: DriveRequestOptions) =>
        send(
          authorized(HttpClientRequest.delete(url(`/api/v1/artifacts/${ref(id)}/draft`)), options),
        ).pipe(Effect.asVoid),
      getSharing: (kind: "artifacts" | "folders", id: string, options: DriveRequestOptions) =>
        json(
          HttpClientRequest.get(url(`/api/v1/${kind}/${ref(id)}/sharing`)),
          options,
          sharingResponseSchema,
          "sharing",
        ).pipe(Effect.map((body) => body.data)),
      setShareLink: (
        kind: "artifacts" | "folders",
        id: string,
        role: ShareRole | "none",
        options: DriveRequestOptions,
      ) =>
        json(
          role === "none"
            ? HttpClientRequest.delete(url(`/api/v1/${kind}/${ref(id)}/sharing/link`))
            : HttpClientRequest.put(url(`/api/v1/${kind}/${ref(id)}/sharing/link`)).pipe(
                HttpClientRequest.bodyJsonUnsafe({ role }),
              ),
          options,
          sharingResponseSchema,
          "sharing",
        ).pipe(Effect.map((body) => body.data)),
      grantAccess: (
        kind: "artifacts" | "folders",
        id: string,
        emails: ReadonlyArray<string>,
        role: ShareRole,
        options: DriveRequestOptions,
      ) =>
        json(
          HttpClientRequest.post(url(`/api/v1/${kind}/${ref(id)}/sharing/people`)).pipe(
            HttpClientRequest.bodyJsonUnsafe({ emails, role, notify: false }),
          ),
          options,
          sharingResponseSchema,
          "sharing",
        ).pipe(Effect.map((body) => body.data)),
      revokeAccess: (
        kind: "artifacts" | "folders",
        id: string,
        entryId: string,
        options: DriveRequestOptions,
      ) =>
        send(
          authorized(
            HttpClientRequest.delete(
              url(`/api/v1/${kind}/${ref(id)}/sharing/people/${ref(entryId)}`),
            ),
            options,
          ),
        ).pipe(
          Effect.flatMap((response) => {
            // Removing your own direct grant returns no sharing body (you just lost access).
            if (response.status === 204) return Effect.succeed(null);
            if (response.status < 200 || response.status >= 300) return failureOf(response);
            return response.json.pipe(
              Effect.mapError(
                () =>
                  new DriveApiError({
                    status: 0,
                    code: "invalid_response",
                    detail: "Drive sent unreadable sharing.",
                  }),
              ),
              Effect.flatMap((body) => parseWith(sharingResponseSchema, body, "sharing")),
              Effect.map((body) => body.data),
            );
          }),
        ),
      deviceCode,
      deviceToken,
      suiteSession: (token: string) =>
        json(
          HttpClientRequest.post(url("/api/auth/suite-session")).pipe(
            HttpClientRequest.bodyJsonUnsafe({}),
          ),
          { token },
          effectParser(Schema.Struct({ token: Schema.String })),
          "suite session",
        ).pipe(Effect.map((body) => body.token)),
      me: (options: DriveRequestOptions) =>
        json(HttpClientRequest.get(url("/api/v1/me")), options, meResponseSchema, "account").pipe(
          Effect.map((body) => body.data),
        ),
      listFolders: (options: DriveRequestOptions): Effect.Effect<Folder[], DriveApiError> =>
        json(
          HttpClientRequest.get(url("/api/v1/folders")),
          options,
          folderListResponseSchema,
          "folder list",
        ).pipe(Effect.map((body) => body.data)),
      /** The folder's documents (in `options.folderId`, else your personal drive), newest first. */
      listArtifacts: (
        options: DriveRequestOptions,
        limit = 50,
      ): Effect.Effect<Artifact[], DriveApiError> =>
        json(
          HttpClientRequest.get(url("/api/v1/artifacts", { limit })),
          options,
          artifactListResponseSchema,
          "document list",
        ).pipe(Effect.map((body) => body.data)),
      sharedWithMe: (options: DriveRequestOptions): Effect.Effect<SharedItem[], DriveApiError> =>
        json(
          HttpClientRequest.get(url("/api/v1/shared")),
          options,
          sharedWithMeResponseSchema,
          "shared list",
        ).pipe(Effect.map((body) => body.data)),
      /** By id anywhere you have access, or by slug within `options.folderId`. */
      getArtifact: (
        reference: string,
        options: DriveRequestOptions,
      ): Effect.Effect<Artifact, DriveApiError> =>
        json(
          HttpClientRequest.get(url(`/api/v1/artifacts/${ref(reference)}`)),
          options,
          artifactResponseSchema,
          "document",
        ).pipe(Effect.map((body) => body.data)),
      listVersions: (
        reference: string,
        options: DriveRequestOptions,
      ): Effect.Effect<ArtifactVersion[], DriveApiError> =>
        json(
          HttpClientRequest.get(url(`/api/v1/artifacts/${ref(reference)}/versions`)),
          options,
          artifactVersionsResponseSchema,
          "version list",
        ).pipe(Effect.map((body) => body.data)),
      /** The entry file of a version (or `path`), as text, cut at `maxBytes`. */
      readContent: (
        reference: string,
        options: DriveRequestOptions & {
          readonly version?: number | undefined;
          readonly maxBytes: number;
        },
      ) =>
        send(
          authorized(
            HttpClientRequest.get(
              url(`/api/v1/artifacts/${ref(reference)}/content`, { version: options.version }),
            ),
            options,
          ).pipe(HttpClientRequest.setHeader("accept", "*/*")),
        ).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.arrayBuffer.pipe(
                  Effect.mapError(
                    () =>
                      new DriveApiError({
                        status: 200,
                        code: "invalid_response",
                        detail: "Otter Drive's document content could not be read.",
                      }),
                  ),
                  Effect.map((buffer) => {
                    const truncated = buffer.byteLength > options.maxBytes;
                    const bytes = new Uint8Array(
                      buffer,
                      0,
                      Math.min(buffer.byteLength, options.maxBytes),
                    );
                    return {
                      text: new TextDecoder().decode(bytes),
                      truncated,
                      contentType: response.headers["content-type"] ?? "",
                    };
                  }),
                )
              : failureOf(response),
          ),
        ),
      /** Opens an "anyone with the link" share: gives you its access, then names the target. */
      acceptLink: (
        token: string,
        options: DriveRequestOptions,
      ): Effect.Effect<AcceptLinkResponse["data"], DriveApiError> =>
        json(
          HttpClientRequest.post(url(`/api/v1/links/${ref(token)}`)),
          options,
          acceptLinkResponseSchema,
          "share link",
        ).pipe(Effect.map((body) => body.data)),
      /**
       * Creates a document with version 1 from one text file: metadata, an
       * upload session, the file, then completion. A failed upload removes
       * the draft, like Drive's CLI.
       */
      createTextDocument: (
        input: CreateArtifactInput & { readonly content: string; readonly contentType: string },
        options: DriveRequestOptions,
      ): Effect.Effect<CompleteUploadResponse["data"], DriveApiError> =>
        Effect.gen(function* () {
          const created = yield* json(
            HttpClientRequest.post(url("/api/v1/artifacts")).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                slug: input.slug,
                title: input.title,
                description: input.description,
                entryPath: input.entryPath,
                label: input.label,
              }),
            ),
            options,
            artifactResponseSchema,
            "document",
          );
          return yield* publishFile(created.data.id, input, options, 0).pipe(
            Effect.tapError(() =>
              send(
                authorized(
                  HttpClientRequest.delete(url(`/api/v1/artifacts/${ref(created.data.id)}/draft`)),
                  options,
                ),
              ).pipe(Effect.ignore),
            ),
          );
        }),
      /** Publishes `content` as a new immutable version; fails with 409 unless `ifVersion` is current. */
      publishTextVersion: (
        artifactId: string,
        input: {
          readonly entryPath: string;
          readonly label: string;
          readonly content: string;
          readonly contentType: string;
        },
        ifVersion: number,
        options: DriveRequestOptions,
      ) => publishFile(artifactId, input, options, ifVersion),
    };

    function publishFile(
      artifactId: string,
      input: {
        readonly entryPath: string;
        readonly label: string;
        readonly content: string;
        readonly contentType: string;
      },
      options: DriveRequestOptions,
      expectedCurrentVersion: number,
    ) {
      return Effect.gen(function* () {
        const bytes = new TextEncoder().encode(input.content);
        const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
        const session = yield* json(
          HttpClientRequest.post(url(`/api/v1/artifacts/${ref(artifactId)}/uploads`)).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              label: input.label,
              entryPath: input.entryPath,
              expectedCurrentVersion,
              files: [
                {
                  path: input.entryPath,
                  contentType: input.contentType,
                  size: bytes.byteLength,
                  sha256,
                },
              ],
            }),
          ),
          options,
          uploadSessionResponseSchema,
          "upload session",
        );
        for (const file of session.data.files) {
          const response = yield* send(
            authorized(
              HttpClientRequest.put(new URL(file.uploadUrl, origin).toString()).pipe(
                HttpClientRequest.setHeaders({
                  "content-type": input.contentType,
                  "x-content-sha256": sha256,
                }),
                HttpClientRequest.bodyUint8Array(bytes, input.contentType),
              ),
              options,
            ),
          );
          if (response.status < 200 || response.status >= 300) return yield* failureOf(response);
        }
        const completed = yield* json(
          HttpClientRequest.post(url(`/api/v1/uploads/${ref(session.data.id)}/complete`)),
          options,
          completeUploadResponseSchema,
          "published version",
        );
        return completed.data;
      });
    }
  });

export type DriveApi = Effect.Success<ReturnType<typeof makeDriveApi>>;
