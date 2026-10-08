/**
 * Mail's page content: Otter Mail's own renderer in a same-origin frame
 * (mail-frame.html, ./frame/entry.ts), talking to the primary environment
 * through the host this installs on `window.__otterMailHost`. Mail's route
 * (its hash) is mirrored into `/mail?at=` both ways, so Home and links can
 * open a conversation, and the open conversation is published for the side
 * chat.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useSuitePageContext } from "../suitePageContext";
import { createOtterMailHost, type OtterMailHostHandle } from "./mailHost";

import { mailPageRefs } from "./mailPageRefs";
import { useSuiteAccount } from "../SuiteAccountProvider";

const FRAME_PATH = "/mail-frame.html";

type Conversation = { readonly title: string; readonly path: string };

export function mailHref(path: string): string {
  return `/mail?at=${encodeURIComponent(path)}`;
}

function MailFrameForEnvironment({
  environmentId,
  at,
  onNavigate,
}: {
  readonly environmentId: EnvironmentId;
  readonly at: string | undefined;
  readonly onNavigate: (path: string) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const account = useSuiteAccount();
  const accountRef = useRef(account);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);
  const reportedRef = useRef<string | null>(at ?? "/");
  const onNavigateRef = useRef(onNavigate);
  useEffect(() => {
    onNavigateRef.current = onNavigate;
  }, [onNavigate]);
  const [path, setPath] = useState(at ?? "/");
  const [conversation, setConversation] = useState<Conversation | null>(null);

  // The frame's first route; later changes go through its hash, not a reload.
  const [src] = useState(() => `${FRAME_PATH}${at ? `#${at}` : ""}`);

  // Created before the frame renders: the frame reads it when its script runs.
  const [host, setHost] = useState<OtterMailHostHandle | null>(null);
  useEffect(() => {
    const created = createOtterMailHost({
      environmentId,
      account: {
        available: () => accountRef.current.available,
        ensure: () => accountRef.current.ensure(),
        signOut: () => accountRef.current.signOut(),
      },
      onNavigate: (path) => {
        reportedRef.current = path;
        setPath(path);
        onNavigateRef.current(path);
      },
      onShowing: setConversation,
    });
    window.__otterMailHost = created;
    setHost(created);
    return () => {
      created.dispose();
      if (window.__otterMailHost === created) delete window.__otterMailHost;
    };
  }, [environmentId]);

  // A link to /mail?at=… while Mail is open moves the frame there.
  useEffect(() => {
    if (host === null) return;
    const frameWindow = frameRef.current?.contentWindow;
    const target = at ?? "/";
    if (target === reportedRef.current || !frameWindow) return;
    reportedRef.current = target;
    frameWindow.location.hash = target;
  }, [at, host]);

  useSuitePageContext({
    module: "mail",
    title: conversation?.title ?? "Mail",
    refs: [
      ...mailPageRefs(path),
      ...(conversation
        ? [
            {
              kind: "mail.thread",
              id: conversation.path,
              label: conversation.title,
              href: mailHref(conversation.path),
            },
          ]
        : []),
    ],
  });

  if (host === null) return null;
  return (
    // oxlint-disable-next-line react/iframe-missing-sandbox -- Trusted Mail code needs scripts, storage, and the parent document bridge.
    <iframe
      key={host.clientId}
      ref={frameRef}
      title="Mail"
      src={src}
      className="min-h-0 w-full flex-1 border-0 bg-background"
      allow="clipboard-read; clipboard-write"
    />
  );
}

export function MailFrame({
  at,
  onNavigate,
}: {
  readonly at: string | undefined;
  readonly onNavigate: (path: string) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return <MailFrameForEnvironment environmentId={environmentId} at={at} onNavigate={onNavigate} />;
}
