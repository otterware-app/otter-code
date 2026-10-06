// @effect-diagnostics nodeBuiltinImport:off -- Runs in Mail's worker thread, outside any Effect runtime.
/**
 * Mail's secrets at rest (Google tokens, IMAP passwords, its relay session),
 * where Mail's desktop app uses Electron's safeStorage: AES-256-GCM under a
 * key the server keeps in its own secret store (`otterware-mail-seal`), so
 * the files in `<stateDir>/mail` are useless without the server's secrets.
 */
import * as NodeCrypto from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** `text` encrypted with `key`, as `v1:<base64 iv|tag|ciphertext>`. */
export function sealText(key: Uint8Array, text: string): string {
  const iv = NodeCrypto.randomBytes(IV_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

/** The text `sealText` sealed; throws when it was sealed with another key or tampered with. */
export function unsealText(key: Uint8Array, sealed: string): string {
  const [version, payload] = sealed.split(":", 2);
  if (version !== VERSION || payload === undefined)
    throw new Error("Unknown sealed secret format.");
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("Sealed secret is truncated.");
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
  decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}
