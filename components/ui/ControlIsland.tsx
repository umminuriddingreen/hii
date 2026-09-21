'use client';

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import styles from './ControlIsland.module.css';

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export function ControlIsland({ className, compact = false, ...props }: HTMLAttributes<HTMLDivElement> & { compact?: boolean }) {
  return <div className={classes(styles.island, compact && styles.compact, className)} {...props} />;
}

export function ControlDivider({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span aria-hidden="true" className={classes(styles.divider, className)} {...props} />;
}

export const ControlButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  compact?: boolean;
  emphasis?: boolean;
  children: ReactNode;
}>(function ControlButton({ label, compact = false, emphasis = false, className, children, type = 'button', ...props }, ref) {
  return <button
    ref={ref}
    type={type}
    className={classes(styles.button, compact && styles.buttonCompact, className)}
    aria-label={label}
    title={label}
    data-emphasis={emphasis || undefined}
    {...props}
  >{children}</button>;
});
