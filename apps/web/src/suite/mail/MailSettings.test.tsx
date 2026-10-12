// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "env" }));
vi.mock("../useSuiteCapabilities", () => ({
  useSuiteCapabilities: () => ({ status: "available", capabilities: { modules: ["mail"] } }),
  suiteHasModule: () => true,
}));
vi.mock("./mailHost", () => ({ invokeMailChannel: state.invoke }));
vi.mock("../../components/settings/settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("../../components/settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({
    title,
    description,
    children,
    control,
  }: {
    title: string;
    description: string;
    children?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {children}
      {control}
    </div>
  ),
}));
vi.mock("../../components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
import { MailSettingsPanel } from "./MailSettings";
it("reads the same core once despite fresh capability objects and reports account/configuration status", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.invoke.mockImplementation(async (_environment, channel) =>
    channel === "gmail:listAccounts"
      ? [{ id: "a", email: "a@example.test", name: "A", signedOut: true }]
      : { configured: true, hasClientSecret: true, hasBuildClientSecret: false },
  );
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(<MailSettingsPanel />);
    });
    await act(async () => {
      root.render(<MailSettingsPanel />);
    });
    expect(state.invoke).toHaveBeenCalledTimes(2);
    expect(element.textContent).toContain("a@example.test");
    expect(element.textContent).toContain("Google: Sign in required");
    expect(element.textContent).toContain("Build: not included. Current server: configured.");
    expect(element.querySelectorAll("button")).toHaveLength(4);
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
