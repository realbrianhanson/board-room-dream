import type { ReactNode } from "react";

export function PlaceholderPage({
  eyebrow,
  title,
  description,
  actionLabel,
  onAction,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  onAction?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col justify-center px-6 py-16 md:px-12">
      <span className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
        {eyebrow}
      </span>
      <h1 className="mt-4 font-display text-5xl leading-tight text-foreground md:text-6xl">
        {title}
      </h1>
      <p className="mt-4 max-w-xl text-base text-muted-foreground">{description}</p>
      <div className="mt-8">
        <button
          onClick={onAction}
          className="inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
        >
          {actionLabel}
        </button>
      </div>
      {children}
    </div>
  );
}
