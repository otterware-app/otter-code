import { beforeEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

import { useDiffPanelSessionStore, useDiffPanelStore } from "./diffPanelStore";

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      openFileByThreadKey: {},
      viewedByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });
  it("marks files viewed per review section and forgets them with the thread", () => {
    const store = useDiffPanelStore.getState();
    const mark = { version: 7, stat: "2:0" };
    store.setFileViewed(THREAD_REF, "branch", "src/a.ts", mark);
    store.setFileViewed(THREAD_REF, "branch", "src/b.ts", mark);
    store.setFileViewed(THREAD_REF, "branch", "src/b.ts", null);

    const threadViewed = Object.values(useDiffPanelStore.getState().viewedByThreadKey)[0];
    expect(threadViewed).toEqual({ branch: { "src/a.ts": mark } });

    store.removeThread(THREAD_REF);
    expect(useDiffPanelStore.getState().viewedByThreadKey).toEqual({});
  });

  it("keeps the state when the open file is opened again", () => {
    const store = useDiffPanelStore.getState();
    store.openFile(THREAD_REF, "turn:1", "src/a.ts");
    const opened = useDiffPanelStore.getState();

    store.openFile(THREAD_REF, "turn:1", "src/a.ts");
    expect(useDiffPanelStore.getState()).toBe(opened);

    store.openFile(THREAD_REF, "turn:1", "src/b.ts");
    expect(Object.values(useDiffPanelStore.getState().openFileByThreadKey)).toEqual([
      { scope: "turn:1", path: "src/b.ts" },
    ]);
  });
});
