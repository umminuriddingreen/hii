import { metricColor } from "../../lib/status";
import { pct } from "../../lib/format";

export function MetricBar({
  label,
  percent,
}: {
  label: string;
  percent: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 text-[10px] uppercase tracking-wide text-ink-faint">
        {label}
      </span>
      <div className="h-1 flex-1 rounded-full bg-edge-soft">
        <div
          className={`h-1 rounded-full ${metricColor(percent)}`}
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      <span className="w-8 text-right font-mono text-[10px] text-ink-dim">
        {pct(percent)}
      </span>
    </div>
  );
}
