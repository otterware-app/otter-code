/**
 * What Otter Mail asks Google for when a Gmail account signs in (the desktop
 * app, and the relay for the web app). The iPhone app asks for less
 * (apps/ios GoogleAuth.swift): it has no calendar or contacts features.
 */
export const GMAIL_SCOPES = [
  "https://mail.google.com/",
  "openid",
  "email",
  "profile",
  // People API, for sender avatars. Tokens issued before these scopes were
  // added simply 403 on People calls (the avatar cascade skips to Gravatar);
  // re-adding the account upgrades its consent in place.
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  // Calendar, for answering invitations in place: events on calendars the user
  // owns (the invitation's copy on their primary calendar). Tokens granted the
  // broader calendar.events before work the same; older tokens lack both: RSVP
  // then falls back to an email reply; re-adding the account upgrades it.
  "https://www.googleapis.com/auth/calendar.events.owned",
  // Gmail settings, for editing signatures (they live in Gmail). Older tokens
  // can read them but not save them; re-adding the account upgrades it.
  "https://www.googleapis.com/auth/gmail.settings.basic",
];
