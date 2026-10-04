import type { DesktopPreviewExtension } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, Puzzle, Search } from "lucide-react";
import { useState } from "react";

import { openUrlInPreview } from "~/browser/openFileInPreview";
import {
  CHROME_WEB_STORE_URL,
  previewExtensions,
  useInstalledPreviewExtensions,
  usePreviewExtensionsUi,
} from "~/browser/previewExtensions";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { lastMainAppThreadRef } from "../sidebar/mainAppLocation";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const failed = (title: string) => (error: unknown) => {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
};

/**
 * A page in a browser tab beside the thread last open, as the toolbar opens
 * them; with no thread yet, in a window of its own.
 */
function useOpenBesideLastThread() {
  const navigate = useNavigate();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return async (url: string) => {
    const threadRef = lastMainAppThreadRef();
    if (!threadRef) {
      await previewExtensions?.openWebStore();
      return;
    }
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    await openUrlInPreview({ threadRef, url, openPreview });
  };
}

function ExtensionCard({
  extension,
  onRemove,
  onOpen,
}: {
  extension: DesktopPreviewExtension;
  onRemove: () => void;
  onOpen: (url: string) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const pinned = usePreviewExtensionsUi((state) => state.pinned.includes(extension.id));
  const setPinned = usePreviewExtensionsUi((state) => state.setPinned);
  const bridge = previewExtensions!;

  return (
    <div className="rounded-xl border border-border/70 p-4">
      <div className="flex gap-4">
        {extension.icon ? (
          <img src={extension.icon} alt="" className="mt-0.5 size-10 shrink-0" />
        ) : (
          <Puzzle className="mt-0.5 size-10 shrink-0 p-1.5 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {extension.name}
            <span className="ml-2 font-normal text-muted-foreground">{extension.version}</span>
          </p>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{extension.description}</p>
        </div>
      </div>
      {showDetails ? (
        <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 border-t border-border/70 pt-4 text-xs">
          <dt className="text-muted-foreground">Site access</dt>
          <dd className="text-foreground">{extension.siteAccess}</dd>
          {extension.permissions.length > 0 ? (
            <>
              <dt className="text-muted-foreground">Permissions</dt>
              <dd className="text-foreground">{extension.permissions.join(", ")}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">ID</dt>
          <dd className="select-text font-mono text-foreground">{extension.id}</dd>
          <dt className="text-muted-foreground">Pin to toolbar</dt>
          <dd>
            <Switch
              aria-label={`Pin ${extension.name} to the toolbar`}
              checked={pinned}
              disabled={!extension.enabled}
              onCheckedChange={(on) => setPinned(extension.id, on)}
            />
          </dd>
          <dd className="col-span-2 flex flex-wrap gap-2 pt-1">
            {extension.hasOptions ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void bridge.openOptions(extension.id).catch(failed("Couldn't open its options"))
                }
              >
                Extension options
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              onClick={() => onOpen(`https://chromewebstore.google.com/detail/${extension.id}`)}
            >
              View in Chrome Web Store
            </Button>
          </dd>
        </dl>
      ) : null}
      <div className="mt-4 flex items-center gap-2">
        <Button
          size="xs"
          variant={showDetails ? "secondary" : "outline"}
          aria-expanded={showDetails}
          onClick={() => setShowDetails((shown) => !shown)}
        >
          Details
        </Button>
        <Button size="xs" variant="outline" onClick={onRemove}>
          Remove
        </Button>
        <span className="flex-1" />
        <Switch
          aria-label={`${extension.name} on`}
          checked={extension.enabled}
          onCheckedChange={(enabled) =>
            void bridge
              .setEnabled(extension.id, enabled)
              .catch(failed(`Couldn't turn ${extension.name} ${enabled ? "on" : "off"}`))
          }
        />
      </div>
    </div>
  );
}

/**
 * Settings › Browser Extensions (desktop): Chrome's extensions page, as in
 * Otter Mail. Each extension's card turns it on or off, shows its details, or
 * removes it; developer mode loads one from a folder.
 */
export function ExtensionsSettingsPanel() {
  const extensions = useInstalledPreviewExtensions();
  const developerMode = usePreviewExtensionsUi((state) => state.developerMode);
  const setDeveloperMode = usePreviewExtensionsUi((state) => state.setDeveloperMode);
  const extensionsButton = usePreviewExtensionsUi((state) => state.extensionsButton);
  const setExtensionsButton = usePreviewExtensionsUi((state) => state.setExtensionsButton);
  const setPinned = usePreviewExtensionsUi((state) => state.setPinned);
  const openBesideLastThread = useOpenBesideLastThread();
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<DesktopPreviewExtension | null>(null);

  if (!previewExtensions) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Browser extensions run in the desktop app's browser.
        </p>
      </SettingsPageContainer>
    );
  }
  const bridge = previewExtensions;
  const open = (url: string) =>
    void openBesideLastThread(url).catch(failed("Couldn't open the Chrome Web Store"));

  const all = extensions ?? [];
  const words = query.trim().toLowerCase();
  const shown = words
    ? all.filter((each) => `${each.name} ${each.description}`.toLowerCase().includes(words))
    : all;

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("browser-extensions").id}
        title="Extensions"
        variant="plain"
        headerAction={
          <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
            Developer mode
            <Switch checked={developerMode} onCheckedChange={setDeveloperMode} />
          </label>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-foreground/[0.05] px-3.5 focus-within:bg-foreground/[0.08]">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search extensions"
                aria-label="Search extensions"
                className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            {developerMode ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void bridge.loadUnpacked().then((loaded) => {
                    if (loaded)
                      toastManager.add({ type: "success", title: `Loaded ${loaded.name}` });
                  }, failed("Couldn't load the extension"))
                }
              >
                Load unpacked
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => open(CHROME_WEB_STORE_URL)}>
              Chrome Web Store
              <ArrowUpRight />
            </Button>
          </div>

          <h3 className="px-1 pt-2 text-sm font-medium text-foreground">All extensions</h3>
          {shown.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border/70 px-6 py-10 text-center">
              <Puzzle className="size-6 text-muted-foreground" />
              <p className="text-sm text-foreground">
                {extensions === null
                  ? "Loading…"
                  : words
                    ? "No extensions match."
                    : "No extensions yet"}
              </p>
              {!words && extensions !== null ? (
                <p className="max-w-80 text-xs text-muted-foreground">
                  Find one in the Chrome Web Store and choose Add to Otter Code.
                </p>
              ) : null}
            </div>
          ) : (
            shown.map((extension) => (
              <ExtensionCard
                key={extension.id}
                extension={extension}
                onRemove={() => setRemoving(extension)}
                onOpen={open}
              />
            ))
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Toolbar">
        <SettingsRow
          title="Extensions button"
          description="The puzzle in the browser's toolbar, listing every extension to run or pin."
          control={
            <Switch
              aria-label="Show the Extensions button"
              checked={extensionsButton}
              onCheckedChange={setExtensionsButton}
            />
          }
        />
      </SettingsSection>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name ?? "this extension"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its settings go with it. You can add it again from the Chrome Web Store.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const extension = removing;
                if (!extension) return;
                void bridge.remove(extension.id).then(
                  () => {
                    setPinned(extension.id, false);
                    setRemoving(null);
                  },
                  failed(`Couldn't remove ${extension.name}`),
                );
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
