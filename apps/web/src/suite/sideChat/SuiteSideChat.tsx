/**
 * The side chat on Mail, Calendar and Drive: an ordinary Code thread in the
 * Otterware Assistant project, rendered by Otter Code's own ChatView in its
 * compact form (timeline, work log, approvals, questions and the real
 * composer). Each module keeps its current chat; what the page shows rides
 * along with a message as a `suite-page` context record.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronDownIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  PanelRightCloseIcon,
  SquarePenIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import ChatView, { type ChatViewOutgoingMessageDecoration } from "../../components/ChatView";
import {
  resolveDraftPromotionNavigationTarget,
  threadShellHasStarted,
} from "../../components/ChatView.logic";
import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useBackgroundDraftSubmissionPending,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useProjects, useThreadShell, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  createSideChatDraft,
  knownAssistantProjectId,
  useEnsureAssistantProject,
} from "../assistantThreads";
import { SUITE_WEB_MODULES } from "../modules";
import { useCurrentSuitePageContext } from "../suitePageContext";
import { suitePageContextDecoration, suitePageContextLabel } from "./suitePageContextReference";

const SideChatTarget = Schema.NullOr(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("draft"),
      environmentId: Schema.String,
      draftId: Schema.String,
      threadId: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("server"),
      environmentId: Schema.String,
      threadId: Schema.String,
      /** Keeps the ChatView that carried the draft mounted through its promotion. */
      viewKey: Schema.String,
    }),
  ]),
);
type SideChatTarget = NonNullable<typeof SideChatTarget.Type>;

const INCLUDE_CONTEXT_KEY = "otterware:suite-side-chat:include-context:v1";
const targetKey = (moduleId: string) => `otterware:suite-side-chat:thread:v1:${moduleId}`;
const RECENT_CHATS = 12;

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : undefined,
    }),
  );
}

/** The Assistant project as this client knows it, for listing its chats. */
function useAssistantProjectId(environmentId: EnvironmentId | null) {
  const projects = useProjects();
  const known = knownAssistantProjectId(environmentId);
  if (known !== null) return known;
  return (
    projects.find(
      (project) =>
        project.environmentId === environmentId &&
        project.title === "Otterware Assistant" &&
        project.workspaceRoot.endsWith("agent-workspace"),
    )?.id ?? null
  );
}

export function SuiteSideChat({
  moduleId,
  onHide,
  hideShortcutLabel,
}: {
  readonly moduleId: string;
  readonly onHide: () => void;
  readonly hideShortcutLabel: string;
}) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const [target, setTarget] = useLocalStorage(targetKey(moduleId), null, SideChatTarget);
  const [includeContext, setIncludeContext] = useLocalStorage(
    INCLUDE_CONTEXT_KEY,
    true,
    Schema.Boolean,
  );
  const publishedContext = useCurrentSuitePageContext();
  const ensureAssistant = useEnsureAssistantProject();
  const [starting, setStarting] = useState(false);
  const moduleLabel = SUITE_WEB_MODULES.find((module) => module.id === moduleId)?.label ?? moduleId;
  const pageContext = useMemo(
    () =>
      publishedContext?.module === moduleId
        ? publishedContext
        : { module: moduleId, title: moduleLabel, refs: [] },
    [publishedContext, moduleId, moduleLabel],
  );

  // A target from another environment (the user switched the primary) is not shown here.
  const activeTarget = target !== null && target.environmentId === environmentId ? target : null;
  const activeThreadRef = activeTarget
    ? scopeThreadRef(
        EnvironmentId.make(activeTarget.environmentId),
        ThreadId.make(activeTarget.threadId),
      )
    : null;
  const activeShell = useThreadShell(activeThreadRef);

  const assistantProjectId = useAssistantProjectId(environmentId);
  const shells = useThreadShells();
  const recentChats = useMemo(
    () =>
      assistantProjectId === null
        ? []
        : shells
            .filter(
              (shell) =>
                shell.environmentId === environmentId &&
                shell.projectId === assistantProjectId &&
                shell.archivedAt === null &&
                shell.lineage.relationshipToParent !== "subagent",
            )
            .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, RECENT_CHATS),
    [assistantProjectId, environmentId, shells],
  );

  const startNewChat = useCallback(async () => {
    if (environmentId === null || starting) return;
    setStarting(true);
    try {
      const project = await ensureAssistant(environmentId);
      const { draftId, threadId } = createSideChatDraft(project, `otterware-side-chat:${moduleId}`);
      setTarget({ kind: "draft", environmentId, draftId, threadId });
    } catch (error) {
      reportFailure("Could not start a chat", error);
    } finally {
      setStarting(false);
    }
  }, [ensureAssistant, environmentId, moduleId, setTarget, starting]);

  // Capture the current page on every send, including unchanged context on later messages.
  const decorateOutgoingMessage = useCallback(
    () => (includeContext ? suitePageContextDecoration(pageContext) : null),
    [includeContext, pageContext],
  );

  const openFullThread = () => {
    if (activeTarget === null) return;
    if (activeTarget.kind === "server") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: activeTarget.environmentId, threadId: activeTarget.threadId },
      });
    } else {
      void navigate({ to: "/draft/$draftId", params: { draftId: activeTarget.draftId } });
    }
  };

  const title =
    activeShell?.title ?? (activeTarget?.kind === "draft" ? "New chat" : `${moduleLabel} chat`);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-suite-side-chat-module={moduleId}>
      <div className="flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
        <MessagesSquareIcon className="size-4 shrink-0 text-muted-foreground" />
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                className="min-w-0 flex-1 justify-start"
                aria-label="Recent chats"
              />
            }
          >
            <span className="min-w-0 truncate font-medium">{title}</span>
            <ChevronDownIcon className="shrink-0 opacity-60" />
          </MenuTrigger>
          <MenuPopup align="start" className="w-72">
            {recentChats.length === 0 ? (
              <MenuItem disabled>No chats yet</MenuItem>
            ) : (
              recentChats.map((chat) => (
                <MenuItem
                  key={chat.id}
                  onClick={() =>
                    setTarget({
                      kind: "server",
                      environmentId: chat.environmentId,
                      threadId: chat.id,
                      viewKey: chat.id,
                    })
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {formatRelativeTimeLabel(chat.updatedAt)}
                  </span>
                </MenuItem>
              ))
            )}
          </MenuPopup>
        </Menu>
        <HeaderButton label="New chat" onClick={() => void startNewChat()} disabled={starting}>
          <SquarePenIcon />
        </HeaderButton>
        <HeaderButton
          label="Open as full thread"
          onClick={openFullThread}
          disabled={activeTarget === null}
        >
          <Maximize2Icon />
        </HeaderButton>
        <HeaderButton label={`Hide side chat (${hideShortcutLabel})`} onClick={onHide}>
          <PanelRightCloseIcon />
        </HeaderButton>
      </div>
      {pageContext ? (
        <label className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-muted-foreground text-xs">
          <span className="min-w-0 flex-1 truncate">
            {includeContext ? "Sends " : "Not sending "}
            <span className="font-medium text-foreground">
              {suitePageContextLabel(pageContext)}
            </span>
          </span>
          <Switch
            size="sm"
            checked={includeContext}
            onCheckedChange={(checked) => setIncludeContext(checked)}
            aria-label="Send what is on this page with messages"
          />
        </label>
      ) : null}
      {environmentId === null ? (
        <SideChatEmpty
          title="Connecting…"
          description="The side chat needs a connected environment."
        />
      ) : activeTarget === null ? (
        <SideChatEmpty
          title="Ask about this page"
          description={
            pageContext
              ? `A chat here sees “${suitePageContextLabel(pageContext)}” and can use your ${moduleLabel}, Calendar, Drive and Code tools.`
              : "A chat here sees what you are looking at and can use the Otterware tools."
          }
          action={
            <Button size="sm" onClick={() => void startNewChat()} disabled={starting}>
              {starting ? <Spinner /> : <SquarePenIcon />}
              New chat
            </Button>
          }
        />
      ) : (
        <SideChatThread
          target={activeTarget}
          onPromoted={setTarget}
          onMissing={() => setTarget(null)}
          decorateOutgoingMessage={decorateOutgoingMessage}
        />
      )}
    </div>
  );
}

function HeaderButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function SideChatEmpty(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessagesSquareIcon />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.action ? <EmptyContent>{props.action}</EmptyContent> : null}
    </Empty>
  );
}

/**
 * One side chat thread. A draft becomes a server thread on its first send;
 * like the thread route, the same ChatView element (keyed by the draft) stays
 * mounted through that promotion, so the timeline never flashes empty.
 */
function SideChatThread({
  target,
  onPromoted,
  onMissing,
  decorateOutgoingMessage,
}: {
  readonly target: SideChatTarget;
  readonly onPromoted: (target: SideChatTarget) => void;
  readonly onMissing: () => void;
  readonly decorateOutgoingMessage: () => ChatViewOutgoingMessageDecoration | null;
}) {
  const environmentId = EnvironmentId.make(target.environmentId);
  const threadId = ThreadId.make(target.threadId);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const draftId = target.kind === "draft" ? DraftId.make(target.draftId) : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const serverThread = useThreadShell(threadRef);
  const backgroundSubmissionPending = useBackgroundDraftSubmissionPending(
    target.kind === "draft" ? threadRef : null,
  );
  const shell = useEnvironmentQuery(environmentShell.stateAtom(environmentId));
  const bootstrapped = shell.data?.snapshot._tag === "Some";

  useEffect(() => {
    if (target.kind !== "draft") return;
    if (serverThread !== null && !draftSession?.promotedTo) markPromotedDraftThreadByRef(threadRef);
    const promoted = resolveDraftPromotionNavigationTarget({
      serverThreadRef: threadRef,
      serverThread,
      backgroundSubmissionPending,
    });
    if (promoted !== null) {
      onPromoted({
        kind: "server",
        environmentId: target.environmentId,
        threadId: target.threadId,
        viewKey: target.draftId,
      });
    }
  }, [
    backgroundSubmissionPending,
    draftSession?.promotedTo,
    onPromoted,
    serverThread,
    target,
    threadRef,
  ]);

  useEffect(() => {
    if (target.kind === "server" && threadShellHasStarted(serverThread)) {
      finalizePromotedDraftThreadByRef(threadRef);
    }
  }, [serverThread, target.kind, threadRef]);

  // A chat deleted elsewhere, or a draft the store dropped, goes back to the empty state.
  const missing =
    target.kind === "draft"
      ? draftSession === null && serverThread === null
      : bootstrapped && (serverThread === null || serverThread.archivedAt !== null);
  useEffect(() => {
    if (missing) onMissing();
  }, [missing, onMissing]);
  if (missing) return null;

  if (target.kind === "draft") {
    return (
      <ChatView
        key={target.draftId}
        compact
        decorateOutgoingMessage={decorateOutgoingMessage}
        environmentId={environmentId}
        threadId={threadId}
        routeKind="draft"
        draftId={DraftId.make(target.draftId)}
      />
    );
  }
  if (serverThread === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <ChatView
      key={target.viewKey}
      compact
      decorateOutgoingMessage={decorateOutgoingMessage}
      environmentId={environmentId}
      threadId={threadId}
      routeKind="server"
    />
  );
}
