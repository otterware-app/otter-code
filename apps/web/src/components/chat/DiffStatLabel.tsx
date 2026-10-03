import { memo } from "react";
import { cn } from "~/lib/utils";

export function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

export function formatCompactDiffCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 999_500) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  if (value < 999_500_000) {
    const m = value / 1_000_000;
    return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}m`;
  }
  const b = value / 1_000_000_000;
  return `${b < 10 ? b.toFixed(1).replace(/\.0$/, "") : Math.round(b)}b`;
}

export const DiffStatLabel = memo(function DiffStatLabel(props: {
  additions: number;
  deletions: number;
  className?: string;
  layout?: "aligned" | "inline";
}) {
  const { additions, deletions, className, layout = "aligned" } = props;
  return (
    <span
      role="group"
      aria-label={`${additions} additions, ${deletions} deletions`}
      className={cn(
        layout === "inline"
          ? "inline-flex items-center gap-1 tabular-nums align-middle"
          : "inline-grid grid-cols-[4ch_4ch] gap-2 text-right tabular-nums align-middle",
        className,
      )}
    >
      {/* A zero side is left blank; aligned rows keep the empty cell so columns line up. */}
      {additions > 0 || layout === "aligned" ? (
        <span aria-hidden="true" className="font-mono text-diff-addition-foreground">
          {additions > 0 ? `+${formatCompactDiffCount(additions)}` : null}
        </span>
      ) : null}
      {deletions > 0 || layout === "aligned" ? (
        <span aria-hidden="true" className="font-mono text-diff-deletion-foreground">
          {deletions > 0 ? `-${formatCompactDiffCount(deletions)}` : null}
        </span>
      ) : null}
    </span>
  );
});
