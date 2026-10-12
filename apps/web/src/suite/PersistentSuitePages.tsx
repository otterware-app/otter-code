/** Mail and Drive survive route changes; each environment owns one retained host. */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePrimaryEnvironmentId } from "../state/environments";
import { DrivePage } from "./drive/DrivePage";
import { MailFrame } from "./mail/MailFrame";
import { SuiteModuleLayout } from "./SuiteModuleLayout";
import { SuitePageActivity } from "./SuitePageActivity";

function RetainedPages({ children }: { readonly children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const mailActive = location.pathname === "/mail";
  const driveActive = location.pathname === "/drive";
  const [visited, setVisited] = useState({ mail: mailActive, drive: driveActive });
  if ((mailActive && !visited.mail) || (driveActive && !visited.drive))
    setVisited({ mail: visited.mail || mailActive, drive: visited.drive || driveActive });
  const activeRef = useRef(mailActive);
  useEffect(() => {
    activeRef.current = mailActive;
  }, [mailActive]);
  const search = location.search as { at?: string; url?: string };
  return (
    <>
      {children}
      {visited.mail || mailActive ? (
        <SuitePageActivity.Provider value={mailActive}>
          <div
            hidden={!mailActive}
            className={mailActive ? "flex min-h-0 min-w-0 flex-1" : "hidden"}
            data-suite-host="mail"
          >
            <SuiteModuleLayout moduleId="mail">
              <MailFrame
                at={mailActive ? search.at : undefined}
                onNavigate={(path) => {
                  if (activeRef.current)
                    void navigate({ to: "/mail", search: { at: path }, replace: true });
                }}
              />
            </SuiteModuleLayout>
          </div>
        </SuitePageActivity.Provider>
      ) : null}
      {visited.drive || driveActive ? (
        <SuitePageActivity.Provider value={driveActive}>
          <div
            hidden={!driveActive}
            className={driveActive ? "flex min-h-0 min-w-0 flex-1" : "hidden"}
            data-suite-host="drive"
          >
            <DrivePage requestedUrl={driveActive ? (search.url ?? null) : null} />
          </div>
        </SuitePageActivity.Provider>
      ) : null}
    </>
  );
}

export function PersistentSuitePages({ children }: { readonly children: ReactNode }) {
  const environmentId = usePrimaryEnvironmentId();
  return <RetainedPages key={environmentId ?? "unpaired"}>{children}</RetainedPages>;
}
