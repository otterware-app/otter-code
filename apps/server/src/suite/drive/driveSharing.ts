import type { Sharing } from "@otterware/drive-contracts";
import type { DriveApi } from "./DriveApi.ts";
import { DriveApiError } from "./DriveApi.ts";
import * as Effect from "effect/Effect";

export interface DriveShareInput {
  readonly linkRole?: "none" | "viewer" | "editor" | undefined;
  readonly grant?:
    | ReadonlyArray<{ readonly email: string; readonly role: "viewer" | "editor" }>
    | undefined;
  readonly revoke?: ReadonlyArray<string> | undefined;
}

export const sharingResult = (sharing: Sharing) => ({
  resourceId: sharing.resource.id,
  url: sharing.link?.url ?? null,
  linkRole: sharing.link?.role ?? null,
  people: sharing.people.map((person) => ({
    email: person.email,
    role: person.role,
    inheritedFrom: person.inheritedFrom?.name ?? null,
    viaLink: person.viaLink,
  })),
});

/** Inspect before writing, resolve email revocations to access IDs, and never retry a partial mutation. */
export const changeSharing = (
  api: DriveApi,
  kind: "artifacts" | "folders",
  id: string,
  input: DriveShareInput,
  token: string,
) =>
  Effect.gen(function* () {
    const options = { token };
    const invalid = (detail: string) =>
      new DriveApiError({ status: 400, code: "invalid_sharing", detail });
    if (input.linkRole === undefined && !input.grant?.length && !input.revoke?.length)
      return yield* invalid(
        "Provide linkRole, grant, or revoke; use drive_get_share_link to inspect sharing.",
      );
    const grants = input.grant ?? [];
    const revokes = input.revoke ?? [];
    const emails = [...grants.map((item) => item.email), ...revokes].map((email) =>
      email.trim().toLowerCase(),
    );
    if (
      emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) ||
      new Set(emails).size !== emails.length
    )
      return yield* invalid(
        "Use valid, unique email addresses; do not grant and revoke the same person in one call.",
      );
    let current = yield* api.getSharing(kind, id, options);
    if (!current.canShare)
      return yield* new DriveApiError({
        status: 403,
        code: "forbidden",
        detail:
          "This login cannot change sharing here. Sharing requires a user login and sufficient access.",
      });
    if (
      input.linkRole !== undefined &&
      current.resource.folderKind !== null &&
      current.resource.folderKind !== "folder"
    )
      return yield* invalid(
        "Drive roots cannot have share links. Share a folder or document; shared-drive access is managed by membership.",
      );
    const entries = [];
    for (const email of revokes) {
      const normalized = email.trim().toLowerCase();
      const entry = current.people.find(
        (person) =>
          person.email.toLowerCase() === normalized &&
          person.inheritedFrom === null &&
          !person.viaLink,
      );
      if (!entry)
        return yield* invalid(
          `${email} has no direct email grant here. Inherited access must be removed at its folder or drive; link access requires disabling its link.`,
        );
      entries.push(entry.id);
    }
    // Each API operation commits separately. Tell the caller to inspect on failure, not retry.
    const mutate = <A>(operation: Effect.Effect<A, DriveApiError>) =>
      operation.pipe(
        Effect.mapError(
          (error) =>
            new DriveApiError({
              status: error.status,
              code: error.code,
              detail: `${error.detail} Sharing operations are not atomic; re-read access before making another change.`,
            }),
        ),
      );
    for (const role of ["viewer", "editor"] as const) {
      const group = grants
        .filter((item) => item.role === role)
        .map((item) => item.email.trim().toLowerCase());
      if (group.length) current = yield* mutate(api.grantAccess(kind, id, group, role, options));
    }
    for (const entryId of entries) {
      const result = yield* mutate(api.revokeAccess(kind, id, entryId, options));
      current = result ?? {
        ...current,
        people: current.people.filter((person) => person.id !== entryId),
      };
    }
    if (input.linkRole !== undefined)
      current = yield* mutate(api.setShareLink(kind, id, input.linkRole, options));
    return sharingResult(current);
  });
export type DriveSharingResult = ReturnType<typeof sharingResult>;
