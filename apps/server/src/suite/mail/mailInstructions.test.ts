import { expect, it } from "vite-plus/test";
import { MAIL_INSTRUCTIONS } from "./mailInstructions.ts";

it("retains Mail guidance only for exposed tools with suite names", () => {
  expect(MAIL_INSTRUCTIONS).toContain("mail_save_draft");
  expect(MAIL_INSTRUCTIONS).toContain("mail_save_view");
  expect(MAIL_INSTRUCTIONS).not.toContain("project");
  expect(MAIL_INSTRUCTIONS).toContain("only filters by labels");
  expect(MAIL_INSTRUCTIONS).not.toContain("list_events");
  expect(MAIL_INSTRUCTIONS).not.toContain("list_themes");
  expect(MAIL_INSTRUCTIONS).not.toContain("mailboxes or calendars");
});
