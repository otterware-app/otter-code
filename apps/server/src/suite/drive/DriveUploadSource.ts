// @effect-diagnostics nodeBuiltinImport:off -- File transfers run on the server's machine.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { DriveApiError } from "./DriveApi.ts";

export interface DriveUploadInput {
  readonly path?: string | undefined;
  readonly url?: string | undefined;
  readonly contentBase64?: string | undefined;
  /** File name, including extension; also used as the document title. */
  readonly name: string;
  readonly folder?: string | undefined;
  readonly documentRef?: string | undefined;
  readonly ifVersion?: number | undefined;
  readonly publish?: boolean | undefined;
}

const isDriveApiError = Schema.is(DriveApiError);

export const uploadInputError = (detail: string) =>
  new DriveApiError({ status: 400, code: "invalid_upload", detail });

/** Validates before doing any network or Drive writes. Drive currently only finalizes published versions. */
export function validateUploadInput(input: DriveUploadInput) {
  if (
    [input.path, input.url, input.contentBase64].filter((value) => value !== undefined).length !== 1
  )
    throw uploadInputError("Provide exactly one of path, url, or contentBase64.");
  if (
    !input.name.trim() ||
    /[/\\]/u.test(input.name) ||
    [...input.name].some((character) => character.charCodeAt(0) < 32) ||
    input.name.includes("..")
  )
    throw uploadInputError("name must be a single file name, including its extension.");
  if (input.publish === false)
    throw uploadInputError(
      "This Drive API only supports published file versions; publish=false is unavailable. Nothing was uploaded.",
    );
  if (
    input.documentRef !== undefined &&
    (!Number.isSafeInteger(input.ifVersion) || input.ifVersion! < 0)
  )
    throw uploadInputError(
      "A new version requires the ifVersion you inspected with drive_get_document.",
    );
  if (input.documentRef === undefined && input.ifVersion !== undefined)
    throw uploadInputError("ifVersion is only valid with documentRef.");
  if (input.path !== undefined && !NodePath.isAbsolute(input.path))
    throw uploadInputError("path must be absolute on the machine running this server.");
  if (
    input.url !== undefined &&
    (!URL.canParse(input.url) || !["http:", "https:"].includes(new URL(input.url).protocol))
  )
    throw uploadInputError("url must use http or https.");
  if (
    input.contentBase64 !== undefined &&
    (input.contentBase64.length > 1_398_104 ||
      Buffer.byteLength(input.contentBase64, "base64") > 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        input.contentBase64,
      ))
  )
    throw uploadInputError(
      "contentBase64 must be valid padded base64 for a file of at most 1 MiB; use path or url for larger files.",
    );
}

export const contentTypeForName = (name: string) => {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const types: Readonly<Record<string, string>> = {
    mov: "video/quicktime",
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip",
  };
  return types[extension] ?? "application/octet-stream";
};

/** URL/base64 inputs spool to disk; local files are hashed and streamed from one open handle. */
export const prepareUploadSource = (input: DriveUploadInput) =>
  Effect.gen(function* () {
    const download = yield* FetchHttpClient.Fetch;
    return yield* Effect.tryPromise({
      try: async (signal) => {
        validateUploadInput(input);
        let directory: string | undefined;
        let handle: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
        try {
          let path = input.path;
          if (path === undefined) {
            directory = await NodeFSP.mkdtemp(
              NodePath.join(NodeOS.tmpdir(), "otterware-drive-upload-"),
            );
            path = NodePath.join(directory, "file");
            if (input.url !== undefined) {
              // No Drive bearer token is ever forwarded to the download URL.
              const response = await download(input.url, { signal, redirect: "follow" });
              if (!response.ok || !response.body)
                throw uploadInputError("Could not download the file from url.");
              await NodeStreamPromises.pipeline(
                NodeStream.Readable.fromWeb(response.body),
                NodeFS.createWriteStream(path, { mode: 0o600 }),
                { signal },
              );
            } else {
              await NodeFSP.writeFile(path, Buffer.from(input.contentBase64!, "base64"), {
                mode: 0o600,
                signal,
              });
            }
          }
          handle = await NodeFSP.open(path, "r");
          const stat = await handle.stat();
          if (!stat.isFile() || !Number.isSafeInteger(stat.size))
            throw uploadInputError("path must name a regular file.");
          const hash = NodeCrypto.createHash("sha256");
          for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
            signal.throwIfAborted();
            hash.update(chunk);
          }
          const file = handle;
          const temporary = directory;
          return {
            size: stat.size,
            sha256: hash.digest("hex"),
            contentType: contentTypeForName(input.name),
            stream: (start = 0, end?: number) =>
              Stream.fromAsyncIterable(
                file.createReadStream({
                  autoClose: false,
                  start,
                  ...(end === undefined ? {} : { end }),
                }),
                () => uploadInputError("The upload source could not be read."),
              ),
            close: async () => {
              await file.close();
              if (temporary) await NodeFSP.rm(temporary, { recursive: true, force: true });
            },
          };
        } catch (error) {
          await handle?.close();
          if (directory) await NodeFSP.rm(directory, { recursive: true, force: true });
          throw error;
        }
      },
      catch: (error) =>
        isDriveApiError(error)
          ? error
          : uploadInputError(
              "The upload source could not be read on this server; check its path and permissions.",
            ),
    });
  });
export type DriveUploadSource = Effect.Success<ReturnType<typeof prepareUploadSource>>;
