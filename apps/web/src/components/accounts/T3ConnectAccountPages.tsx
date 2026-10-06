import { useState } from "react";
import { useAuth } from "../../accounts/AccountProvider";
import { AccountDialog } from "./AccountDialog";

/** Upstream's account pages; the T3 Chat link lives with tunnel usage on the environments page. */
export type T3ConnectAccountPageUrl = "t3-connect" | "t3-chat";

export function useT3ConnectAccountPage() {
  const { isSignedIn } = useAuth();
  const [opened, setOpened] = useState(false);
  const open: ((page?: T3ConnectAccountPageUrl) => void) | null = isSignedIn
    ? () => setOpened(true)
    : null;
  return {
    open,
    portals: <AccountDialog open={opened && isSignedIn} onOpenChange={setOpened} />,
  };
}
