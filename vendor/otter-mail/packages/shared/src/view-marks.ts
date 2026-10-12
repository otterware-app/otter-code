/**
 * What a view can wear in the rail instead of its initial: an icon (by its
 * key; apps/web draws each) or any emoji, in one of these colors (Apple's
 * tag colors, readable in light and dark). The app's picker and the agents'
 * view tools offer the same.
 */

export const VIEW_ICON_KEYS = [
  "star",
  "bookmark",
  "heart",
  "flag",
  "zap",
  "asterisk",
  "bell",
  "layers",
  "inbox",
  "archive",
  "folder",
  "tag",
  "mail",
  "at",
  "message",
  "users",
  "check",
  "tasks",
  "clipboard",
  "calendar",
  "briefcase",
  "building",
  "receipt",
  "money",
  "card",
  "shopping",
  "gift",
  "plane",
  "home",
  "coffee",
  "news",
  "book",
  "school",
  "code",
  "quote",
  "search",
  "idea",
  "sparkles",
  "music",
  "sun",
] as const;

export type ViewIconKey = (typeof VIEW_ICON_KEYS)[number];

export const VIEW_COLORS = {
  gray: "#8e8e93",
  red: "#ff3b30",
  orange: "#ff9500",
  yellow: "#ffcc00",
  green: "#34c759",
  teal: "#00c7be",
  blue: "#007aff",
  indigo: "#5856d6",
  purple: "#af52de",
  pink: "#ff2d55",
} as const;
