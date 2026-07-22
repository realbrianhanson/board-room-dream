import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { supabase } from "@/integrations/supabase/client";
import { BoardroomSession, DESIGN_RUBRIC } from "@/components/boardroom-session";
import { toast } from "sonner";
import { ArrowRight, Download, Palette, Upload, X } from "lucide-react";
import { ProjectJourney } from "@/components/project-journey";
import { useProjectJourney } from "@/hooks/use-project-journey";

export const Route = createFileRoute("/_authenticated/design_/$projectId")({
  component: DesignStudioPage,
});

const CONVENE_BLOCKED: Record<string, string> = {
  intake: "Finish the intake first.",
  killed: "This idea was killed.",
};

type Project = { id: string; name: string; user_id: string; status: string; is_import: boolean; github_repo: string | null };
type PlanVersion = {
  id: string;
  version: number;
  content_md: string;
  is_chair_ruled: boolean;
  locked_at: string;
  dissent_ledger: any;
};

function DesignStudioPage() {
  const { projectId } = Route.useParams();
  const journey = useProjectJourney(projectId);
  const [project, setProject] = useState<Project | null>(null);
  const [hasPlan, setHasPlan] = useState<boolean | null>(null);
  const [locked, setLocked] = useState<PlanVersion | null>(null);
  const [uid, setUid] = useState<string | null>(null);
  const [reconvening, setReconvening] = useState(false);
  

  const loadLocked = useCallback(async () => {
    const { data } = await supabase
      .from("plan_versions")
      .select("id, version, content_md, is_chair_ruled, locked_at, dissent_ledger")
      .eq("project_id", projectId)
      .eq("kind", "design")
      .eq("is_build_safe", true)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    setLocked((data as PlanVersion) ?? null);
  }, [projectId]);


  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      setUid(u.user?.id ?? null);
      const { data: p } = await supabase
        .from("projects")
        .select("id, name, user_id, status, is_import, github_repo")
        .eq("id", projectId)
        .maybeSingle();
      setProject((p as Project) ?? null);
      const { count } = await supabase
        .from("plan_versions")
        .select("id", { count: "exact", head: true })
        .eq("project_id", projectId)
        .eq("kind", "plan");
      setHasPlan((count ?? 0) > 0);

      await loadLocked();
    })();
  }, [projectId, loadLocked]);

  // Live-update locked design when a design run finalizes.
  useEffect(() => {
    const ch = supabase
      .channel(`design-locks:${projectId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "plan_versions", filter: `project_id=eq.${projectId}` },
        () => loadLocked(),
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [projectId, loadLocked]);

  const isOwner = !!uid && !!project && project.user_id === uid;

  async function reconvene() {
    setReconvening(true);
    try {
      const { data, error } = await supabase.functions.invoke("boardroom-orchestrator", {
        body: { action: "start_run", project_id: projectId, kind: "design" },
      });
      if (error) throw error;
      if ((data as any)?.no_key) {
        toast.error("Seat the board first — add your OpenRouter key in Settings.");
        return;
      }
      toast.success("The council reconvenes.");
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to reconvene");
    } finally {
      setReconvening(false);
    }
  }

  function downloadBrief() {
    if (!locked || !project) return;
    const blob = new Blob([locked.content_md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.name.replace(/\s+/g, "-").toLowerCase()}-design-v${locked.version}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!project || hasPlan === null) {
    return <div className="mx-auto max-w-6xl px-6 py-14"><div className="h-32 animate-pulse rounded-xl bg-surface-1" /></div>;
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 md:px-10 md:py-14">
      <div className="mb-8">
        <Link to="/design" className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground">
          ← Design
        </Link>
        <h1 className="mt-3 font-display text-3xl leading-tight text-foreground md:text-4xl">{project.name}</h1>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">The Design Council</p>
        {journey && (
          <div className="mt-4 mb-2">
            <ProjectJourney stages={journey} />
          </div>
        )}
      </div>

      {!hasPlan && !project.is_import ? (
        <div className="rounded-xl border border-dashed border-border bg-surface-1/40 px-8 py-20 text-center">
          <Palette className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-4 font-display text-2xl text-foreground">The board locks the plan before it debates the look.</p>
          <p className="mt-2 text-sm text-muted-foreground">Take this project through the Boardroom first.</p>
          <Link
            to="/boardroom/$projectId"
            params={{ projectId }}
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-all hover:brightness-110"
          >
            To the Boardroom <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      ) : (

        <>
          <BoardroomSession
            projectId={projectId}
            kind="design"
            rubric={DESIGN_RUBRIC}
            conveneLabel="Convene the Design Council"
            runningTitle="The Design Council"
            conveneBlockedByStatus={CONVENE_BLOCKED}
            emptyTitle="The council awaits."
            emptySubtitle="Convene the four seats and let them agree on a house style worth building."
          />


          {locked && (
            <section className="mt-12 rounded-xl border border-border bg-surface-1 p-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[hsl(38_65%_70%)]">
                    Design locked · v{locked.version}
                    {locked.is_chair_ruled && " · Chair ruled"}
                  </p>
                  <h2 className="mt-2 font-display text-2xl text-foreground">The house style.</h2>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={downloadBrief}
                    className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/40"
                  >
                    <Download className="h-4 w-4" /> Download
                  </button>
                  {isOwner && (
                    <button
                      onClick={reconvene}
                      disabled={reconvening}
                      className="inline-flex items-center gap-2 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm text-foreground transition-colors hover:border-primary/40 disabled:opacity-60"
                    >
                      {reconvening ? "Reconvening…" : "Reconvene the council"}
                    </button>
                  )}
                </div>
              </div>
              <div className="prose prose-invert mt-6 max-w-[65ch] prose-headings:font-display prose-headings:text-foreground prose-p:text-foreground/85 prose-code:font-mono prose-code:text-[13px]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{locked.content_md}</ReactMarkdown>
              </div>
            </section>
          )}

          {isOwner && (
            <ScreenshotsPanel projectId={projectId} userId={uid!} />
          )}
        </>
      )}

    </div>
  );
}

// -------- Screenshots --------

type ScreenshotItem = { name: string; path: string; url: string };

function ScreenshotsPanel({ projectId, userId }: { projectId: string; userId: string }) {
  const [items, setItems] = useState<ScreenshotItem[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [lightbox, setLightbox] = useState<ScreenshotItem | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const prefix = `${userId}/${projectId}`;

  const load = useCallback(async () => {
    const { data, error } = await supabase.storage.from("design-screenshots").list(prefix, {
      limit: 100,
      sortBy: { column: "created_at", order: "desc" },
    });
    if (error) {
      toast.error(error.message);
      setItems([]);
      return;
    }
    const files = (data ?? []).filter((f) => f.name && !f.name.endsWith("/"));
    const signed = await Promise.all(
      files.map(async (f) => {
        const path = `${prefix}/${f.name}`;
        const { data: s } = await supabase.storage
          .from("design-screenshots")
          .createSignedUrl(path, 60 * 60);
        return { name: f.name, path, url: s?.signedUrl ?? "" };
      }),
    );
    setItems(signed.filter((s) => s.url));
  }, [prefix]);

  useEffect(() => { load(); }, [load]);

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files);
    const valid = list.filter((f) => /^image\/(png|jpe?g|webp)$/i.test(f.type) && f.size <= 5 * 1024 * 1024);
    const rejected = list.length - valid.length;
    if (rejected) toast.error(`${rejected} file(s) skipped — png/jpg/webp, 5MB max.`);
    if (!valid.length) return;
    setUploading(true);
    try {
      for (const f of valid) {
        const ext = f.name.split(".").pop() ?? "png";
        const key = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error } = await supabase.storage.from("design-screenshots").upload(key, f, {
          contentType: f.type,
          upsert: false,
        });
        if (error) throw error;
      }
      await load();
      toast.success(`${valid.length} uploaded.`);
    } catch (err: any) {
      toast.error(err?.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function remove(item: ScreenshotItem) {
    const { error } = await supabase.storage.from("design-screenshots").remove([item.path]);
    if (error) { toast.error(error.message); return; }
    setLightbox((cur) => (cur?.path === item.path ? null : cur));
    load();
  }

  return (
    <section className="mt-12">
      <div className="mb-4">
        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">Screenshots</p>
        <h2 className="mt-2 font-display text-2xl text-foreground">Real pixels for the polish round.</h2>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
        }}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dragOver ? "border-primary/60 bg-surface-2" : "border-border bg-surface-1/40"
        }`}
      >
        <Upload className="mx-auto h-5 w-5 text-muted-foreground" />
        <p className="mt-3 text-sm text-foreground">
          Drop screens here, or{" "}
          <button
            onClick={() => inputRef.current?.click()}
            className="text-[hsl(38_65%_70%)] underline underline-offset-4"
          >
            choose files
          </button>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">PNG, JPG, WEBP · 5 MB max</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
        {uploading && <p className="mt-3 font-mono text-xs text-muted-foreground">Uploading…</p>}
      </div>

      <div className="mt-6">
        {items === null ? (
          <div className="h-32 animate-pulse rounded-xl bg-surface-1" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Upload screens once you start building — the council critiques real pixels in the polish round.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {items.map((it) => (
              <div key={it.path} className="group relative overflow-hidden rounded-lg border border-border bg-surface-1">
                <button
                  onClick={() => setLightbox(it)}
                  className="block h-full w-full"
                >
                  <img src={it.url} alt={it.name} className="aspect-video h-full w-full object-cover" loading="lazy" />
                </button>
                <button
                  onClick={() => remove(it)}
                  className="absolute right-2 top-2 rounded-md bg-background/80 p-1 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="Delete"
                >
                  <X className="h-3.5 w-3.5 text-foreground" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-6"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox.url} alt={lightbox.name} className="max-h-full max-w-full rounded-lg" />
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-4 top-4 rounded-md bg-surface-1 p-2"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </section>
  );
}
