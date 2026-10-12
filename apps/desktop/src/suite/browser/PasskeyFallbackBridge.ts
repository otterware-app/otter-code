/** Self-contained: also executed in extension pages' main world by contextBridge. */
export function installPasskeyFallbackBridge(notify: (rpId: unknown) => void) {
  if (typeof CredentialsContainer === "undefined" || typeof PublicKeyCredential === "undefined")
    return;
  const prototype = CredentialsContainer.prototype;
  for (const method of ["get", "create"] as const) {
    const original = prototype[method];
    Object.defineProperty(prototype, method, {
      configurable: true,
      writable: true,
      value: async function (
        this: CredentialsContainer,
        options?: CredentialRequestOptions & CredentialCreationOptions,
      ) {
        try {
          return await original.call(this, options);
        } catch (error) {
          // Autofill may fail or be cancelled without any deliberate user action.
          if (
            options?.publicKey &&
            options.mediation !== "conditional" &&
            !options.signal?.aborted &&
            error instanceof DOMException &&
            ["NotAllowedError", "NotSupportedError", "SecurityError"].includes(error.name)
          ) {
            const key = options.publicKey;
            const rpId = "rpId" in key ? key.rpId : "rp" in key ? key.rp.id : undefined;
            notify(rpId);
          }
          throw error;
        }
      },
    });
  }
}
