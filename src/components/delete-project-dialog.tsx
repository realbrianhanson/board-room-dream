import * as React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";

/**
 * Deliberate, destructive project-deletion confirmation. Replaces the
 * one-click native window.confirm() flow. The owner must type the exact
 * project name to enable the destructive action, mirroring the shadcn
 * AlertDialog pattern used elsewhere in the app. On failure the dialog
 * stays open with the error surfaced; only a successful onConfirm() removes
 * the underlying row.
 */
export function DeleteProjectDialog({
  projectName,
  open,
  onOpenChange,
  onConfirm,
}: {
  projectName: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setTyped("");
      setBusy(false);
      setErr(null);
    }
  }, [open]);

  const matches = typed.trim() === projectName.trim() && projectName.trim().length > 0;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return; // never dismiss mid-delete
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{projectName}” permanently?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the project along with every run, plan version,
            batch, audit, and screenshot attached to it. This cannot be undone.
            <br />
            <br />
            Type the project name{" "}
            <span className="font-mono text-foreground">{projectName}</span> to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          data-testid="delete-project-name-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={projectName}
          autoFocus
          disabled={busy}
          aria-label="Type project name to confirm"
        />
        {err ? (
          <p
            role="alert"
            className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {err}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="delete-project-confirm"
            disabled={!matches || busy}
            onClick={async (e) => {
              // Prevent Radix from auto-closing the dialog before we know
              // the delete succeeded — a database failure must keep the
              // dialog open with the error visible.
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch (ex) {
                setErr((ex as Error).message || "Delete failed");
              } finally {
                setBusy(false);
              }
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? "Deleting…" : "Delete permanently"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
