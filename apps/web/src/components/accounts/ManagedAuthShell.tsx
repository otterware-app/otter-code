import type { ReactNode } from "react";
import { AccountProvider } from "../../accounts/AccountProvider";
import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";

export default function ManagedAuthShell({ children }: { readonly children: ReactNode }) {
  return (
    <AccountProvider>
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </AccountProvider>
  );
}
