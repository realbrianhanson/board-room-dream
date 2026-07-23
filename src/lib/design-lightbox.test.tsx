// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { DesignLightbox } from "@/components/design-lightbox";

/**
 * Regression tests exercise the SAME <DesignLightbox> component the design
 * route renders. Previously this file inlined a toy Lightbox that would
 * stay green if the production JSX regressed — that hazard is gone: the
 * route imports DesignLightbox from src/components/design-lightbox.tsx.
 */

afterEach(cleanup);

const item = { name: "hero", url: "blob:test" };

describe("DesignLightbox close semantics", () => {
  it("clicking the image does NOT close the lightbox (stopPropagation)", () => {
    const onClose = vi.fn();
    render(<DesignLightbox item={item} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("lightbox-image"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicking the backdrop closes the lightbox", () => {
    const onClose = vi.fn();
    render(<DesignLightbox item={item} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("lightbox-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pressing Escape on the backdrop closes the lightbox exactly once (no duplicate handler)", () => {
    const onClose = vi.fn();
    render(<DesignLightbox item={item} onClose={onClose} />);
    // Fire Escape on the focused backdrop. If a React onKeyDown were
    // still attached alongside the document listener, the event would
    // bubble and onClose would fire twice.
    fireEvent.keyDown(screen.getByTestId("lightbox-backdrop"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("close button closes exactly once and does not double-fire via bubbling", () => {
    const onClose = vi.fn();
    render(<DesignLightbox item={item} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("lightbox-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
