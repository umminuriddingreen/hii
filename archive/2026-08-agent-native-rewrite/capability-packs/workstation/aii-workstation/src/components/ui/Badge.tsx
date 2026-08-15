import type { HTMLAttributes } from "react";

export function Badge({
  className = "",
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-px text-[11px] font-medium whitespace-nowrap ${className}`}
      {...props}
    />
  );
}
