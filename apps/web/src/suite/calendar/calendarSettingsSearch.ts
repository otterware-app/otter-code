/** Settings search entries for Settings → Calendar, joined into `SETTINGS_SEARCH_ITEMS`. */
export const CALENDAR_SETTINGS_SEARCH_ITEMS = [
  {
    id: "calendar-accounts",
    title: "Calendar accounts",
    to: "/settings/calendar",
    searchTerms: ["google account add connect reconnect remove sign in calendar"],
  },
  {
    id: "calendar-google-client",
    title: "Calendar Google OAuth client",
    to: "/settings/calendar",
    searchTerms: ["calendar google sign-in oauth client id secret desktop app"],
  },
  {
    id: "calendar-demo-data",
    title: "Calendar demo data",
    to: "/settings/calendar",
    searchTerms: ["demo sample example accounts calendar explore"],
  },
  {
    id: "calendar-preferences",
    title: "Calendar preferences",
    to: "/settings/calendar",
    searchTerms: [
      "week starts monday sunday time zone working hours event length weekends declined 12 24 hour format default calendar",
    ],
  },
] as const;
