import { describe, expect, it } from "vite-plus/test";
import { mailPageRefs } from "./mailPageRefs";

describe("Mail side chat context", () => {
  it("includes the mailbox and label for lists and conversations", () => {
    expect(mailPageRefs("/demo%40otter.example/INBOX/m1")).toEqual([
      { kind: "mail.mailbox", id: "demo@otter.example", label: "demo@otter.example" },
      { kind: "mail.label", id: "INBOX", label: "INBOX" },
    ]);
    expect(mailPageRefs("/all/inbox")).toHaveLength(2);
  });
  it("does not mistake settings or malformed links for a mailbox", () => {
    expect(mailPageRefs("/settings/general")).toEqual([]);
    expect(mailPageRefs("/%zz/INBOX")).toEqual([]);
  });
});
