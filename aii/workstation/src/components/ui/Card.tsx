import type { HTMLAttributes } from "react";

export function Card({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-md border border-edge bg-panel p-3 ${className}`}
      {...props}
    />
  );
}
