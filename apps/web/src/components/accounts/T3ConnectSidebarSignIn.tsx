import { LogInIcon, UserRoundIcon } from "lucide-react";
import { useAuth } from "../../accounts/AccountProvider";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Button } from "../ui/button";
import { useT3ConnectAccountPage } from "./T3ConnectAccountPages";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

export function T3ConnectSidebarAvatar() {
  const { isLoaded, isSignedIn, user } = useAuth();
  const account = useT3ConnectAccountPage();
  if (!hasCloudPublicConfig() || !isLoaded || !isSignedIn) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Otter account: ${user?.email ?? "account"}`}
        onClick={account.open ?? undefined}
      >
        <UserRoundIcon />
      </Button>
      {account.portals}
    </>
  );
}
export function T3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useT3ConnectAuthPrompt();
  if (!hasCloudPublicConfig() || !isLoaded || isSignedIn) return null;
  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in with Otter</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
