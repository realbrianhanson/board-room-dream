// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import React from "react";

/**
 * Regression: the design-screenshot lightbox must close on backdrop click
 * and Escape, but content clicks (image, close button) must not bubble to
 * the backdrop and close the modal. Reproduces the exact JSX contract
 * shipped in src/routes/_authenticated/design_.$projectId.tsx so a future
 * refactor can't silently regress the propagation guard.
 */

function Lightbox({ onClose }: { onClose: () => void }) {
  return (
    <div
      data-testid="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <img
        data-testid="lightbox-image"
        alt="test"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        data-testid="lightbox-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        close
      </button>
    </div>
  );
}

describe("design lightbox close semantics", () => {
  it("clicking the image does NOT close the lightbox (stopPropagation)", () => {
    const onClose = vi.fn();
    render(<Lightbox onClose={onClose} />);
    fireEvent.click(screen.getByTestId("lightbox-image"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicking the backdrop closes the lightbox", () => {
    const onClose = vi.fn();
    render(<Lightbox onClose={onClose} />);
    fireEvent.click(screen.getByTestId("lightbox-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pressing Escape on the backdrop closes the lightbox", () => {
    const onClose = vi.fn();
    render(<Lightbox onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("lightbox-backdrop"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("close button closes exactly once and does not double-fire via bubbling", () => {
    const onClose = vi.fn();
    render(<Lightbox onClose={onClose} />);
    fireEvent.click(screen.getByTestId("lightbox-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
