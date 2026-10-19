import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ReviewDiffPreviewSourceRequest, ScopedThreadRef } from "@t3tools/contracts";
import {
  FlaskConicalOffIcon,
  FileTextIcon,
  FolderTreeIcon,
  GitCompareArrowsIcon,
  PilcrowIcon,
} from "lucide-react";
import { ChevronDownIcon, ChevronUpIcon, Columns2Icon, Rows3Icon, TextWrapIcon } from "~/lib/icons";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from "lucide";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { useFileContextMenuHandler } from "../fileContextMenu";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { toolCallDiff } from "../lib/toolCallDiff";
import { useCheckpointDiff, useTurnItemDetail } from "~/state/queries";
import { revisionedQuery } from "~/state/revisionedQuery";
import { cn } from "~/lib/utils";
import {
  resolveToolCallDiffTarget,
  selectThreadBranchBaseRef,
  selectThreadDiffPanelSelection,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "../diffPanelStore";
import { useRightPanelStore } from "../rightPanelStore";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { useHideTestFiles } from "./diffs/useHideTestFiles";
import { useRenderedAppearance } from "../hooks/useTheme";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { useStableCallback } from "../hooks/useStableCallback";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import { LIVE_REFRESH_MIN_INTERVAL_MS, useLiveRefresh } from "../hooks/useLiveRefresh";
import {
  useProject,
  useThreadCheckpointSummaries,
  useQuietThreadShell,
  useQuietThreadVisibleTurnItems,
} from "../state/entities";
import { useClientSettings, updateClientSettings } from "../hooks/useSettings";
import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { AnnotatableCodeView } from "./diffs/AnnotatableCodeView";
import { DiffChangesTree, type DiffChangesTreeFile } from "./diffs/DiffChangesTree";
import { DiffCodeIntelligence } from "./diffs/DiffCodeIntelligence";
import { orderDiffChangesTreeFiles } from "./diffs/diffChangesTree.logic";
import { DiffScopeMenu, type DiffScopeChoice, type DiffScopeMenuTurn } from "./diffs/DiffScopeMenu";
import { DiffTargetBranchPicker } from "./diffs/DiffTargetBranchPicker";
import { RightPanelResizeHandle } from "./preview/RightPanelResizeHandle";
import { diffViewedStat, isDiffFileViewed, type DiffViewedMark } from "./diffs/diffViewed.logic";
import { Button } from "./ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Checkbox } from "./ui/checkbox";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";
import { createGitDiffFileContentsLoader } from "../lib/diffFileContents";
import { useReviewFilePatches } from "./diffs/useReviewFilePatches";
import { DiffFileLoadingBoundary } from "./diffs/DiffFileLoadingBoundary";
import { DiffFileStatus } from "./diffs/DiffFileStatus";
import { useThreadRouteRef } from "../hooks/useThreadRouteTarget";
type DiffThemeType = "light" | "dark";
const DIFF_EXPAND_UNCHANGED_STORAGE_KEY = "t3code.diffExpandUnchanged";
const DIFF_FILE_TREE_STORAGE_KEY = "t3code.diffFileTreeOpen";
const DIFF_FILE_TREE_WIDTH_STORAGE_KEY = "t3code.diffFileTreeWidth";
const fileEntryCache = new WeakMap<
  FileDiffMetadata,
  {
    fileDiff: FileDiffMetadata;
    fileKey: string;
    fileVersion: number;
  }
>();
function getCachedFileEntry(fileDiff: FileDiffMetadata) {
  const cached = fileEntryCache.get(fileDiff);
  if (cached) return cached;
  const entry = {
    fileDiff,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion: buildFileDiffContentVersion(fileDiff),
  };
  fileEntryCache.set(fileDiff, entry);
  return entry;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();
function DiffFileCollapseToggle({
  filePath,
  fileKey,
  collapsed,
  unavailable,
  onToggle,
}: {
  filePath: string;
  fileKey: string;
  collapsed: boolean;
  unavailable: boolean;
  onToggle: (fileKey: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            className="-ms-0.5"
            aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
            aria-expanded={!collapsed}
            disabled={unavailable}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(fileKey);
            }}
          />
        }
      >
        <MorphIcon
          className="size-4 text-muted-foreground/80"
          icon={collapsed ? ChevronRight : ChevronDown}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{collapsed ? "Expand diff" : "Collapse diff"}</TooltipPopup>
    </Tooltip>
  );
}
function DiffFileHeaderSuffix({
  filePath,
  hasStat,
  error,
  truncated,
  onRetry,
}: {
  filePath: string;
  hasStat: boolean;
  error: boolean;
  truncated: boolean;
  onRetry: (path: string) => void;
}) {
  return (
    <>
      <span data-diff-copy-path className="inline-flex">
        <DiffFilePathCopyButton filePath={filePath} />
      </span>
      {hasStat ? (
        <DiffFileStatus error={error} truncated={truncated} retry={() => onRetry(filePath)} />
      ) : null}
    </>
  );
}
interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
  visible: boolean;
}
function ToolCallContentPreview({
  content,
  wordWrap,
}: {
  content: ReturnType<typeof toolCallDiff>["content"];
  wordWrap: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-xs">
      <p className="text-muted-foreground">The provider recorded file content without a diff.</p>
      {content.map(({ label, text }) => (
        <div key={label} className="space-y-1">
          <p className="text-muted-foreground">{label}</p>
          <pre
            className={cn(
              "overflow-auto font-mono text-2xs",
              wordWrap && "whitespace-pre-wrap wrap-break-word",
            )}
          >
            {text === "" ? "Empty content." : text}
          </pre>
        </div>
      ))}
    </div>
  );
}

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  workspaceMutationId,
  visible,
}: DiffPanelProps) {
  const resolvedTheme = useRenderedAppearance();
  const settings = useClientSettings((settings) => ({
    diffFilesCollapsed: settings.diffFilesCollapsed,
    diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
    diffLayout: settings.diffLayout,
    timestampFormat: settings.timestampFormat,
    wordWrap: settings.wordWrap,
  }));
  const diffLayout = settings.diffLayout;
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  // With the tree open the panel shows one file at a time; hidden, every file in one stream.
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    DIFF_FILE_TREE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const { width: fileTreeWidth, handlers: fileTreeResizeHandlers } = useResizableWidth({
    storageKey: DIFF_FILE_TREE_WIDTH_STORAGE_KEY,
    defaultWidth: 256,
    minWidth: 160,
    maxWidth: 480,
    edge: "left",
  });
  const [expandUnchanged, setExpandUnchanged] = useLocalStorage(
    DIFF_EXPAND_UNCHANGED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [hideTestFiles, setHideTestFiles] = useHideTestFiles();
  const [codeViewRevision, setCodeViewRevision] = useState(0);

  const routeThreadRef = useThreadRouteRef();
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useQuietThreadShell(routeThreadRef);
  const fileAccess = useFilesystemReadAccess(activeThread?.environmentId ?? null);
  const { canReadFiles } = fileAccess;
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useProject(
    activeThread && activeProjectId
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        }
      : null,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  const activeRepositoryRoot = activeThread?.worktreePath
    ? undefined
    : activeProject?.repositoryIdentity?.rootPath;
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
  );
  const onFileContextMenu = useFileContextMenuHandler(activeThread?.environmentId ?? null);
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeThread?.environmentId ?? null,
    serverConfig?.availableEditors ?? [],
  );
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const gitStatusQuery = useEnvironmentQuery(
    activeThread !== null && activeThread !== undefined && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(state.byThreadKey, routeThreadRef),
  );
  const rememberedBaseRef = useDiffPanelStore((state) =>
    selectThreadBranchBaseRef(state, routeThreadRef),
  );
  const toolCallSelection = diffSelection.kind === "tool-call" ? diffSelection : null;
  const isGitSelection =
    diffSelection.kind === "branch" ||
    diffSelection.kind === "unstaged" ||
    diffSelection.kind === "commit";
  const toolCallItems = useQuietThreadVisibleTurnItems(toolCallSelection ? routeThreadRef : null);
  const toolCallDetail = useTurnItemDetail(
    toolCallSelection && routeThreadRef
      ? {
          ...resolveToolCallDiffTarget(toolCallSelection, toolCallItems),
          environmentId: routeThreadRef.environmentId,
        }
      : null,
  );
  const toolCallItem = toolCallDetail.data?.item;
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const turnDiffSummaries = useThreadCheckpointSummaries(routeThreadRef);
  const orderedTurnDiffSummaries = turnDiffSummaries.toSorted((left, right) => {
    if (left.checkpointTurnCount !== right.checkpointTurnCount) {
      return right.checkpointTurnCount - left.checkpointTurnCount;
    }
    return right.completedAt.localeCompare(left.completedAt);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- rewrites the persisted diff store selection to the latest turn when the selected turn disappears
  useEffect(() => {
    if (!routeThreadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      routeThreadRef,
      orderedTurnDiffSummaries.map((summary) => summary.runId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);
  const selectedRunId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  const selectedCommitSha = diffSelection.kind === "commit" ? diffSelection.sha : null;
  const selectedGitScope = diffSelection.kind === "unstaged" ? "unstaged" : "branch";
  const selectedBaseRef =
    diffSelection.kind === "branch" || diffSelection.kind === "commit"
      ? diffSelection.baseRef
      : null;
  const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
  const selectedFileRevealRequestId =
    diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
  const selectedTurn =
    selectedRunId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.runId === selectedRunId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount = selectedTurn?.checkpointTurnCount;
  const latestTurn = orderedTurnDiffSummaries[0];
  const isLatestTurnSelected = selectedTurn?.runId === latestTurn?.runId;
  const selectedScopeLabel = toolCallSelection
    ? "Tool call"
    : selectedRunId === null
      ? selectedCommitSha
        ? selectedCommitSha.slice(0, 7)
        : selectedGitScope === "unstaged"
          ? "Uncommitted changes"
          : "All changes"
      : isLatestTurnSelected
        ? "Latest turn"
        : `Turn ${selectedCheckpointTurnCount ?? "?"}`;
  const reviewSectionId = toolCallSelection
    ? `tool-call:${toolCallSelection.threadId}:${toolCallSelection.itemId}`
    : selectedTurn
      ? `turn:${selectedTurn.runId}`
      : selectedCommitSha !== null
        ? `commit:${selectedCommitSha}`
        : selectedGitScope;
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : null;
  const codeViewMountKey = `${collapseScopeKey ?? reviewSectionId}:${codeViewRevision}`;
  const reviewSectionTitle = toolCallSelection
    ? "Tool call"
    : selectedTurn
      ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
      : selectedCommitSha
        ? `Commit ${selectedCommitSha.slice(0, 7)}`
        : selectedGitScope === "unstaged"
          ? "Uncommitted changes"
          : "All changes";
  // All changes include uncommitted work. Uncommitted changes and commits keep upstream's
  // requests, which older servers also answer.
  const previewSourceRequest: ReviewDiffPreviewSourceRequest | undefined =
    diffSelection.kind === "branch" ? "all" : undefined;
  const selectedCheckpointRange =
    typeof selectedCheckpointTurnCount === "number"
      ? {
          fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
          toTurnCount: selectedCheckpointTurnCount,
        }
      : null;
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.runId}` : null,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  );
  const branchDiffPreviewInput =
    canReadFiles && isGitSelection && activeThread && activeCwd
      ? {
          cwd: activeCwd,
          ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
          ...(selectedCommitSha !== null ? { commitSha: selectedCommitSha } : {}),
          ...(previewSourceRequest ? { source: previewSourceRequest } : {}),
          ignoreWhitespace: diffIgnoreWhitespace,
        }
      : undefined;
  const canRefreshGitDiff =
    isGitRepo && isGitSelection && activeThread != null && activeCwd != null;
  // Read under the workspace mutation id, so each mutation refetches the diff; the panel stays
  // mounted while hidden, so a mutation made then is already reflected when it shows.
  const branchDiffPreview = useEnvironmentQuery(
    branchDiffPreviewInput && activeThread
      ? revisionedQuery(
          reviewEnvironment.diffPreview({
            environmentId: activeThread.environmentId,
            input: branchDiffPreviewInput,
          }),
          canRefreshGitDiff ? workspaceMutationId : undefined,
        )
      : null,
  );
  const branchCommits = useEnvironmentQuery(
    visible && isGitRepo && canReadFiles && activeThread && activeCwd
      ? reviewEnvironment.branchCommits({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            ...(rememberedBaseRef ? { baseRef: rememberedBaseRef } : {}),
          },
        })
      : null,
  );
  const activeThreadRefreshKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;
  const previewSources = branchDiffPreview.data?.sources ?? [];
  const selectedGitSource = selectedCommitSha
    ? previewSources.find((source) => source.kind === "commit")
    : selectedGitScope === "unstaged"
      ? previewSources.find((source) => source.kind === "working-tree")
      : // Servers without the `all` source answer with the committed branch range.
        (previewSources.find((source) => source.kind === "all") ??
        previewSources.find((source) => source.kind === "branch-range"));
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const refreshPreviewQuery = branchDiffPreview.refresh;
  const refreshBranchCommits = branchCommits.refresh;
  const statusEnvironmentId = activeThread?.environmentId ?? null;
  // Git status is cached server-side and only refreshed on focus or at turn end, so the scope
  // menu's counts go stale when files change outside a turn. Refresh them when they are looked at.
  const refreshScopeCounts = () => {
    if (statusEnvironmentId === null || !activeCwd) return;
    void refreshVcsStatus({ environmentId: statusEnvironmentId, input: { cwd: activeCwd } });
    refreshBranchCommits();
  };
  const refreshDiffFromUserAction = () => {
    refreshPreviewQuery();
    refreshScopeCounts();
  };
  const preview = branchDiffPreview.data;
  const gitDiff = selectedGitSource?.diff;

  const toolCallPreview =
    toolCallSelection && toolCallItem?.type === "file_change" ? toolCallDiff(toolCallItem) : null;
  const selectedPatch = toolCallSelection
    ? toolCallPreview?.patch
    : selectedTurn
      ? activeCheckpointDiff.data?.diff
      : gitDiff;
  const isSelectedPatchTruncated =
    toolCallPreview?.truncated === true ||
    (isGitSelection && selectedGitSource?.truncated === true);
  const selectedPatchQuery = toolCallSelection
    ? toolCallDetail
    : selectedTurn
      ? activeCheckpointDiff
      : branchDiffPreview;
  const isLoadingSelectedPatch = selectedPatchQuery.isPending && selectedPatchQuery.data === null;
  const selectedPatchError = toolCallSelection
    ? toolCallDetail.error
    : selectedTurn
      ? activeCheckpointDiff.error
      : branchDiffPreview.error;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const lazySource =
    isGitSelection && selectedGitSource?.truncated && selectedGitSource.files
      ? selectedGitSource
      : null;
  const renderablePatch = getRenderablePatch(
    lazySource ? undefined : selectedPatch,
    `diff-panel:${resolvedTheme}`,
    {
      compactPartialHunkOffsets: isGitSelection,
      ...(toolCallSelection ? { ignoreWhitespace: diffIgnoreWhitespace } : {}),
    },
  );
  const recordedToolCallFileCount =
    toolCallSelection && toolCallItem?.type === "file_change"
      ? (toolCallItem.changes?.length ?? 0)
      : 0;
  const omittedToolCallFiles =
    renderablePatch?.kind === "files"
      ? Math.max(0, recordedToolCallFileCount - renderablePatch.files.length)
      : 0;
  const fileStats = new Map(lazySource?.files?.map((file) => [file.path, file]));
  const sourceLineStat =
    isGitSelection && selectedGitSource?.files
      ? selectedGitSource.files.reduce(
          (total, file) => ({
            additions: total.additions + file.additions,
            deletions: total.deletions + file.deletions,
          }),
          { additions: 0, deletions: 0 },
        )
      : null;
  const currentLoadDiffFiles =
    isGitSelection && activeThread && preview && selectedGitSource && canReadFiles
      ? createGitDiffFileContentsLoader(getDiffFileContents, {
          environmentId: activeThread.environmentId,
          cwd: preview.cwd,
          sourceKind: selectedGitSource.kind,
          baseRef: selectedGitSource.baseRef,
          headRef: selectedGitSource.headRef,
          cacheKey: selectedGitSource.diffHash,
        })
      : undefined;
  const loadDiffFiles: FileDiffContentsLoader = useStableCallback(async (fileDiff) => {
    if (!currentLoadDiffFiles) {
      throw new Error("Diff file contents are unavailable for this selection.");
    }
    return currentLoadDiffFiles(fileDiff);
  });
  const {
    scope: filePatchScope,
    isPending: areFilePatchesPending,
    fileStates,
    retry,
    requestFile,
    readyFilePaths,
    renderableFiles,
    settledFileCount,
    loadNextFiles,
  } = useReviewFilePatches({
    environmentId: activeThread?.environmentId,
    cwd: branchDiffPreview.data?.cwd,
    source: lazySource,
    sourceRequest: previewSourceRequest,
    baseRef:
      selectedCommitSha !== null ? selectedBaseRef : (lazySource?.baseRef ?? selectedBaseRef),
    ignoreWhitespace: diffIgnoreWhitespace,
    theme: resolvedTheme,
    previewInput: branchDiffPreviewInput,
    preview: renderablePatch,
  });
  const refreshBranchDiffPreview = refreshPreviewQuery;
  const diffRefreshKey = `diff:${activeThreadRefreshKey ?? ""}`;

  // The panel stays mounted while hidden, and edits made outside T3 Code bump no mutation id, so
  // showing it revalidates the diff; that also stands in for focus events missed while hidden.
  // A git diff is too costly to repeat on a timer nobody asked for. A diff read within the floor,
  // such as a mutation's refetch while hidden, already counts as that revalidation.
  useLiveRefresh(
    branchDiffPreview.data !== null && !branchDiffPreview.isPending
      ? () => {
          if (Date.now() - branchDiffPreview.dataUpdatedAt < LIVE_REFRESH_MIN_INTERVAL_MS) return;
          refreshBranchDiffPreview();
        }
      : null,
    {
      enabled: visible && canReadFiles && canRefreshGitDiff,
      key: diffRefreshKey,
      intervalMs: null,
      refreshOnShow: true,
    },
  );

  const isRefreshingDiff = branchDiffPreview.isPending || areFilePatchesPending;
  const renderableFileEntries = renderableFiles.map(getCachedFileEntry);
  const testFileCount = renderableFiles.filter((file) =>
    isTestChangedFile(resolveFileDiffPath(file)),
  ).length;
  // Hiding is display-only: lazy loading indexes into the full list. A requested file stays visible.
  const shownFileEntries = hideTestFiles
    ? renderableFileEntries.filter(({ fileDiff }) => {
        const path = resolveFileDiffPath(fileDiff);
        return path === selectedFilePath || !isTestChangedFile(path);
      })
    : renderableFileEntries;
  const viewedMarks = useDiffPanelStore((state) =>
    routeThreadRef
      ? state.viewedByThreadKey[scopedThreadKey(routeThreadRef)]?.[reviewSectionId]
      : undefined,
  );
  const currentViewedMark = (fileDiff: FileDiffMetadata): DiffViewedMark => ({
    // A placeholder has no patch yet, so only its line counts say whether it changed.
    version: fileDiff.cacheKey?.endsWith(":pending")
      ? null
      : getCachedFileEntry(fileDiff).fileVersion,
    stat: diffViewedStat(fileStats.get(resolveFileDiffPath(fileDiff))),
  });
  // `changedKeys` were marked viewed but their diff has moved on since.
  const viewedFiles = (() => {
    const keys = new Set<string>();
    const paths = new Set<string>();
    const changedKeys = new Set<string>();
    for (const { fileDiff, fileKey } of renderableFileEntries) {
      const path = resolveFileDiffPath(fileDiff);
      const mark = viewedMarks?.[path];
      if (!mark) continue;
      if (isDiffFileViewed(mark, currentViewedMark(fileDiff))) {
        keys.add(fileKey);
        paths.add(path);
      } else {
        changedKeys.add(fileKey);
      }
    }
    return { keys, paths, changedKeys };
  })();
  // Viewed files start collapsed, like every file when the setting asks for it.
  const defaultCollapsedDiffFileKeys = (() =>
    settings.diffFilesCollapsed
      ? new Set(renderableFileEntries.map((file) => file.fileKey))
      : viewedFiles.keys.size > 0
        ? viewedFiles.keys
        : EMPTY_COLLAPSED_DIFF_FILE_KEYS)();
  const storedCollapsedDiffFileKeys = useDiffPanelSessionStore((state) =>
    collapseScopeKey ? state.collapsedFileKeysByScopeKey[collapseScopeKey] : undefined,
  );
  const collapsedDiffFileKeys = storedCollapsedDiffFileKeys ?? defaultCollapsedDiffFileKeys;
  const updateCollapsedDiffFiles = (
    update: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => {
    if (!collapseScopeKey) return;
    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(collapseScopeKey, defaultCollapsedDiffFileKeys, update);
  };
  const renderLoadingBoundary = () =>
    settledFileCount < renderableFiles.length ? (
      <DiffFileLoadingBoundary
        load={loadNextFiles}
        count={renderableFiles.length - settledFileCount}
      />
    ) : null;
  // While the tree is open one file shows at a time: the one picked in the tree or opened from
  // the chat, else the first the tree lists. A file that leaves the scope falls back to the first.
  const openFile = useDiffPanelStore((state) =>
    routeThreadRef ? state.openFileByThreadKey[scopedThreadKey(routeThreadRef)] : undefined,
  );
  const setOpenFile = (path: string) => {
    if (!routeThreadRef || !collapseScopeKey) return;
    useDiffPanelStore.getState().openFile(routeThreadRef, collapseScopeKey, path);
  };
  const selectedFileReveal = { path: selectedFilePath, requestId: selectedFileRevealRequestId };
  // A file opened from the chat, including a repeat request for the same file, opens here.
  useEffect(() => {
    if (selectedFileReveal.path) setOpenFile(selectedFileReveal.path);
  }, [selectedFileReveal, setOpenFile]);
  const orderedFileEntries = orderDiffChangesTreeFiles(shownFileEntries, (entry) =>
    resolveFileDiffPath(entry.fileDiff),
  );
  const singleFileEntry = fileTreeOpen
    ? (orderedFileEntries.find(
        (entry) =>
          openFile?.scope === collapseScopeKey &&
          resolveFileDiffPath(entry.fileDiff) === openFile.path,
      ) ?? orderedFileEntries[0])
    : undefined;
  const singleFilePosition = singleFileEntry ? orderedFileEntries.indexOf(singleFileEntry) : -1;
  const stepOpenFile = (delta: -1 | 1) => {
    const next = orderedFileEntries[singleFilePosition + delta];
    if (next) setOpenFile(resolveFileDiffPath(next.fileDiff));
  };
  const singleFilePath = singleFileEntry ? resolveFileDiffPath(singleFileEntry.fileDiff) : null;
  const singleFileIndex = singleFileEntry ? renderableFileEntries.indexOf(singleFileEntry) : -1;
  const singleFileReady =
    !lazySource || (singleFilePath !== null && readyFilePaths.has(singleFilePath));
  useEffect(() => {
    if (lazySource && singleFileIndex >= 0 && !singleFileReady) requestFile(singleFileIndex);
  }, [lazySource, requestFile, singleFileIndex, singleFileReady]);
  const codeViewFiles = (
    singleFileEntry
      ? singleFileReady
        ? [singleFileEntry]
        : []
      : shownFileEntries.filter(
          ({ fileDiff }) => !lazySource || readyFilePaths.has(resolveFileDiffPath(fileDiff)),
        )
  ).map(({ fileDiff, fileKey, fileVersion }) => {
    return {
      fileDiff,
      filePath: resolveFileDiffPath(fileDiff),
      fileKey,
      fileVersion,
      // Header-only placeholders use the viewer's collapsed geometry until their patch arrives.
      collapsed:
        (!singleFileEntry && collapsedDiffFileKeys.has(fileKey)) ||
        fileDiff.cacheKey?.endsWith(":pending") === true,
    };
  });
  const diffFileKeys = shownFileEntries.map((file) => file.fileKey);
  const allDiffFilesCollapsed = areAllDiffFilesCollapsed(diffFileKeys, collapsedDiffFileKeys);
  const pendingFiles = shownFileEntries
    .map(({ fileDiff }) => fileDiff)
    .filter((file) => file.cacheKey?.endsWith(":pending"));
  const diffLineStat = sourceLineStat ?? getDiffLineStat(renderableFiles);
  const treeFiles = (() =>
    shownFileEntries.map(({ fileDiff }): DiffChangesTreeFile => {
      const filePath = resolveFileDiffPath(fileDiff);
      const stat = fileStats.get(filePath) ?? getDiffLineStat([fileDiff]);
      return {
        filePath,
        type: fileDiff.type,
        additions: stat.additions,
        deletions: stat.deletions,
        viewed: viewedFiles.paths.has(filePath),
      };
    }))();
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => toastManager.add({ type: "success", title: "Path copied" }),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Failed to copy path", description: error.message }),
  });
  const selectedDiffFileKey = selectedFilePath
    ? (codeViewFiles.find((candidate) => candidate.filePath === selectedFilePath)?.fileKey ?? null)
    : null;

  const codeViewReveal = useCodeViewFileReveal();
  useEffect(() => {
    if (selectedDiffFileKey) codeViewReveal.request(selectedDiffFileKey);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A remounted viewer or a repeated reveal request scrolls to the same file again.
  }, [codeViewReveal, codeViewMountKey, selectedDiffFileKey, selectedFileRevealRequestId]);
  const revealDiffFile = (filePath: string) => {
    if (fileTreeOpen) {
      setOpenFile(filePath);
      return true;
    }
    const index = renderableFileEntries.findIndex(
      (candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath,
    );
    const file = renderableFileEntries[index];
    if (!file) return false;
    updateCollapsedDiffFiles((current) => {
      const next = new Set(current);
      next.delete(file.fileKey);
      return next;
    });
    if (lazySource && index >= settledFileCount) {
      requestFile(index);
    }
    codeViewReveal.request(file.fileKey);
    return true;
  };

  // A file another view asked to reveal (a chat diff link): retried as the diff loads until it
  // holds the file, then not again until a new request, so it does not undo what the user did since.
  const externalRevealRef = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals an externally requested file in the diff viewer, retrying as the diff DOM loads
  useEffect(() => {
    if (!selectedFilePath) {
      externalRevealRef.current = null;
      return;
    }
    const key = JSON.stringify([collapseScopeKey, selectedFilePath, selectedFileRevealRequestId]);
    if (externalRevealRef.current === key) return;
    if (revealDiffFile(selectedFilePath)) {
      externalRevealRef.current = key;
    }
  }, [collapseScopeKey, selectedFilePath, selectedFileRevealRequestId, revealDiffFile]);

  const openDiffFile = (filePath: string) => {
    openDiffFilePrimaryAction({
      threadRef: routeThreadRef,
      filePath,
      activeCwd,
      repositoryRoot: activeRepositoryRoot,
      openInEditor: (targetPath) => {
        void (async () => {
          const result = await openInPreferredEditor(targetPath);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            console.warn("Failed to open diff file in editor.", {
              operation: "open-diff-file",
              ...(routeThreadRef
                ? {
                    environmentId: routeThreadRef.environmentId,
                    threadId: routeThreadRef.threadId,
                  }
                : {}),
              ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
            });
          }
        })();
      },
    });
  };
  const codeSurfaceRef = useRef<HTMLDivElement>(null);
  const openCodeLocation = (path: string, line: number) => {
    if (routeThreadRef) useRightPanelStore.getState().openFile(routeThreadRef, path, line);
  };
  // Every file header holds these; a new identity per collapse change would redraw them all.
  const toggleDiffFileCollapsed = useStableCallback((fileKey: string) => {
    updateCollapsedDiffFiles((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  });
  // Find can ask again before the unfolded file reaches the viewer, so this must never fold.
  const unfoldDiffFile = useStableCallback((fileKey: string) => {
    updateCollapsedDiffFiles((current) => {
      if (!current.has(fileKey)) return current;
      const next = new Set(current);
      next.delete(fileKey);
      return next;
    });
  });
  // Marking a file viewed collapses it and unmarking expands it again.
  const toggleDiffFileViewed = (fileDiff: FileDiffMetadata) => {
    if (!routeThreadRef) return;
    const { fileKey } = getCachedFileEntry(fileDiff);
    const viewed = viewedFiles.keys.has(fileKey);
    useDiffPanelStore
      .getState()
      .setFileViewed(
        routeThreadRef,
        reviewSectionId,
        resolveFileDiffPath(fileDiff),
        viewed ? null : currentViewedMark(fileDiff),
      );
    updateCollapsedDiffFiles((current) => {
      const next = new Set(current);
      if (viewed) next.delete(fileKey);
      else next.add(fileKey);
      return next;
    });
  };

  const toggleDiffFileCollapse = () => {
    setCodeViewRevision((current) => current + 1);
    updateCollapsedDiffFiles((current) => toggleAllDiffFiles(diffFileKeys, current));
  };
  // Full file shows each file's unchanged lines too, which needs the file contents loader.
  const canExpandUnchanged = currentLoadDiffFiles !== undefined;
  const diffViewMode = expandUnchanged && canExpandUnchanged ? "file" : diffLayout;
  const selectScope = (choice: DiffScopeChoice) => {
    if (!routeThreadRef) return;
    const store = useDiffPanelStore.getState();
    switch (choice.kind) {
      case "branch":
      case "unstaged":
        store.selectGitScope(routeThreadRef, choice.kind);
        return;
      case "commit":
        store.selectCommit(routeThreadRef, choice.sha);
        return;
      case "turn":
        store.selectTurn(routeThreadRef, choice.runId);
        return;
    }
  };
  const selectedScopeChoice: DiffScopeChoice | null = toolCallSelection
    ? null
    : selectedTurn
      ? { kind: "turn", runId: selectedTurn.runId }
      : selectedCommitSha
        ? { kind: "commit", sha: selectedCommitSha }
        : { kind: selectedGitScope };
  const scopeMenuTurns = orderedTurnDiffSummaries.map((summary) => ({
    runId: summary.runId,
    turnCount: summary.checkpointTurnCount,
    fileCount: summary.files.length,
    completedAt: summary.completedAt,
  })) satisfies ReadonlyArray<DiffScopeMenuTurn>;
  const selectedCommit = selectedCommitSha
    ? branchCommits.data?.commits.find((commit) => commit.sha === selectedCommitSha)
    : undefined;
  const scopeMenuLabel = toolCallSelection
    ? "Tool call"
    : selectedTurn
      ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
      : selectedCommitSha
        ? selectedCommitSha.slice(0, 7)
        : selectedGitScope === "unstaged"
          ? "Uncommitted"
          : "All changes";
  const scopeMenuTitle =
    selectedCommit?.subject || selectedGitSource?.commitSubject || selectedScopeLabel;
  // What the comparison resolves to: the server's answer when it gave one, else the pick.
  const resolvedBaseRef =
    (selectedGitSource?.kind === "branch-range" || selectedGitSource?.kind === "all"
      ? selectedGitSource.baseRef
      : null) ?? rememberedBaseRef;
  const previewCwd = branchDiffPreview.data?.cwd ?? activeCwd;
  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-1 [-webkit-app-region:no-drag]">
        {routeThreadRef && activeThread && isGitRepo ? (
          <div className="me-1 flex min-w-0 shrink items-center">
            <DiffScopeMenu
              selected={selectedScopeChoice}
              label={scopeMenuLabel}
              title={scopeMenuTitle}
              allFileCount={
                selectedScopeChoice?.kind === "branch" && selectedGitSource?.kind === "all"
                  ? (selectedGitSource.files?.length ?? null)
                  : null
              }
              uncommittedFileCount={gitStatusQuery.data?.workingTree.files.length ?? null}
              commits={branchCommits.data?.commits ?? []}
              commitsTruncated={branchCommits.data?.truncated ?? false}
              turns={scopeMenuTurns}
              onSelect={selectScope}
              onOpen={refreshScopeCounts}
              targetBranchPicker={
                previewCwd && isGitSelection ? (
                  <DiffTargetBranchPicker
                    environmentId={activeThread.environmentId}
                    cwd={previewCwd}
                    selectedBaseRef={rememberedBaseRef}
                    resolvedBaseRef={resolvedBaseRef}
                    headRef={gitStatusQuery.data?.refName ?? selectedGitSource?.headRef ?? null}
                    onSelect={(baseRef) =>
                      useDiffPanelStore.getState().setBaseRef(routeThreadRef, baseRef)
                    }
                  />
                ) : null
              }
            />
          </div>
        ) : null}
        {singleFileEntry && orderedFileEntries.length > 0 ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Previous file"
                    disabled={singleFilePosition <= 0}
                    onClick={() => stepOpenFile(-1)}
                  />
                }
              >
                <ChevronUpIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Previous file</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Next file"
                    disabled={singleFilePosition >= orderedFileEntries.length - 1}
                    onClick={() => stepOpenFile(1)}
                  />
                }
              >
                <ChevronDownIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Next file</TooltipPopup>
            </Tooltip>
            <span className="ms-1 shrink-0 text-xs tabular-nums text-muted-foreground">
              {singleFilePosition + 1} / {orderedFileEntries.length}
            </span>
          </>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {codeViewFiles.length > 0 || (isGitSelection && selectedGitSource?.files?.length) ? (
          <DiffStatLabel
            additions={diffLineStat.additions}
            deletions={diffLineStat.deletions}
            className="mr-1 text-2xs"
            layout="inline"
          />
        ) : null}
        {canRefreshGitDiff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={isRefreshingDiff ? "Refreshing diff" : "Refresh diff"}
                  onClick={refreshDiffFromUserAction}
                />
              }
            >
              <RefreshIcon size="sm" refreshing={isRefreshingDiff} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {isRefreshingDiff ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        {diffFileKeys.length > 0 && !fileTreeOpen && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={toggleDiffFileCollapse}
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allDiffFilesCollapsed ? ChevronsUpDown : ChevronsDownUp}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        )}
        <ToggleGroup
          aria-label="Diff layout"
          className="shrink-0"
          variant="segmented"
          value={[diffViewMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "file") {
              setExpandUnchanged(true);
            } else if (next === "stacked" || next === "split") {
              setExpandUnchanged(false);
              updateClientSettings({ diffLayout: next });
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3.5" />
          </Toggle>
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle aria-label="Full file view" value="file" disabled={!canExpandUnchanged} />
              }
            >
              <FileTextIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {canExpandUnchanged ? "Full file" : "Full files are unavailable for turn diffs"}
            </TooltipPopup>
          </Tooltip>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrap(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="ghost"
                size="sm"
                pressed={diffIgnoreWhitespace}
                onPressedChange={(pressed) => {
                  setDiffIgnoreWhitespace(Boolean(pressed));
                }}
              />
            }
          >
            <PilcrowIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
        {testFileCount > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label="Hide test files"
                  variant="ghost"
                  size="sm"
                  pressed={hideTestFiles}
                  onPressedChange={(pressed) => setHideTestFiles(Boolean(pressed))}
                />
              }
            >
              <FlaskConicalOffIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {hideTestFiles
                ? `Show ${testFileCount} hidden test ${testFileCount === 1 ? "file" : "files"}`
                : "Hide test files"}
            </TooltipPopup>
          </Tooltip>
        )}
        {diffFileKeys.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                  variant="ghost"
                  size="sm"
                  pressed={fileTreeOpen}
                  onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
                />
              }
            >
              <FolderTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {fileTreeOpen ? "Hide file tree" : "Show file tree"}
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
    </>
  );
  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo && !toolCallSelection ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedRunId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : isGitSelection && !canReadFiles ? (
        fileAccess.isPending ? (
          <DiffPanelLoadingState label="Checking file access..." />
        ) : (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            {fileAccess.error ?? "This connection cannot read local diffs."}
          </div>
        )
      ) : (
        <>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
            {isSelectedPatchTruncated && !lazySource && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                This preview exceeds the size limit. Changes shown are incomplete.
                {isGitSelection && selectedGitSource?.files ? " Totals include all changes." : ""}
              </p>
            )}
            {omittedToolCallFiles > 0 && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
                This tool call changed {recordedToolCallFileCount} files. The recorded patch omits{" "}
                {omittedToolCallFiles} of them.
              </p>
            )}
            {selectedPatchError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-2xs text-error/80">{selectedPatchError}</p>
              </div>
            )}
            {!renderablePatch && toolCallPreview && toolCallPreview.content.length > 0 ? (
              <ToolCallContentPreview content={toolCallPreview.content} wordWrap={wordWrap} />
            ) : !renderablePatch && !lazySource ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={
                    toolCallSelection
                      ? "Loading tool call diff..."
                      : selectedTurn
                        ? "Loading checkpoint diff..."
                        : selectedGitScope === "unstaged"
                          ? "Loading uncommitted changes..."
                          : selectedCommitSha !== null
                            ? "Loading commit..."
                            : "Loading changes..."
                  }
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-4 px-5 text-center">
                  <GitCompareArrowsIcon
                    className="size-8 text-muted-foreground/50"
                    strokeWidth={1.5}
                  />
                  <p className="text-sm text-muted-foreground">
                    {!hasNoNetChanges
                      ? "No patch available for this selection."
                      : selectedTurn
                        ? "No changes in this turn"
                        : selectedCommitSha
                          ? "This commit has no file changes"
                          : selectedGitScope === "unstaged"
                            ? "No uncommitted changes yet"
                            : "No changes yet"}
                  </p>
                </div>
              )
            ) : lazySource || renderablePatch?.kind === "files" ? (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                {activeThread && activeCwd ? (
                  <DiffCodeIntelligence
                    root={codeSurfaceRef}
                    environmentId={activeThread.environmentId}
                    cwd={activeCwd}
                    repositoryRoot={activeRepositoryRoot}
                    files={codeViewFiles}
                    loadDiffFiles={currentLoadDiffFiles}
                    onOpenLocation={openCodeLocation}
                  />
                ) : null}
                <div
                  ref={codeSurfaceRef}
                  className="min-h-0 min-w-0 flex-1"
                  onClickCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    for (const node of composedPath) {
                      if (!(node instanceof HTMLElement)) continue;
                      // Header controls own their clicks; bubbling a chevron click would toggle twice.
                      if (
                        node instanceof HTMLButtonElement ||
                        node instanceof HTMLAnchorElement ||
                        node instanceof HTMLLabelElement
                      ) {
                        return;
                      }
                    }
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent;
                    if (filePath) {
                      openDiffFile(filePath);
                      return;
                    }
                    const header = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                    );
                    const headerFilePath = header?.querySelector("[data-title]")?.textContent;
                    if (!headerFilePath) return;
                    const file = codeViewFiles.find(
                      (candidate) => candidate.filePath === headerFilePath,
                    );
                    if (file) toggleDiffFileCollapsed(file.fileKey);
                  }}
                  onContextMenuCapture={(event) => {
                    const composedPath = event.nativeEvent.composedPath?.() ?? [];
                    const title = composedPath.find(
                      (node): node is HTMLElement =>
                        node instanceof HTMLElement && node.hasAttribute("data-title"),
                    );
                    const filePath = title?.textContent?.trim();
                    if (!filePath) return;
                    event.preventDefault();
                    onFileContextMenu(
                      {
                        environmentId: activeThread?.environmentId ?? null,
                        filePath,
                        workspaceRoot: activeCwd,
                        repositoryRoot: activeRepositoryRoot,
                      },
                      event,
                    );
                  }}
                >
                  {singleFileEntry && !singleFileReady ? (
                    <DiffPanelLoadingState label="Loading file diff..." />
                  ) : null}
                  <AnnotatableCodeView
                    key={collapseScopeKey ?? reviewSectionId}
                    viewerRef={codeViewReveal.attach}
                    codeViewKey={`${codeViewMountKey}:${lazySource ? filePatchScope : "preview"}:${singleFilePath ?? "all"}`}
                    className={
                      singleFileEntry && !singleFileReady
                        ? "hidden"
                        : "h-full min-h-0 overflow-auto"
                    }
                    files={codeViewFiles}
                    pendingFiles={singleFileEntry ? [] : pendingFiles}
                    {...(singleFileEntry ? {} : { renderCodeViewFooter: renderLoadingBoundary })}
                    sectionId={reviewSectionId}
                    sectionTitle={reviewSectionTitle}
                    composerDraftTarget={composerDraftTarget}
                    renderHeaderFilenameSuffix={(fileDiff) => {
                      const path = resolveFileDiffPath(fileDiff);
                      const state = fileStates.get(path);
                      return (
                        <DiffFileHeaderSuffix
                          filePath={path}
                          hasStat={fileStats.has(path)}
                          error={state?.error ?? false}
                          truncated={state?.truncated ?? false}
                          onRetry={retry}
                        />
                      );
                    }}
                    {...(lazySource
                      ? {
                          unsafeCSSExtra:
                            "[data-additions-count], [data-deletions-count] { display: none; }",
                        }
                      : {})}
                    onRevealSearchMatch={unfoldDiffFile}
                    renderHeaderMetadata={(fileDiff) => {
                      const stat = lazySource
                        ? fileStats.get(resolveFileDiffPath(fileDiff))
                        : undefined;
                      const { fileKey } = getCachedFileEntry(fileDiff);
                      const changed = viewedFiles.changedKeys.has(fileKey);
                      return (
                        <span className="flex items-center gap-3">
                          {stat ? (
                            <DiffStatLabel additions={stat.additions} deletions={stat.deletions} />
                          ) : null}
                          {/* The header itself folds the file, so the tick keeps its press to
                            itself; the capture listener above skips labels. */}
                          {routeThreadRef ? (
                            <label
                              className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <Checkbox
                                aria-label={changed ? "Changed" : "Viewed"}
                                checked={viewedFiles.keys.has(fileKey)}
                                onCheckedChange={() => toggleDiffFileViewed(fileDiff)}
                              />
                              {changed ? (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={<span className="text-warning-foreground" />}
                                  >
                                    Changed
                                  </TooltipTrigger>
                                  <TooltipPopup side="bottom">
                                    This file has changed since you marked it viewed.
                                  </TooltipPopup>
                                </Tooltip>
                              ) : (
                                "Viewed"
                              )}
                            </label>
                          ) : null}
                        </span>
                      );
                    }}
                    renderHeaderPrefix={(fileDiff, fileKey) => {
                      if (singleFileEntry) return null;
                      const unavailable = fileDiff.cacheKey?.endsWith(":pending") === true;
                      return (
                        <DiffFileCollapseToggle
                          filePath={resolveFileDiffPath(fileDiff)}
                          fileKey={fileKey}
                          collapsed={unavailable || collapsedDiffFileKeys.has(fileKey)}
                          unavailable={unavailable}
                          onToggle={toggleDiffFileCollapsed}
                        />
                      );
                    }}
                    options={{
                      diffStyle: diffViewMode === "split" ? "split" : "unified",
                      expandUnchanged: diffViewMode === "file",
                      lineDiffType: "none",
                      overflow: wordWrap ? "wrap" : "scroll",
                      theme: resolveDiffThemeName(resolvedTheme),
                      preferredHighlighter: PREFERRED_HIGHLIGHTER,
                      themeType: resolvedTheme as DiffThemeType,
                      stickyHeaders: true,
                      onPostRender: codeViewReveal.flush,
                      ...(currentLoadDiffFiles ? { loadDiffFiles } : {}),
                    }}
                  />
                </div>
                {fileTreeOpen ? (
                  <aside
                    className="relative flex min-w-0 shrink-0 flex-col border-l border-border/60"
                    style={{ width: fileTreeWidth }}
                  >
                    <RightPanelResizeHandle handlers={fileTreeResizeHandlers} />
                    <div className="flex h-8 shrink-0 items-center gap-2 px-2.5">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                        {treeFiles.length} {treeFiles.length === 1 ? "file" : "files"}
                      </span>
                      {viewedFiles.paths.size > 0 ? (
                        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
                          {viewedFiles.paths.size}/{treeFiles.length} viewed
                        </span>
                      ) : (
                        <DiffStatLabel
                          additions={diffLineStat.additions}
                          deletions={diffLineStat.deletions}
                          layout="inline"
                          className="shrink-0 text-2xs"
                        />
                      )}
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <DiffChangesTree
                        files={treeFiles}
                        selectedPath={singleFilePath}
                        ariaLabel={`${reviewSectionTitle} files`}
                        actions={{
                          onOpenFile: revealDiffFile,
                          onOpenInFiles: openDiffFile,
                          onCopyPath: (path) => copyToClipboard(path, undefined),
                        }}
                      />
                    </div>
                  </aside>
                ) : null}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-2xs text-muted-foreground/75">
                    {renderablePatch?.kind === "raw" ? renderablePatch.reason : null}
                  </p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-2xs leading-relaxed text-muted-foreground/90",
                      wordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch?.kind === "raw" ? renderablePatch.text : null}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
