import type { CloudAccountSource } from "./cloudAccountService.ts";

type Listener = Parameters<CloudAccountSource["addListener"]>[0];

/** Feeds the Otter account session from React into the cloud account service. */
export interface OtterAccountSource extends CloudAccountSource {
  readonly getToken: () => Promise<string | null>;
  /** `accountId` is undefined while the session is still loading. */
  readonly update: (input: {
    readonly accountId: string | null | undefined;
    readonly getToken: () => Promise<string | null>;
  }) => void;
}

export function createOtterAccountSource(): OtterAccountSource {
  const listeners = new Set<Listener>();
  let accountId: string | null | undefined;
  let readToken: () => Promise<string | null> = async () => null;
  const resources = () => ({
    user: accountId === undefined ? undefined : accountId === null ? null : { id: accountId },
  });
  return {
    addListener(listener) {
      listeners.add(listener);
      listener(resources());
      return () => listeners.delete(listener);
    },
    getToken: () => readToken(),
    update(input) {
      readToken = input.getToken;
      if (input.accountId === accountId) return;
      accountId = input.accountId;
      for (const listener of [...listeners]) listener(resources());
    },
  };
}
