import { Schema } from "effect";
const key = "otter-account-authorization-v1";
const Pending = Schema.Struct({
  state: Schema.String,
  verifier: Schema.String,
  expiresAt: Schema.Number,
  returnTo: Schema.String,
});
const decodePending = Schema.decodeUnknownSync(Schema.fromJsonString(Pending));
export function saveBrowserAuthorization(storage: Storage, request: typeof Pending.Type) {
  storage.setItem(key, JSON.stringify(request));
}
export function consumeBrowserAuthorization(storage: Storage, state: string, now: number) {
  const saved = storage.getItem(key);
  if (!saved) return null;
  const request = decodePending(saved);
  if (request.state !== state)
    throw new Error("This sign-in request has expired. Start again in Otter Code.");
  storage.removeItem(key);
  if (
    request.expiresAt <= now ||
    !request.returnTo.startsWith("/") ||
    request.returnTo.startsWith("//")
  )
    throw new Error("This sign-in request has expired. Start again in Otter Code.");
  return request;
}
