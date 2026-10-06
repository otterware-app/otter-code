/**
 * Page context as a composer context record: the side chat (and Home's thread
 * starters) send what the user is looking at as a `suite-page` record plus a
 * leading reference link, so the transcript shows a chip and the provider
 * reads the payload in its `<t3_context>` envelope. Plain Otter Code decodes
 * the kind as an unknown record and keeps it, so threads stay readable there.
 */
import { ComposerContextId, type ComposerContextRecord, type ProjectId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import type { ReactNode } from "react";

import { ContextChipShell } from "../../components/contextChipParts";
import type { ChatViewOutgoingMessageDecoration } from "../../components/ChatView";
import { randomUUID } from "../../lib/utils";
import { SUITE_WEB_MODULES } from "../modules";
import type { SuitePageContext } from "../suitePageContext";

export const SUITE_PAGE_CONTEXT_KIND = "suite-page";

/** The chip label: "Calendar · Tuesday" or "Mail · Re: CORS for desktop". */
export function suitePageContextLabel(context: SuitePageContext): string {
  const moduleLabel =
    SUITE_WEB_MODULES.find((module) => module.id === context.module)?.label ?? context.module;
  const focus = context.refs[0]?.label ?? context.title;
  return focus && focus !== moduleLabel ? `${moduleLabel} · ${focus}` : moduleLabel;
}

/** One message's context: the page, what is selected on it, and optionally a Code project. */
export function suitePageContextDecoration(
  context: SuitePageContext,
  extra?: { readonly codeProjectId?: ProjectId | undefined },
): ChatViewOutgoingMessageDecoration {
  const contextId = ComposerContextId.make(`suite-page-${randomUUID().slice(0, 12)}`);
  const label = suitePageContextLabel(context);
  const record: ComposerContextRecord = {
    version: 1,
    contextId,
    kind: SUITE_PAGE_CONTEXT_KIND,
    label,
    payload: {
      module: context.module,
      title: context.title,
      refs: context.refs,
      ...(extra?.codeProjectId ? { codeProjectId: extra.codeProjectId } : {}),
    },
  };
  return {
    prefix: `${formatComposerContextReference({ kind: SUITE_PAGE_CONTEXT_KIND, contextId, label })} `,
    records: [record],
  };
}

/**
 * The transcript chip for a `suite-page` reference; null for other kinds so
 * the timeline's own fallback still handles them.
 */
export function renderSuitePageContextChip(
  kind: string,
  label: string,
  copyMarkdown: string,
): ReactNode | null {
  if (kind !== SUITE_PAGE_CONTEXT_KIND) return null;
  const module = SUITE_WEB_MODULES.find((entry) => label.startsWith(entry.label));
  const Icon = module?.icon ?? SUITE_WEB_MODULES[0]!.icon;
  return (
    <ContextChipShell
      kind="neutral"
      icon={<Icon />}
      label={label}
      aria-label={`Page context, ${label}`}
      data-markdown-copy={copyMarkdown}
      tooltip="What was on screen when this was sent. The agent can open it with the Otterware tools."
    />
  );
}
