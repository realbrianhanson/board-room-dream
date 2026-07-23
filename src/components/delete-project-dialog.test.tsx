import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";

const projectName = "My Cool Project";

describe("DeleteProjectDialog", () => {
  it("cancel closes without calling onConfirm", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DeleteProjectDialog
        projectName={projectName}
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("confirm button stays disabled until the exact project name is typed", () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <DeleteProjectDialog
        projectName={projectName}
        open
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />,
    );
    const btn = screen.getByTestId("delete-project-confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("delete-project-name-input"), {
      target: { value: "wrong name" },
    });
    expect(btn.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("delete-project-name-input"), {
      target: { value: projectName },
    });
    expect(btn.disabled).toBe(false);
  });

  it("successful confirm calls onConfirm and closes", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(
      <DeleteProjectDialog
        projectName={projectName}
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.change(screen.getByTestId("delete-project-name-input"), {
      target: { value: projectName },
    });
    fireEvent.click(screen.getByTestId("delete-project-confirm"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("failure keeps the dialog open with a visible error message", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("permission denied"));
    const onOpenChange = vi.fn();
    render(
      <DeleteProjectDialog
        projectName={projectName}
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.change(screen.getByTestId("delete-project-name-input"), {
      target: { value: projectName },
    });
    fireEvent.click(screen.getByTestId("delete-project-confirm"));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
    // Dialog must NOT have been dismissed on failure.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
