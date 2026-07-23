import { useEffect, useRef } from "react";
import { X } from "lucide-react";

/**
 * Design-screenshot lightbox.
 *
 * Contract:
 *   • Backdrop click closes.
 *   • Escape closes via a single document-level listener. A duplicate
 *     backdrop onKeyDown would double-fire onClose because a real key
 *     event on the focused backdrop bubbles up to document.
 *   • Image click stays open (stopPropagation).
 *   • Close-button click closes exactly once (stopPropagation prevents the
 *     backdrop from double-firing onClose).
 *
 * Extracted from src/routes/_authenticated/design_.$projectId.tsx so the
 * regression test exercises the SAME component the route renders — a
 * copied toy component would stay green while the route silently
 * regressed.
 */
export type DesignLightboxItem = {
  name: string;
  url: string;
};

export function DesignLightbox({
  item,
  onClose,
}: {
  item: DesignLightboxItem;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Focus the backdrop so keyboard users don't need to tab in first.
    backdropRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Single global Escape path — no duplicate backdrop onKeyDown.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={backdropRef}
      data-testid="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${item.name} preview`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-6 outline-none"
      onClick={onClose}
    >
      <img
        data-testid="lightbox-image"
        src={item.url}
        alt={item.name}
        className="max-h-full max-w-full rounded-lg"
        // Clicks on the image content must NOT close the lightbox — only
        // backdrop click, Escape, or the close button should. Stopping
        // propagation here is what protects the "click on the picture
        // stays open" contract.
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        data-testid="lightbox-close"
        onClick={(e) => {
          // stopPropagation prevents the backdrop's onClick from
          // double-firing onClose after we've already closed here.
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-4 top-4 rounded-md bg-surface-1 p-2"
        aria-label="Close"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
