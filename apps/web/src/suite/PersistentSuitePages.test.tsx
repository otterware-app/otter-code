// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  location: { pathname: "/mail", search: {} as { at?: string; url?: string } },
  environmentId: "env-a",
  navigate: vi.fn(),
  createHost: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => state.location,
  useNavigate: () => state.navigate,
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => state.environmentId }));
vi.mock("./SuiteAccountProvider", () => ({
  useSuiteAccount: () => ({ available: false, ensure: async () => {}, signOut: async () => {} }),
}));
vi.mock("./suitePageContext", () => ({ useSuitePageContext: () => {} }));
vi.mock("./mail/mailHost", () => ({ createOtterMailHost: state.createHost }));
vi.mock("./SuiteModuleLayout", () => ({
  SuiteModuleLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./drive/DrivePage", () => ({
  DrivePage: () => <input aria-label="Drive selection" defaultValue="document" />,
}));
import { PersistentSuitePages } from "./PersistentSuitePages";

let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.location = { pathname: "/mail", search: {} };
  state.environmentId = "env-a";
  state.navigate.mockClear();
  state.dispose.mockClear();
  state.createHost.mockReset().mockImplementation((options) => ({
    clientId: Math.random().toString(),
    dispose: state.dispose,
    cancelRequests: vi.fn(),
    ...options,
  }));
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
async function render(pathname: string, search: { at?: string; url?: string } = {}) {
  state.location = { pathname, search };
  await act(async () => {
    root.render(
      <PersistentSuitePages>
        <span>Route</span>
      </PersistentSuitePages>,
    );
  });
}
it("retains the exact Mail document and Drive selection across module routes", async () => {
  await render("/mail", { at: "/all/INBOX" });
  const frame = element.querySelector("iframe")!;
  const window = frame.contentWindow;
  await render("/drive");
  const selection = element.querySelector("input")!;
  selection.value = "retained";
  expect(element.querySelector('[data-suite-host="mail"]')?.hasAttribute("hidden")).toBe(true);
  await render("/calendar");
  await render("/mail");
  expect(element.querySelector("iframe")).toBe(frame);
  expect(frame.contentWindow).toBe(window);
  expect(frame.getAttribute("src")).toBe("/mail-frame.html#/all/INBOX");
  expect(state.createHost).toHaveBeenCalledTimes(1);
  expect(state.dispose).not.toHaveBeenCalled();
  expect(state.createHost.mock.results[0]!.value.cancelRequests).toHaveBeenCalled();
  await render("/drive");
  expect(element.querySelector("input")?.value).toBe("retained");
});
it("updates Mail deep links via hash and ignores hidden frame navigation", async () => {
  await render("/mail");
  const frame = element.querySelector("iframe")!;
  await render("/mail", { at: "/settings/accounts" });
  expect(frame.contentWindow?.location.hash).toBe("#/settings/accounts");
  const host = state.createHost.mock.calls[0]![0];
  await render("/calendar");
  await act(async () => {
    host.onNavigate("/all/INBOX");
  });
  expect(state.navigate).not.toHaveBeenCalled();
  await render("/mail");
  await act(async () => {
    host.onNavigate("/settings/general");
  });
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/mail",
    search: { at: "/settings/general" },
    replace: true,
  });
});
it("disposes the old Mail host when the environment changes", async () => {
  await render("/mail");
  const frame = element.querySelector("iframe");
  state.environmentId = "env-b";
  await render("/mail");
  expect(element.querySelector("iframe")).not.toBe(frame);
  expect(state.dispose).toHaveBeenCalledTimes(1);
  expect(state.createHost).toHaveBeenCalledTimes(2);
});
