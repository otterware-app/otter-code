/**
 * The title band's pane toggles (Otter Mail's, after ChatGPT's and Linear's):
 * a soft frame in Lucide's strokes, so they sit with the rest of the icons.
 */

/** A side pane's toggle: the pane is a filled bar while open, a thin line while closed. */
export function PaneIcon({
  side,
  open,
  className,
}: {
  side: "left" | "right";
  open: boolean;
  className?: string;
}) {
  const x = side === "left" ? 8 : 16;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <rect x="3" y="4" width="18" height="16" rx="4" />
      {open ? (
        <rect
          x={x - 1.5}
          y="7.5"
          width="3"
          height="9"
          rx="1"
          fill="currentColor"
          strokeWidth="1.5"
        />
      ) : (
        <path d={`M${x} 8v8`} strokeWidth="1.5" />
      )}
    </svg>
  );
}

/** The thread details toggle: two items, each a dot and its line. */
export function DetailsIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <circle cx="6.5" cy="7.5" r="2.5" />
      <circle cx="6.5" cy="16.5" r="2.5" />
      <path d="M13 7.5h7M13 16.5h7" />
    </svg>
  );
}
