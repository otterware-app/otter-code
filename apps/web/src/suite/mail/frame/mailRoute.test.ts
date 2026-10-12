import { describe, expect, it } from "vite-plus/test";

import { mailConversationFromPath } from "./mailRoute";

describe("mailConversationFromPath", () => {
  it("reads a conversation in an account's mailbox", () => {
    expect(mailConversationFromPath("/robin@otter.example/INBOX/190000000000004")).toEqual({
      accountId: "robin@otter.example",
      messageId: "190000000000004",
    });
  });

  it("takes the account from ?account= in the combined mailbox and views", () => {
    expect(mailConversationFromPath("/all/inbox/m1?account=sam%40acme.example&message=m2")).toEqual(
      { accountId: "sam@acme.example", messageId: "m2" },
    );
  });

  it("handles malformed encoded deep links", () => {
    expect(mailConversationFromPath("/%ZZ/INBOX/m1")).toBeNull();
  });

  it("is null for lists, settings and combined views without an account", () => {
    expect(mailConversationFromPath("/robin@otter.example/INBOX")).toBeNull();
    expect(mailConversationFromPath("/settings/general")).toBeNull();
    expect(mailConversationFromPath("/all/inbox/m1")).toBeNull();
    expect(mailConversationFromPath("/")).toBeNull();
  });
});
