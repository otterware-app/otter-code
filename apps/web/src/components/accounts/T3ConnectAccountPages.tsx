import { useState } from "react";
import { useAuth } from "../../accounts/AccountProvider";
import { AccountDialog } from "./AccountDialog";

export function useT3ConnectAccountPage() {
  const { isSignedIn } = useAuth();
  const [opened, setOpened] = useState(false);
  return {
    open: isSignedIn ? () => setOpened(true) : null,
    portals: <AccountDialog open={opened && isSignedIn} onOpenChange={setOpened} />,
  };
}
