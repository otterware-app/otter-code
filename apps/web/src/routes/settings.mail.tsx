import { createFileRoute } from "@tanstack/react-router";
import { MailSettingsPanel } from "../suite/mail/MailSettings";

export const Route = createFileRoute("/settings/mail")({ component: MailSettingsPanel });
