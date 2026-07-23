import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { JourneyStage } from "@/lib/project-journey";
import type { UseProjectJourneyResult } from "@/hooks/use-project-journey";

export function ProjectJourney({
  stages,
  className,
}: {
  stages: JourneyStage[];
  className?: string;
}) {
  return (
    <ol className={cn("flex w-full flex-wrap items-center gap-y-2", className)}>
      {stages.map((s, i) => {
        const isLast = i === stages.length - 1;
        return (
          <li key={s.key} className="flex min-w-0 items-center">
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[9px] transition-colors",
                  s.state === "done" &&
                    "border-primary bg-primary text-primary-foreground",
                  s.state === "current" &&
                    "border-primary bg-primary/10 text-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.12)]",
                  s.state === "upcoming" &&
                    "border-border bg-surface-2 text-muted-foreground/70",
                )}
              >
                {s.state === "done" ? (
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={cn(
                  "font-mono text-[10px] uppercase tracking-[0.18em] transition-colors",
                  s.state === "done" && "text-foreground/70",
                  s.state === "current" && "font-semibold text-foreground",
                  s.state === "upcoming" && "text-muted-foreground/60",
                )}
              >
                {s.label}
              </span>
            </div>
            {!isLast && (
              <span
                className={cn(
                  "mx-2 h-px w-4 shrink-0 transition-colors",
                  s.state === "done" ? "bg-primary/60" : "bg-border",
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Renders the ProjectJourney strip with truthful loading/error states.
 * Journey is supplementary — an error surfaces as a small inline notice
 * with Retry and never blocks the primary page content.
 */
export function ProjectJourneyStrip({
  result,
  className,
}: {
  result: UseProjectJourneyResult;
  className?: string;
}) {
  if (result.loading) {
    return (
      <div
        aria-hidden
        className={cn("h-5 w-64 animate-pulse rounded-md bg-surface-2/60", className)}
      />
    );
  }
  if (result.error) {
    return (
      <div
        role="status"
        className={cn(
          "inline-flex items-center gap-3 rounded-md border border-border/60 bg-surface-1 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground",
          className,
        )}
      >
        Journey unavailable
        <button
          type="button"
          onClick={result.retry}
          className="rounded-sm border border-border px-2 py-0.5 text-[10px] normal-case tracking-normal text-foreground/80 hover:border-primary/40 hover:text-foreground"
        >
          Retry
        </button>
      </div>
    );
  }
  if (!result.stages) return null;
  return <ProjectJourney stages={result.stages} className={className} />;
}
