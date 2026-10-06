import { useState } from "react";
import { OTTER_ACCOUNTS_URL } from "@t3tools/shared/otterAccounts";
import { useAuth } from "../../accounts/AccountProvider";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";

export function AccountDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { user, signOut, error } = useAuth();
  const [page, setPage] = useState<"environments" | "devices">("environments");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Otter Code account</DialogTitle>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
            <div className="min-w-0">
              <p className="wrap-anywhere text-sm font-medium">{user?.name ?? "Otter account"}</p>
              <p className="wrap-anywhere text-xs text-muted-foreground">{user?.email}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const url = `${new URL(OTTER_ACCOUNTS_URL).origin}/otter/account`;
                  if (window.desktopBridge) void window.desktopBridge.openExternal(url);
                  else window.open(url, "_blank", "noopener");
                }}
              >
                Manage account
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void signOut();
                  onOpenChange(false);
                }}
              >
                Sign out
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={page === "environments" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setPage("environments")}
            >
              Otter Connect
            </Button>
            <Button
              variant={page === "devices" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setPage("devices")}
            >
              Mobile clients
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {page === "environments" ? (
            <T3ConnectUserProfilePage />
          ) : (
            <MobileClientsUserProfilePage />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
