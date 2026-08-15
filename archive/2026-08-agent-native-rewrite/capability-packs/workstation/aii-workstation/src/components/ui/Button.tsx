import type { ButtonHTMLAttributes } from "react";

type Variant = "default" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  default:
    "bg-panel-2 border-edge text-ink hover:border-accent/50 hover:text-accent",
  ghost: "bg-transparent border-transparent text-ink-dim hover:text-ink",
  danger: "bg-panel-2 border-edge text-ink-dim hover:border-err/50 hover:text-err",
};

export function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`rounded border px-2.5 py-1 text-xs font-medium disabled:opacity-40 disabled:pointer-events-none ${variants[variant]} ${className}`}
      {...props}
    />
  );
}
