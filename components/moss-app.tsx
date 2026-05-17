"use client";

/* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

import dynamic from "next/dynamic";
import Link from "next/link";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import type { OnMount } from "@monaco-editor/react";
import {
  AlertCircle,
  AlertTriangle,
  Braces,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  FileDown,
  FilePlus2,
  FolderPlus,
  ImagePlus,
  Info,
  Library,
  ListTree,
  LogOut,
  Minus,
  PanelRight,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Sigma,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EquationEditor } from "@/components/equation-editor";
import { LatexVisualEditor } from "@/components/latex-visual-editor";
import { PdfPreview, type PdfTextHit } from "@/components/pdf-preview";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { compileProject } from "@/lib/compiler";
import { compileProjectRemotely, isRemoteCompilerConfigured, reverseSynctex } from "@/lib/remote-compiler";
import {
  BINARY_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MAX_PROJECT_BYTES,
  MAX_UPLOAD_BYTES,
  TEXT_EXTENSIONS,
  buildProjectZip,
  downloadBlob,
  downloadText,
  extensionFor,
  kindForPath,
  normalizePath,
  storagePathFor,
} from "@/lib/file-utils";
import { sampleBibtex, sampleDiagramPngBase64, sampleLatex, sampleNotesLatex } from "@/lib/moss-sample";
import { lintLatex, parseLatexLogIssues, type LatexLintDiagnostic, type LatexLogIssue } from "@/lib/latex-lint";
import { repairCommonLatexSerializationDamage } from "@/lib/latex-repair";
import { parseFileSections } from "@/lib/sections";
import { PROJECT_ASSETS_BUCKET, isSupabaseConfigured, supabase } from "@/lib/supabase";
import type { Citation, CompileDiagnostic, CompileResult, Project, ProjectFile, SectionRecord, SessionUser } from "@/lib/types";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

const textFileKinds = new Set(["tex", "bib", "style", "class", "bst", "asset"]);
const AUTO_COMPILE_DEBOUNCE_MS = 2500;

type CompileTrigger = "manual" | "auto";

export default function MossApp() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [activePath, setActivePath] = useState("main.tex");
  const [editorValue, setEditorValue] = useState("");
  const [editorRevision, setEditorRevision] = useState(0);
  const [sections, setSections] = useState<SectionRecord[]>([]);
  const [citations, setCitations] = useState<Citation[]>([]);
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [assetPreviewUrl, setAssetPreviewUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newFilePath, setNewFilePath] = useState("sections/introduction.tex");
  const [newFolderPath, setNewFolderPath] = useState("figures");
  const [newCitationKey, setNewCitationKey] = useState("sample2026");
  const [newCitationBibtex, setNewCitationBibtex] = useState("");
  const [equationLatex, setEquationLatex] = useState("\\int_0^1 x^2\\,dx = \\frac{1}{3}");
  const [rightPanel, setRightPanel] = useState<"preview" | "logs" | "sections" | "citations" | "equation">("preview");
  const [editorMode, setEditorMode] = useState<"code" | "visual">("code");
  const [previewZoom, setPreviewZoom] = useState(100);
  const [previewPageCount, setPreviewPageCount] = useState(0);
  const [autoCompile, setAutoCompile] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textFileInputRef = useRef<HTMLInputElement | null>(null);
  const projectFileInputRef = useRef<HTMLInputElement | null>(null);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const autoCompileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compilingRef = useRef(false);
  const queuedAutoCompileRef = useRef(false);
  const lastAutoScheduledSignatureRef = useRef("");
  const lastCompileSignatureRef = useRef("");
  const maintainedProjectRefs = useRef(new Set<string>());
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const pendingPreviewJumpRef = useRef("");
  const pendingSourceLocationRef = useRef<{ filePath: string; line: number; column: number } | null>(null);
  const [visualPreviewJump, setVisualPreviewJump] = useState("");

  const activeFile = useMemo(
    () => files.find((file) => file.path === activePath) ?? null,
    [activePath, files],
  );

  const projectBytes = useMemo(
    () => files.reduce((total, file) => total + Number(file.size_bytes || 0), 0),
    [files],
  );
  const logIssues = useMemo(
    () => {
      const structured = compileResult?.structuredDiagnostics ?? [];
      return structured.length ? structured.map(compileDiagnosticToLogIssue) : parseLatexLogIssues(compileResult?.log ?? "");
    },
    [compileResult?.log, compileResult?.structuredDiagnostics],
  );
  const htmlPreviewScale = previewZoom / 100;
  const htmlPreviewHeight = Math.max(1040, (compileResult?.pageCount ?? 1) * 1090);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }

    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ? { id: data.user.id, email: data.user.email } : null);
      setLoading(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ? { id: session.user.id, email: session.user.email } : null);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setProjects([]);
      setActiveProject(null);
      setFiles([]);
      return;
    }
    void loadProjects(user.id);
  }, [user]);

  useEffect(() => {
    if (!activeProject) return;
    void loadProjectData(activeProject);
  }, [activeProject?.id]);

  useEffect(() => {
    const file = files.find((item) => item.path === activePath);
    setEditorValue(file?.content_text ?? "");
    setEditorRevision(0);
  }, [activePath, files]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";

    async function loadPreview() {
      if (!activeFile || activeFile.kind !== "image") {
        setAssetPreviewUrl("");
        return;
      }

      try {
        const blob = await loadAssetBlob(activeFile, supabase);
        if (!blob || cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setAssetPreviewUrl(objectUrl);
      } catch (error) {
        if (!cancelled) {
          setAssetPreviewUrl("");
          toast.error(error instanceof Error ? error.message : "Could not load image preview");
        }
      }
    }

    void loadPreview();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activeFile?.id, activeFile?.storage_path, activeFile?.public_url, activeFile?.updated_at]);

  useEffect(() => {
    if (!autoCompile || !activeProject || !activeFile || activeFile.content_text === null || editorRevision === 0) return;
    const isLatexFile = activeFile.kind === "tex" || activeFile.kind === "style" || activeFile.kind === "class";
    if (isLatexFile && lintLatex(editorValue).some((diagnostic) => diagnostic.severity === "error")) return;

    const compileFiles = files.map((file) => (file.id === activeFile.id ? { ...file, content_text: editorValue } : file));
    const pendingSignature = compileSignature(activeProject, compileFiles);
    if (pendingSignature === lastCompileSignatureRef.current || pendingSignature === lastAutoScheduledSignatureRef.current) return;
    lastAutoScheduledSignatureRef.current = pendingSignature;

    if (autoCompileTimerRef.current) clearTimeout(autoCompileTimerRef.current);
    autoCompileTimerRef.current = setTimeout(() => {
      void runCompile("auto");
    }, AUTO_COMPILE_DEBOUNCE_MS);

    return () => {
      if (autoCompileTimerRef.current) clearTimeout(autoCompileTimerRef.current);
    };
  }, [autoCompile, activeProject?.id, activePath, editorRevision]);

  useEffect(() => {
    projectFileInputRef.current?.setAttribute("webkitdirectory", "");
    projectFileInputRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    function handlePreviewMessage(event: MessageEvent) {
      if (event.source !== previewFrameRef.current?.contentWindow) return;
      if (!event.data || event.data.type !== "moss-preview-word") return;
      jumpToSourceText(String(event.data.text ?? ""));
    }

    window.addEventListener("message", handlePreviewMessage);
    return () => window.removeEventListener("message", handlePreviewMessage);
  }, [files, activePath, editorValue]);

  useEffect(() => {
    if (editorMode !== "code" || !pendingPreviewJumpRef.current) return;
    const search = pendingPreviewJumpRef.current;
    const timer = window.setTimeout(() => {
      if (performEditorJump(search)) pendingPreviewJumpRef.current = "";
    }, 50);
    return () => window.clearTimeout(timer);
  }, [editorMode, activePath, editorValue]);

  useEffect(() => {
    if (editorMode !== "code" || !pendingSourceLocationRef.current) return;
    const timer = window.setTimeout(() => {
      if (performLineJump(pendingSourceLocationRef.current)) pendingSourceLocationRef.current = null;
    }, 50);
    return () => window.clearTimeout(timer);
  }, [editorMode, activePath, editorValue]);

  useEffect(() => {
    updateLatexMarkers();
  }, [activeFile?.id, activeFile?.kind, activePath, compileResult?.log, compileResult?.structuredDiagnostics, editorMode, editorValue]);

  useEffect(() => {
    if (editorMode !== "visual" || !pendingPreviewJumpRef.current) return;
    setVisualPreviewJump(pendingPreviewJumpRef.current);
  }, [editorMode, activePath, editorValue]);

  async function loadProjects(userId: string) {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) {
      toast.error(error.message);
      return;
    }
    setProjects(data ?? []);
    if (!activeProject && data?.[0]) setActiveProject(data[0]);
  }

  async function loadProjectData(project: Project) {
    if (!supabase) return;
    const [fileResult, sectionResult, citationResult] = await Promise.all([
      supabase.from("project_files").select("*").eq("project_id", project.id).order("path"),
      supabase.from("sections").select("*").eq("project_id", project.id).order("order_index"),
      supabase.from("citations").select("*").eq("project_id", project.id).order("cite_key"),
    ]);

    if (fileResult.error) toast.error(fileResult.error.message);
    if (sectionResult.error) toast.error(sectionResult.error.message);
    if (citationResult.error) toast.error(citationResult.error.message);

    const loadedFiles = fileResult.data ?? [];
    setFiles(loadedFiles);
    setSections(sectionResult.data ?? []);
    setCitations(citationResult.data ?? []);
    setActivePath(project.root_file_path || loadedFiles[0]?.path || "main.tex");
  }

  async function createProject() {
    if (!supabase || !user) return;
    const title = `Moss Draft ${projects.length + 1}`;
    const { data: project, error } = await supabase
      .from("projects")
      .insert({ title, root_file_path: "main.tex", user_id: user.id })
      .select()
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    const starterFiles = [
      { path: "main.tex", kind: "tex", content_text: sampleLatex, mime_type: "text/x-tex", size_bytes: new Blob([sampleLatex]).size },
      { path: "references.bib", kind: "bib", content_text: sampleBibtex, mime_type: "text/x-bibtex", size_bytes: new Blob([sampleBibtex]).size },
      { path: "sections/notes.tex", kind: "tex", content_text: sampleNotesLatex, mime_type: "text/x-tex", size_bytes: new Blob([sampleNotesLatex]).size },
    ];
    const { error: fileError } = await supabase.from("project_files").insert(
      starterFiles.map((file) => ({
        project_id: project.id,
        user_id: user.id,
        ...file,
      })),
    );
    if (fileError) {
      toast.error(fileError.message);
      return;
    }
    await supabase.from("citations").insert({
      project_id: project.id,
      user_id: user.id,
      cite_key: "moss2026",
      bibtex: sampleBibtex,
      csl_json: {
        type: "article-journal",
        title: "Moss: A Browser Based LaTeX Editing Prototype",
        author: [{ family: "Rodrigues", given: "Ethan" }],
        issued: { "date-parts": [[2026]] },
      },
      tags: ["sample"],
    });
    setProjects((current) => [project, ...current]);
    setActiveProject(project);
    toast.success("Project created");
  }

  async function saveActiveFile(options?: { silent?: boolean }) {
    if (!supabase || !activeFile || !textFileKinds.has(activeFile.kind)) return false;
    setSaving(true);
    const { error } = await supabase
      .from("project_files")
      .update({
        content_text: editorValue,
        size_bytes: new Blob([editorValue]).size,
      })
      .eq("id", activeFile.id);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return false;
    }
    setFiles((current) =>
      current.map((file) =>
        file.id === activeFile.id
          ? { ...file, content_text: editorValue, size_bytes: new Blob([editorValue]).size }
          : file,
      ),
    );
    await syncSections(activeFile, editorValue);
    if (!options?.silent) toast.success("Saved");
    return true;
  }

  async function syncSections(file: ProjectFile, content: string) {
    if (!supabase || !activeProject || !user || file.kind !== "tex") return;
    const parsed = await parseFileSections({ ...file, content_text: content });
    if (parsed.length === 0) {
      await supabase.from("sections").delete().eq("file_id", file.id);
      setSections((current) => current.filter((section) => section.file_id !== file.id));
      return;
    }
    const rows = parsed.map((section) => ({
      project_id: activeProject.id,
      file_id: file.id,
      user_id: user.id,
      section_key: section.sectionKey,
      file_path: section.filePath,
      heading: section.heading,
      level: section.level,
      order_index: section.orderIndex,
      content_hash: section.contentHash,
      source_start: section.sourceStart,
      source_end: section.sourceEnd,
      source_text: section.sourceText,
    }));
    const { data, error } = await supabase
      .from("sections")
      .upsert(rows, { onConflict: "project_id,file_id,section_key" })
      .select("*");
    if (error) {
      toast.error(error.message);
      return;
    }
    const liveKeys = new Set(parsed.map((section) => section.sectionKey));
    const { error: staleError } = await supabase
      .from("sections")
      .delete()
      .eq("file_id", file.id)
      .not("section_key", "in", `(${Array.from(liveKeys).map(escapePostgrestListValue).join(",")})`);
    if (staleError) toast.error(staleError.message);
    setSections((current) => [
      ...current.filter((section) => section.file_id !== file.id),
      ...((data as SectionRecord[]) ?? []),
    ]);
  }

  async function syncProjectSections(projectFiles: ProjectFile[]) {
    for (const file of projectFiles) {
      if (file.kind === "tex" && file.content_text !== null) {
        await syncSections(file, file.content_text);
      }
    }
  }

  async function createTextFile() {
    if (!supabase || !activeProject || !user) return;
    const path = normalizePath(newFilePath);
    const ext = extensionFor(path);
    if (!TEXT_EXTENSIONS.has(ext)) {
      toast.error("Use .tex, .ltx, .latex, .bib, .sty, .cls, .bst, or .txt for text files.");
      return;
    }
    const content = ext === "tex" ? "\\section{New Section}\nStart writing here.\n" : "";
    const { data, error } = await supabase
      .from("project_files")
      .insert({
        project_id: activeProject.id,
        user_id: user.id,
        path,
        kind: kindForPath(path),
        content_text: content,
        mime_type: "text/plain",
        size_bytes: new Blob([content]).size,
      })
      .select()
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    setFiles((current) => [...current, data].sort((a, b) => a.path.localeCompare(b.path)));
    if (data.kind === "tex") await syncSections(data, content);
    setActivePath(path);
  }

  async function uploadTextFile(event: ChangeEvent<HTMLInputElement>) {
    if (!supabase || !activeProject || !user) return;
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    await importFiles(selectedFiles, "text");
  }

  async function createFolder() {
    if (!supabase || !activeProject || !user) return;
    const path = normalizePath(newFolderPath);
    const { data, error } = await supabase
      .from("project_files")
      .insert({
        project_id: activeProject.id,
        user_id: user.id,
        path,
        kind: "folder",
        mime_type: "inode/directory",
      })
      .select()
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    setFiles((current) => [...current, data].sort((a, b) => a.path.localeCompare(b.path)));
  }

  async function uploadAsset(event: ChangeEvent<HTMLInputElement>) {
    if (!supabase || !activeProject || !user) return;
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    await importFiles(selectedFiles, "asset");
  }

  async function uploadProjectFolder(event: ChangeEvent<HTMLInputElement>) {
    if (!supabase || !activeProject || !user) return;
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    await importFiles(selectedFiles, "mixed");
  }

  async function importFiles(selectedFiles: File[], mode: "text" | "asset" | "mixed") {
    if (!supabase || !activeProject || !user || selectedFiles.length === 0) return;
    if (selectedFiles.some((file) => file.size > MAX_UPLOAD_BYTES)) {
      toast.error("Upload limit is 50 MB per file.");
      return;
    }
    const selectedBytes = selectedFiles.reduce((total, file) => total + file.size, 0);
    if (projectBytes + selectedBytes > MAX_PROJECT_BYTES) {
      toast.error("Project limit is 100 MB for v1.");
      return;
    }

    const pathEntries = uploadPathEntries(selectedFiles, mode);
    const importedFiles: ProjectFile[] = [];
    let skipped = 0;

    for (let index = 0; index < selectedFiles.length; index += 1) {
      const file = selectedFiles[index];
      const path = pathEntries[index];
      if (!path) {
        skipped += 1;
        continue;
      }
      const ext = extensionFor(path);
      const isText = TEXT_EXTENSIONS.has(ext);
      const isBinary = BINARY_EXTENSIONS.has(ext);

      if ((mode === "text" && !isText) || (mode === "asset" && !isBinary) || (mode === "mixed" && !isText && !isBinary)) {
        skipped += 1;
        continue;
      }

      const previous = files.find((item) => item.path === path);
      if (isText) {
        if (previous?.storage_path) {
          await supabase.storage.from(PROJECT_ASSETS_BUCKET).remove([previous.storage_path]);
        }
        const content = await file.text();
        const { data, error } = await supabase
          .from("project_files")
          .upsert(
            {
              project_id: activeProject.id,
              user_id: user.id,
              path,
              kind: kindForPath(path),
              content_text: content,
              storage_path: null,
              storage_provider: "supabase",
              storage_key: null,
              public_url: null,
              mime_type: file.type || (ext === "bib" ? "text/x-bibtex" : "text/x-tex"),
              size_bytes: new Blob([content]).size,
            },
            { onConflict: "project_id,path" },
          )
          .select()
          .single();
        if (error) {
          toast.error(error.message);
          continue;
        }
        importedFiles.push(data);
        if (data.kind === "tex") await syncSections(data, content);
        continue;
      }

      const storagePath = storagePathFor(user.id, activeProject.id, path);
      const upload = await supabase.storage.from(PROJECT_ASSETS_BUCKET).upload(storagePath, file, {
        upsert: true,
        contentType: file.type || "application/octet-stream",
      });
      if (upload.error) {
        toast.error(upload.error.message);
        continue;
      }
      const { data, error } = await supabase
        .from("project_files")
        .upsert(
          {
            project_id: activeProject.id,
            user_id: user.id,
            path,
            kind: kindForPath(path),
            content_text: null,
            storage_path: storagePath,
            storage_provider: "supabase",
            storage_key: storagePath,
            public_url: null,
            mime_type: file.type || "application/octet-stream",
            size_bytes: file.size,
          },
          { onConflict: "project_id,path" },
        )
        .select()
        .single();
      if (error) {
        toast.error(error.message);
        continue;
      }
      importedFiles.push(data);
    }

    if (importedFiles.length) {
      setFiles((current) => [
        ...current.filter((item) => !importedFiles.some((imported) => imported.path === item.path)),
        ...importedFiles,
      ].sort((a, b) => a.path.localeCompare(b.path)));
      setActivePath(importedFiles.find((file) => file.path === activeProject.root_file_path)?.path ?? importedFiles.find((file) => file.kind === "tex")?.path ?? importedFiles[0].path);
      toast.success(skipped ? `Imported ${importedFiles.length} files, skipped ${skipped}` : `Imported ${importedFiles.length} files`);
    } else {
      toast.error("No supported files found.");
    }
  }

  async function deleteActiveFile() {
    if (!supabase || !activeFile) return;
    if (activeFile.storage_path && activeFile.storage_provider === "supabase") {
      await supabase.storage.from(PROJECT_ASSETS_BUCKET).remove([activeFile.storage_path]);
    }
    const { error } = await supabase.from("project_files").delete().eq("id", activeFile.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    const remaining = files.filter((file) => file.id !== activeFile.id);
    setFiles(remaining);
    setActivePath(remaining[0]?.path ?? "main.tex");
  }

  async function runCompile(trigger: CompileTrigger = "manual") {
    if (!activeProject) return;
    if (compilingRef.current) {
      if (trigger === "auto") queuedAutoCompileRef.current = true;
      return;
    }

    let compileFiles = files.map((file) => (file.id === activeFile?.id ? { ...file, content_text: editorValue } : file));
    const incomingSignature = compileSignature(activeProject, compileFiles);
    if (trigger === "auto" && incomingSignature === lastCompileSignatureRef.current) return;

    const isLatexFile = activeFile?.kind === "tex" || activeFile?.kind === "style" || activeFile?.kind === "class";
    if (trigger === "auto" && isLatexFile && lintLatex(editorValue).some((diagnostic) => diagnostic.severity === "error")) return;

    compilingRef.current = true;
    setCompiling(true);
    try {
      await saveActiveFile({ silent: true });
      setPreviewPageCount(0);
      let repairedActiveValue = editorValue;
      let repairedAnyFile = false;
      compileFiles = compileFiles.map((file) => {
        if (file.content_text === null || !textFileKinds.has(file.kind)) return file;
        const repaired = repairCommonLatexSerializationDamage(file.content_text);
        if (repaired === file.content_text) return file;
        repairedAnyFile = true;
        if (file.id === activeFile?.id) repairedActiveValue = repaired;
        return { ...file, content_text: repaired, size_bytes: new Blob([repaired]).size };
      });
      if (repairedAnyFile) {
        setFiles(compileFiles);
        if (repairedActiveValue !== editorValue) {
          setEditorValue(repairedActiveValue);
          if (supabase && activeFile) {
            await supabase
              .from("project_files")
              .update({ content_text: repairedActiveValue, size_bytes: new Blob([repairedActiveValue]).size })
              .eq("id", activeFile.id);
          }
        }
        if (trigger === "manual") toast.info("Repaired LaTeX table syntax");
      }
      compileFiles = await maintainSampleProjectFiles(compileFiles, trigger);
      await syncProjectSections(compileFiles);
      lastCompileSignatureRef.current = compileSignature(activeProject, compileFiles);
      lastAutoScheduledSignatureRef.current = lastCompileSignatureRef.current;
      const result = isRemoteCompilerConfigured
        ? await compileProjectRemotely(activeProject, compileFiles, loadStorageFileForCompile)
        : await compileProject(activeProject, compileFiles, await buildImagePreviewUrls(compileFiles));
      setCompileResult(result);
      if (result.ok) {
        setRightPanel("preview");
        if (trigger === "manual") toast.success("Recompiled");
      } else {
        if (trigger === "manual") {
          setRightPanel("logs");
          toast.error("Compile failed");
        }
      }
    } catch (error) {
      if (trigger === "manual") setRightPanel("logs");
      setCompileResult({
        ok: false,
        log: error instanceof Error ? error.message : "Compile failed.",
        diagnostics: ["Compile failed"],
      });
      if (trigger === "manual") toast.error("Compile failed");
    } finally {
      compilingRef.current = false;
      setCompiling(false);
      if (queuedAutoCompileRef.current && autoCompile && editorRevision > 0) {
        queuedAutoCompileRef.current = false;
        if (autoCompileTimerRef.current) clearTimeout(autoCompileTimerRef.current);
        autoCompileTimerRef.current = setTimeout(() => {
          void runCompile("auto");
        }, AUTO_COMPILE_DEBOUNCE_MS);
      }
    }
  }

  async function downloadZip() {
    if (!activeProject) return;
    try {
      const { blob, filename } = await buildProjectZip(activeProject, files);
      downloadBlob(blob, filename);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build ZIP");
    }
  }

  async function buildImagePreviewUrls(projectFiles: ProjectFile[]) {
    const client = supabase;
    if (!client) return {};
    const entries = await Promise.all(
      projectFiles
        .filter((file) => (file.storage_path || file.public_url) && IMAGE_EXTENSIONS.has(extensionFor(file.path)))
        .map(async (file) => {
          const blob = await loadAssetBlob(file, client);
          if (!blob) return null;
          return [file.path, await blobToDataUrl(blob)] as const;
        }),
    );
    return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
  }

  async function maintainSampleProjectFiles(projectFiles: ProjectFile[], trigger: CompileTrigger) {
    if (!activeProject) return projectFiles;
    const maintenanceKey = `${activeProject.id}:${compileSignature(activeProject, projectFiles)}`;
    if (trigger === "auto" && maintainedProjectRefs.current.has(maintenanceKey)) return projectFiles;

    let updatedFiles = await ensureSampleDiagramAsset(projectFiles, trigger);
    updatedFiles = await ensureSampleNotesFile(updatedFiles, trigger);
    maintainedProjectRefs.current.add(maintenanceKey);
    return updatedFiles;
  }

  async function ensureSampleDiagramAsset(projectFiles: ProjectFile[], trigger: CompileTrigger) {
    if (!supabase || !activeProject || !user) return projectFiles;
    const samplePath = "figures/diagram.png";
    const referencesSampleDiagram = projectFiles.some((file) => file.content_text?.includes(samplePath));
    const existingSampleDiagram = projectFiles.find((file) => file.path === samplePath);
    const shouldRefreshPresetDiagram = Boolean(
      existingSampleDiagram
      && existingSampleDiagram.storage_provider === "supabase"
      && existingSampleDiagram.mime_type === "image/png"
      && existingSampleDiagram.size_bytes <= 100,
    );
    if (!referencesSampleDiagram || (existingSampleDiagram && !shouldRefreshPresetDiagram)) return projectFiles;

    const blob = base64ToBlob(sampleDiagramPngBase64, "image/png");
    const storagePath = existingSampleDiagram?.storage_path ?? storagePathFor(user.id, activeProject.id, samplePath);
    const upload = await supabase.storage.from(PROJECT_ASSETS_BUCKET).upload(storagePath, blob, {
      contentType: "image/png",
      upsert: true,
    });
    if (upload.error) {
      toast.error(upload.error.message);
      return projectFiles;
    }

    const { data, error } = await supabase
      .from("project_files")
      .upsert(
        {
          project_id: activeProject.id,
          user_id: user.id,
          path: samplePath,
          kind: "image",
          content_text: null,
          storage_path: storagePath,
          storage_provider: "supabase",
          storage_key: storagePath,
          public_url: null,
          mime_type: "image/png",
          size_bytes: blob.size,
        },
        { onConflict: "project_id,path" },
      )
      .select()
      .single();

    if (error) {
      toast.error(error.message);
      return projectFiles;
    }

    const updatedFiles = [
      ...projectFiles.filter((file) => file.path !== samplePath),
      data,
    ].sort((a, b) => a.path.localeCompare(b.path));
    setFiles(updatedFiles);
    if (trigger === "manual") toast.success(shouldRefreshPresetDiagram ? "Refreshed sample diagram" : "Added sample diagram");
    return updatedFiles;
  }

  async function ensureSampleNotesFile(projectFiles: ProjectFile[], trigger: CompileTrigger) {
    if (!supabase || !activeProject || !user) return projectFiles;
    const referencesSampleNotes = projectFiles.some((file) => /\\input\{sections\/notes(?:\.tex)?\}/.test(file.content_text ?? ""));
    if (!referencesSampleNotes) return projectFiles;

    const notesFile = projectFiles.find((file) => file.path === "sections/notes.tex" || file.path === "sections/notes");
    const staleSampleNotes = Boolean(notesFile?.content_text?.includes("\\documentclass") && notesFile.content_text.includes("Moss Sample IEEE Paper"));
    if (notesFile && !staleSampleNotes) return projectFiles;

    const { data, error } = await supabase
      .from("project_files")
      .upsert(
        {
          project_id: activeProject.id,
          user_id: user.id,
          path: "sections/notes.tex",
          kind: "tex",
          content_text: sampleNotesLatex,
          storage_path: null,
          storage_provider: "supabase",
          storage_key: null,
          public_url: null,
          mime_type: "text/x-tex",
          size_bytes: new Blob([sampleNotesLatex]).size,
        },
        { onConflict: "project_id,path" },
      )
      .select()
      .single();

    if (error) {
      toast.error(error.message);
      return projectFiles;
    }

    const updatedFiles = [
      ...projectFiles.filter((file) => file.path !== "sections/notes.tex" && file.path !== "sections/notes"),
      data,
    ].sort((a, b) => a.path.localeCompare(b.path));
    setFiles(updatedFiles);
    if (trigger === "manual") toast.success(staleSampleNotes ? "Repaired sample notes file" : "Added sample notes file");
    return updatedFiles;
  }

  async function loadStorageFileForCompile(file: ProjectFile) {
    return loadAssetBlob(file, supabase);
  }

  async function downloadActiveFile() {
    if (!activeFile || !supabase) return;
    if (activeFile.content_text !== null) {
      downloadText(activeFile.path === activePath ? editorValue : activeFile.content_text, activeFile.path);
      return;
    }
    const data = await loadAssetBlob(activeFile, supabase);
    if (!data) {
      toast.error("Could not download asset.");
      return;
    }
    downloadBlob(data, activeFile.path.split("/").pop() ?? activeFile.path);
  }

  async function downloadPdf() {
    if (!compileResult || !compileResult.ok || !activeProject) return;
    if (compileResult.pdfBlob) {
      downloadBlob(compileResult.pdfBlob, `${activeProject.title.replace(/[^a-z0-9_-]+/gi, "_")}.pdf`);
      return;
    }
    if (!compileResult.previewHtml) return;
    const frameDocument = previewFrameRef.current?.contentDocument;
    const pages = Array.from(frameDocument?.querySelectorAll<HTMLElement>(".page") ?? []);
    if (!pages.length) {
      if (compileResult.pdfBlob) downloadBlob(compileResult.pdfBlob, `${activeProject.title.replace(/[^a-z0-9_-]+/gi, "_")}.pdf`);
      return;
    }

    setExportingPdf(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);
      const firstPage = pages[0].getBoundingClientRect();
      const pdf = new jsPDF({
        orientation: firstPage.width > firstPage.height ? "landscape" : "portrait",
        unit: "px",
        format: [firstPage.width, firstPage.height],
        compress: true,
      });

      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        const rect = page.getBoundingClientRect();
        const canvas = await html2canvas(page, {
          backgroundColor: "#ffffff",
          scale: 2,
          useCORS: true,
          logging: false,
          windowWidth: frameDocument?.documentElement.scrollWidth,
          windowHeight: frameDocument?.documentElement.scrollHeight,
        });
        if (index > 0) pdf.addPage([rect.width, rect.height], rect.width > rect.height ? "landscape" : "portrait");
        pdf.setPage(index + 1);
        pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, rect.width, rect.height);
      }

      pdf.save(`${activeProject.title.replace(/[^a-z0-9_-]+/gi, "_")}.pdf`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not export preview PDF");
    } finally {
      setExportingPdf(false);
    }
  }

  function downloadBibtex() {
    const bibtex = citations.map((citation) => citation.bibtex).filter(Boolean).join("\n\n");
    downloadText(bibtex || "% No citations yet\n", "references.bib", "text/x-bibtex");
  }

  async function addCitation() {
    if (!supabase || !activeProject || !user || !newCitationKey.trim()) return;
    const bibtex = newCitationBibtex.trim() || `@article{${newCitationKey},\n  title={Untitled},\n  author={Author},\n  year={2026}\n}`;
    const { data, error } = await supabase
      .from("citations")
      .insert({
        project_id: activeProject.id,
        user_id: user.id,
        cite_key: newCitationKey.trim(),
        bibtex,
        csl_json: {},
        tags: [],
      })
      .select()
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    setCitations((current) => [...current, data].sort((a, b) => a.cite_key.localeCompare(b.cite_key)));
    setNewCitationBibtex("");
  }

  async function importCitation() {
    if (!supabase || !activeProject || !user || !newCitationBibtex.trim()) return;
    try {
      const Cite = (await import("citation-js")).default;
      const raw = newCitationBibtex.trim();
      const citation = looksLikeDoi(raw) ? await Cite.async(raw.replace(/^doi:\s*/i, "")) : new Cite(raw);
      const csl = (citation.data?.[0] ?? {}) as Record<string, unknown>;
      const importedKey = typeof csl["citation-key"] === "string" ? csl["citation-key"] : typeof csl.id === "string" ? csl.id : "";
      const citeKey = newCitationKey.trim() || importedKey || citationKeyFromCsl(csl);
      const bibtex = citation.format("bibtex");
      const { data, error } = await supabase
        .from("citations")
        .insert({
          project_id: activeProject.id,
          user_id: user.id,
          cite_key: citeKey,
          bibtex,
          csl_json: csl,
          tags: [],
        })
        .select()
        .single();
      if (error) {
        toast.error(error.message);
        return;
      }
      setCitations((current) => [...current, data].sort((a, b) => a.cite_key.localeCompare(b.cite_key)));
      setNewCitationKey(citeKey);
      setNewCitationBibtex("");
      toast.success("Citation imported");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not import citation");
    }
  }

  function insertAtCursor(text: string) {
    const editor = editorRef.current;
    if (!editor) {
      updateEditorValueFromUser(`${editorValue.trimEnd()}\n\n${text}\n`);
      return;
    }

    const selection = editor.getSelection();
    const range = selection ?? editor.getModel()?.getFullModelRange();
    if (!range) return;
    editor.executeEdits("moss-insert", [{ range, text, forceMoveMarkers: true }]);
    updateEditorValueFromUser(editor.getValue());
    editor.focus();
  }

  function updateEditorValueFromUser(value: string) {
    setEditorValue(value);
    setEditorRevision((revision) => revision + 1);
  }

  function jumpToSourceText(text: string) {
    const search = normalizePreviewSearch(text);
    if (!search) return;
    const activeContent = activeFile?.path === activePath ? editorValue : activeFile?.content_text ?? "";
    const activeIndex = findSourceIndex(activeContent, search);
    if (activeIndex >= 0) {
      pendingPreviewJumpRef.current = search;
      if (editorMode === "visual") {
        setVisualPreviewJump(search);
      } else {
        if (editorMode !== "code") setEditorMode("code");
        if (editorMode === "code") performEditorJump(search);
      }
      return;
    }

    const target = files.find((file) => file.content_text && findSourceIndex(file.content_text, search) >= 0);
    if (!target) return;
    pendingPreviewJumpRef.current = search;
    setActivePath(target.path);
    if (editorMode === "visual") {
      setVisualPreviewJump(search);
    } else {
      setEditorMode("code");
    }
  }

  async function jumpToPdfHit(hit: PdfTextHit) {
    if (compileResult?.compileId && compileResult.synctexAvailable) {
      const location = await reverseSynctex(compileResult.compileId, hit.page, hit.x, hit.y);
      if (location.ok) {
        jumpToSourceLocation(location.filePath, location.line, location.column ?? 1);
        return;
      }
    }
    jumpToSourceText(hit.text);
  }

  function jumpToSourceLocation(filePath: string, line: number, column = 1) {
    const targetFile = files.find((file) => file.path === filePath)
      ?? files.find((file) => file.path.endsWith(`/${filePath}`) || filePath.endsWith(`/${file.path}`));
    pendingSourceLocationRef.current = {
      filePath: targetFile?.path ?? filePath,
      line: Math.max(1, line),
      column: Math.max(1, column),
    };
    if (targetFile && targetFile.path !== activePath) setActivePath(targetFile.path);
    setEditorMode("code");
    if (editorMode === "code") window.setTimeout(() => {
      if (performLineJump(pendingSourceLocationRef.current)) pendingSourceLocationRef.current = null;
    }, 20);
  }

  function jumpToLogIssue(issue: LatexLogIssue) {
    const filePath = issue.filePath ?? (activeFile?.kind !== "tex" ? activeProject?.root_file_path : activePath);
    jumpToSourceLocation(filePath ?? activePath, issue.startLineNumber, issue.startColumn);
  }

  function performEditorJump(search: string) {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return false;
    const index = findSourceIndex(model.getValue(), search);
    if (index < 0) return false;
    const start = model.getPositionAt(index);
    const end = model.getPositionAt(index + search.length);
    editor.setSelection({
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    });
    editor.revealPositionInCenter(start);
    editor.focus();
    return true;
  }

  function performLineJump(location: { filePath: string; line: number; column: number } | null) {
    const editor = editorRef.current;
    if (!location || !editor) return false;
    if (activePath !== location.filePath) return false;
    const model = editor.getModel();
    if (!model) return false;
    const lineNumber = Math.min(Math.max(1, location.line), model.getLineCount());
    const column = Math.min(Math.max(1, location.column), model.getLineMaxColumn(lineNumber));
    editor.setPosition({ lineNumber, column });
    editor.setSelection({
      startLineNumber: lineNumber,
      startColumn: column,
      endLineNumber: lineNumber,
      endColumn: Math.min(column + 24, model.getLineMaxColumn(lineNumber)),
    });
    editor.revealLineInCenter(lineNumber);
    editor.focus();
    return true;
  }

  function updateLatexMarkers() {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;

    const isLatexFile = activeFile?.kind === "tex" || activeFile?.kind === "style" || activeFile?.kind === "class";
    if (!isLatexFile) {
      monaco.editor.setModelMarkers(model, "moss-latex-lint", []);
      return;
    }

    const diagnostics = [
      ...lintLatex(model.getValue()),
      ...projectReferenceDiagnostics(model.getValue(), files),
    ];
    if (compileResult?.ok === false) {
      const structured = compileResult.structuredDiagnostics ?? [];
      if (structured.length) {
        diagnostics.push(
          ...structured
            .filter((diagnostic) => !diagnostic.filePath || diagnostic.filePath === activePath)
            .map(compileDiagnosticToLintDiagnostic),
        );
      } else {
        diagnostics.push(...parseLatexLogIssues(compileResult.log));
      }
    }

    monaco.editor.setModelMarkers(
      model,
      "moss-latex-lint",
      diagnostics.map((diagnostic) => toMonacoMarker(diagnostic)),
    );
  }

  function toMonacoMarker(diagnostic: LatexLintDiagnostic) {
    const monaco = monacoRef.current;
    return {
      message: diagnostic.message,
      severity: diagnostic.severity === "error"
        ? monaco?.MarkerSeverity.Error ?? 8
        : diagnostic.severity === "warning"
          ? monaco?.MarkerSeverity.Warning ?? 4
          : monaco?.MarkerSeverity.Info ?? 2,
      startLineNumber: diagnostic.startLineNumber,
      startColumn: diagnostic.startColumn,
      endLineNumber: diagnostic.endLineNumber,
      endColumn: diagnostic.endColumn,
    };
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
  }

  if (loading) {
    return <main className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading Moss...</main>;
  }

  if (!isSupabaseConfigured) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <section className="flex max-w-lg flex-col gap-4 rounded-lg border bg-card p-6 shadow-sm">
          <h1 className="text-2xl font-semibold">Connect Moss to Supabase</h1>
          <p className="text-sm text-muted-foreground">
            I set <code>NEXT_PUBLIC_SUPABASE_URL</code>. Add your Supabase anon or publishable key to <code>.env.local</code>.
          </p>
        </section>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <section className="flex w-full max-w-xl flex-col gap-5 rounded-lg border bg-card p-8 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Braces />
            Moss
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight">Cloud LaTeX, direct downloads.</h1>
            <p className="text-muted-foreground">
              Supabase stores your projects and uploaded diagrams. Browser compilation produces PDFs without storing output files.
            </p>
          </div>
          <Button asChild>
            <Link href="/auth">Sign in to Moss</Link>
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="flex h-screen min-h-screen overflow-hidden bg-background text-foreground">
      <aside className="flex w-72 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex items-center justify-between border-b p-3">
          <div className="flex items-center gap-2 font-semibold">
            <Braces />
            Moss
          </div>
          <Button variant="ghost" size="icon-sm" onClick={signOut} title="Sign out">
            <LogOut />
          </Button>
        </div>
        <div className="flex flex-col gap-3 border-b p-3">
          <Button onClick={createProject}>
            <Plus data-icon="inline-start" />
            New project
          </Button>
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={activeProject?.id ?? ""}
            onChange={(event) => setActiveProject(projects.find((project) => project.id === event.target.value) ?? null)}
          >
            <option value="">Select project</option>
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-3 border-b p-3">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <ListTree />
            File tree
          </div>
          <div className="flex gap-2">
            <input className="min-w-0 flex-1 rounded-md border bg-background px-2 text-xs" value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} />
            <Button variant="outline" size="icon-sm" onClick={createTextFile} title="Create text file">
              <FilePlus2 />
            </Button>
          </div>
          <div className="flex gap-2">
            <input className="min-w-0 flex-1 rounded-md border bg-background px-2 text-xs" value={newFolderPath} onChange={(event) => setNewFolderPath(event.target.value)} />
            <Button variant="outline" size="icon-sm" onClick={createFolder} title="Create folder">
              <FolderPlus />
            </Button>
          </div>
          <input ref={textFileInputRef} className="hidden" type="file" accept=".tex,.ltx,.latex,.bib,.sty,.cls,.bst,.txt" multiple onChange={uploadTextFile} />
          <input ref={fileInputRef} className="hidden" type="file" accept=".png,.jpg,.jpeg,.svg,.webp,.gif,.pdf,.eps" multiple onChange={uploadAsset} />
          <input ref={projectFileInputRef} className="hidden" type="file" multiple onChange={uploadProjectFolder} />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => textFileInputRef.current?.click()}>
              <FilePlus2 data-icon="inline-start" />
              Upload TeX
            </Button>
            <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
              <Upload data-icon="inline-start" />
              Upload asset
            </Button>
          </div>
          <Button variant="outline" onClick={() => projectFileInputRef.current?.click()}>
            <FolderPlus data-icon="inline-start" />
            Upload folder
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {files.map((file) => (
            <button
              key={file.id}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent data-[active=true]:bg-sidebar-accent"
              data-active={file.path === activePath}
              onClick={() => setActivePath(file.path)}
            >
              {file.kind === "image" || file.kind === "pdf" ? <ImagePlus /> : file.kind === "folder" ? <FolderPlus /> : <FileCode2 />}
              <span className="truncate">{file.path}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{activeProject?.title ?? "No project"}</span>
            <span className="text-xs text-muted-foreground">{activePath}</span>
            {activeFile?.kind === "tex" ? (
              <div className="ml-3 flex rounded-lg border bg-background p-0.5">
                <Button variant={editorMode === "code" ? "secondary" : "ghost"} size="sm" onClick={() => setEditorMode("code")}>
                  Code
                </Button>
                <Button variant={editorMode === "visual" ? "secondary" : "ghost"} size="sm" onClick={() => setEditorMode("visual")}>
                  Visual
                </Button>
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void saveActiveFile()} disabled={!activeFile || saving}>
              <Save data-icon="inline-start" />
              {saving ? "Saving" : "Save"}
            </Button>
            <CompileDropdown autoCompile={autoCompile} compiling={compiling} disabled={!activeProject} onCompile={() => void runCompile("manual")} onAutoCompileChange={setAutoCompile} />
            <Button variant="outline" onClick={() => void downloadPdf()} disabled={!compileResult?.ok || (!compileResult?.pdfBlob && !compileResult?.previewHtml) || exportingPdf}>
              <FileDown data-icon="inline-start" />
              {exportingPdf ? "Exporting" : "PDF"}
            </Button>
            <Button variant="outline" onClick={downloadActiveFile} disabled={!activeFile}>
              <Download data-icon="inline-start" />
              File
            </Button>
            <Button variant="outline" onClick={downloadZip} disabled={!activeProject}>
              <Download data-icon="inline-start" />
              ZIP
            </Button>
            <Button variant="destructive" size="icon-sm" onClick={deleteActiveFile} disabled={!activeFile || activeFile.path === activeProject?.root_file_path}>
              <Trash2 />
            </Button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(520px,1fr)] overflow-hidden">
          <div className="min-h-0 min-w-0 overflow-hidden border-r">
            {activeFile && textFileKinds.has(activeFile.kind) && editorMode === "visual" && activeFile.kind === "tex" ? (
              <LatexVisualEditor
                latex={editorValue}
                pendingSearch={visualPreviewJump}
                onLatexChange={updateEditorValueFromUser}
                onPendingSearchHandled={() => {
                  pendingPreviewJumpRef.current = "";
                  setVisualPreviewJump("");
                }}
              />
            ) : activeFile && textFileKinds.has(activeFile.kind) ? (
              <MonacoEditor
                height="100%"
                language={activeFile.kind === "bib" ? "bibtex" : "latex"}
                value={editorValue}
                onChange={(value) => updateEditorValueFromUser(value ?? "")}
                onMount={(editor, monaco) => {
                  editorRef.current = editor;
                  monacoRef.current = monaco;
                  updateLatexMarkers();
                }}
                options={{
                  minimap: { enabled: false },
                  fontSize: 14,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                }}
              />
            ) : activeFile?.kind === "image" ? (
              <div className="flex h-full min-h-0 flex-col bg-muted/40">
                <div className="flex h-11 shrink-0 items-center justify-between border-b bg-background px-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{activeFile.path}</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(activeFile.size_bytes)} · {activeFile.mime_type ?? "image"} · {activeFile.storage_provider}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={downloadActiveFile}>
                    <Download data-icon="inline-start" />
                    File
                  </Button>
                </div>
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
                  {assetPreviewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="max-h-full max-w-full rounded-md border bg-background object-contain shadow-sm" src={assetPreviewUrl} alt={activeFile.path} />
                  ) : (
                    <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
                      <ImagePlus />
                      <p className="text-sm">Loading image preview...</p>
                    </div>
                  )}
                </div>
              </div>
            ) : activeFile ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
                <ImagePlus />
                <p className="text-sm">{activeFile.path} is stored as a project asset and can be referenced from LaTeX.</p>
                <Button variant="outline" onClick={downloadActiveFile}>Download asset</Button>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-muted-foreground">Create or select a project to begin.</div>
            )}
          </div>

          <aside className="flex min-h-0 flex-col bg-card">
            <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
              <div className="flex items-center gap-1">
                <PanelButton active={rightPanel === "preview"} icon={<PanelRight />} label="Preview" onClick={() => setRightPanel("preview")} />
                <PanelButton active={rightPanel === "logs"} icon={<FileCode2 />} label="Logs" onClick={() => setRightPanel("logs")} />
                <PanelButton active={rightPanel === "sections"} icon={<ListTree />} label="Sections" onClick={() => setRightPanel("sections")} />
                <PanelButton active={rightPanel === "citations"} icon={<Library />} label="Cites" onClick={() => setRightPanel("citations")} />
                <PanelButton active={rightPanel === "equation"} icon={<Sigma />} label="Math" onClick={() => setRightPanel("equation")} />
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon-sm" onClick={() => void downloadPdf()} disabled={!compileResult?.ok || (!compileResult?.pdfBlob && !compileResult?.previewHtml) || exportingPdf} title="Download PDF">
                  <Download />
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {rightPanel === "preview" ? (
                <section className="flex h-full min-h-0 flex-col">
                  <div className="flex h-10 shrink-0 items-center justify-between border-b px-3 text-sm">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <button className="rounded-md p-1 hover:bg-muted" aria-label="Previous page">
                        <ChevronLeft />
                      </button>
                      <span className="text-foreground">1</span>
                      <span>of</span>
                      <span>{compileResult?.pdfBlob ? previewPageCount || 1 : compileResult?.previewHtml ? compileResult.pageCount ?? 1 : "0"}</span>
                      <button className="rounded-md p-1 hover:bg-muted" aria-label="Next page">
                        <ChevronRight />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="icon-sm" onClick={() => setPreviewZoom((zoom) => Math.max(50, zoom - 10))} title="Zoom out">
                        <Minus />
                      </Button>
                      <span className="w-14 text-center text-sm tabular-nums">{previewZoom}%</span>
                      <Button variant="ghost" size="icon-sm" onClick={() => setPreviewZoom((zoom) => Math.min(180, zoom + 10))} title="Zoom in">
                        <Plus />
                      </Button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto bg-muted/60 p-6">
                    {compileResult?.pdfBlob ? (
                      <PdfPreview
                        pdfBlob={compileResult.pdfBlob}
                        zoom={previewZoom}
                        onPageCountChange={setPreviewPageCount}
                        onTextClick={(hit) => void jumpToPdfHit(hit)}
                      />
                    ) : compileResult?.previewHtml ? (
                      <div
                        className="mx-auto"
                        style={{ width: `${736 * htmlPreviewScale}px`, height: `${htmlPreviewHeight * htmlPreviewScale}px` }}
                      >
                        <div
                          className="origin-top-left bg-background shadow-sm"
                          style={{ width: "736px", height: `${htmlPreviewHeight}px`, transform: `scale(${htmlPreviewScale})` }}
                        >
                          <iframe
                            ref={previewFrameRef}
                            className="w-full border-0 bg-background"
                            srcDoc={compileResult.previewHtml}
                            style={{ height: `${htmlPreviewHeight}px` }}
                            title="Moss document preview"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="mx-auto flex min-h-[720px] w-[520px] flex-col items-center justify-center gap-3 rounded-lg border bg-background p-8 text-center shadow-sm">
                        <PanelRight />
                        <h2 className="text-lg font-semibold">No preview yet</h2>
                        <p className="text-sm text-muted-foreground">Compile the current project to render a document-style preview here.</p>
                        <Button onClick={() => void runCompile("manual")}>
                          <Play data-icon="inline-start" />
                          Compile
                        </Button>
                      </div>
                    )}
                  </div>
                </section>
              ) : null}

              {rightPanel === "logs" ? (
                <section className="flex h-full flex-col gap-3 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <h2 className="text-sm font-semibold">Compile logs</h2>
                      <LogCountPills issues={logIssues} />
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => void runCompile("manual")}>
                      <RefreshCcw data-icon="inline-start" />
                      Refresh
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto">
                    {logIssues.length ? (
                      <div className="flex flex-col gap-2">
                        {compileResult?.ok === false ? (
                          <div className="rounded-md border bg-muted p-3 text-sm">
                            <div className="flex items-center gap-2 font-medium text-destructive">
                              <AlertCircle />
                              No PDF
                            </div>
                          </div>
                        ) : null}
                        {logIssues.map((issue, index) => (
                          <LogIssueCard
                            issue={issue}
                            key={`${issue.title}-${issue.startLineNumber}-${index}`}
                            onJump={() => jumpToLogIssue(issue)}
                          />
                        ))}
                        <details className="rounded-md border bg-muted p-3 text-xs text-muted-foreground">
                          <summary className="cursor-pointer font-medium text-foreground">Raw log</summary>
                          <pre className="mt-3 overflow-auto whitespace-pre-wrap">{compileResult?.log}</pre>
                        </details>
                      </div>
                    ) : (
                      <pre className="min-h-full rounded-md border bg-muted p-3 text-xs text-muted-foreground">{compileResult?.log ?? "No compile logs yet."}</pre>
                    )}
                  </div>
                </section>
              ) : null}

              {rightPanel === "sections" ? (
                <section className="flex h-full flex-col gap-3 overflow-auto p-4">
                  <h2 className="text-sm font-semibold">Sections</h2>
                  {sections.length ? sections.map((section) => (
                    <button
                      className="rounded-md border p-2 text-left text-sm hover:bg-muted"
                      key={section.id}
                      onClick={() => {
                        const file = files.find((item) => item.id === section.file_id);
                        if (file) setActivePath(file.path);
                      }}
                    >
                      <span className="font-medium">{"#".repeat(section.level)} {section.heading}</span>
                      <span className="block text-xs text-muted-foreground">hash {section.content_hash.slice(0, 10)}</span>
                    </button>
                  )) : <p className="text-sm text-muted-foreground">Save a .tex file to parse sections.</p>}
                </section>
              ) : null}

              {rightPanel === "citations" ? (
                <section className="flex h-full flex-col gap-3 overflow-auto p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold">Citations</h2>
                    <Button variant="ghost" size="sm" onClick={downloadBibtex}>Export .bib</Button>
                  </div>
                  <input className="h-8 rounded-md border bg-background px-2 text-sm" value={newCitationKey} onChange={(event) => setNewCitationKey(event.target.value)} placeholder="cite key" />
                  <textarea className="min-h-24 rounded-md border bg-background p-2 text-xs font-mono" value={newCitationBibtex} onChange={(event) => setNewCitationBibtex(event.target.value)} placeholder="@article{key,...}" />
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={addCitation}>Add citation</Button>
                    <Button variant="outline" onClick={importCitation}>Import DOI/BibTeX</Button>
                    <Button variant="outline" onClick={() => insertAtCursor(`\\cite{${newCitationKey}}`)}>Insert cite</Button>
                  </div>
                  {citations.map((citation) => <div className="rounded-md border p-2 text-xs" key={citation.id}>{citation.cite_key}</div>)}
                </section>
              ) : null}

              {rightPanel === "equation" ? (
                <section className="flex h-full flex-col gap-3 overflow-auto p-4">
                  <h2 className="text-sm font-semibold">Equation</h2>
                  <EquationEditor value={equationLatex} onChange={setEquationLatex} />
                  <Button variant="outline" onClick={() => insertAtCursor(`\\[\n${equationLatex}\n\\]`)}>
                    <Sigma data-icon="inline-start" />
                    Insert equation
                  </Button>
                </section>
              ) : null}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}

function CompileDropdown({
  autoCompile,
  compiling,
  disabled,
  onCompile,
  onAutoCompileChange,
}: {
  autoCompile: boolean;
  compiling: boolean;
  disabled: boolean;
  onCompile: () => void;
  onAutoCompileChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded-lg border bg-background">
      <Button className="rounded-none border-0" variant="ghost" onClick={onCompile} disabled={disabled || compiling}>
        <Play data-icon="inline-start" />
        {compiling ? "Compiling" : "Compile"}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="rounded-none border-0 border-l" variant="ghost" size="icon-sm" disabled={disabled} aria-label="Compile settings">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Compile settings</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={autoCompile} onCheckedChange={(checked) => onAutoCompileChange(checked === true)}>
            Auto compile
          </DropdownMenuCheckboxItem>
          <DropdownMenuItem onClick={onCompile} disabled={disabled || compiling}>
            <Play data-icon="inline-start" />
            Compile now
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function LogCountPills({ issues }: { issues: LatexLogIssue[] }) {
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const info = issues.filter((issue) => issue.severity === "info").length;
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <span className="rounded-full bg-muted px-2 py-0.5">All {issues.length}</span>
      <span className="rounded-full bg-muted px-2 py-0.5">Errors {errors}</span>
      <span className="rounded-full bg-muted px-2 py-0.5">Warnings {warnings}</span>
      <span className="rounded-full bg-muted px-2 py-0.5">Info {info}</span>
    </div>
  );
}

function LogIssueCard({ issue, onJump }: { issue: LatexLogIssue; onJump: () => void }) {
  const icon = issue.severity === "error"
    ? <AlertCircle />
    : issue.severity === "warning"
      ? <AlertTriangle />
      : <Info />;

  return (
    <button
      className="rounded-md border bg-card p-3 text-left hover:bg-muted/50"
      onClick={onJump}
      type="button"
    >
      <div className="flex items-start gap-3">
        <span className={issue.severity === "error" ? "text-destructive" : "text-muted-foreground"}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={issue.severity === "error" ? "font-semibold text-destructive" : "font-semibold"}>
              {issue.title}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">line {issue.startLineNumber}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{issue.category}</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{issue.message}</p>
          {issue.excerpt ? (
            <pre className="mt-3 max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs text-muted-foreground">{issue.excerpt}</pre>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function looksLikeDoi(value: string) {
  return /^(doi:\s*)?10\.\d{4,9}\/\S+$/i.test(value.trim());
}

function uploadPathEntries(files: File[], mode: "text" | "asset" | "mixed") {
  const rawPaths = files.map((file) => normalizePath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name));
  const firstSegments = rawPaths.map((path) => path.split("/")[0]);
  const sharedRoot = rawPaths.length > 1 && rawPaths.every((path) => path.includes("/")) && firstSegments.every((segment) => segment === firstSegments[0])
    ? firstSegments[0]
    : "";

  return rawPaths.map((rawPath, index) => {
    const fileName = files[index].name;
    const relativePath = sharedRoot ? rawPath.split("/").slice(1).join("/") : rawPath;
    if (files.length === 1 && mode === "asset") {
      const path = window.prompt("Path in project", `figures/${fileName}`);
      return path === null ? "" : normalizePath(path);
    }
    if (files.length === 1 && mode === "text") {
      const path = window.prompt("Path in project", fileName);
      return path === null ? "" : normalizePath(path);
    }
    return normalizePath(relativePath || fileName);
  });
}

function citationKeyFromCsl(csl: Record<string, unknown>) {
  const family = Array.isArray(csl.author) && csl.author[0] && typeof csl.author[0] === "object" && "family" in csl.author[0]
    ? String((csl.author[0] as { family?: string }).family ?? "source")
    : "source";
  const issued = csl.issued as { "date-parts"?: number[][] } | undefined;
  const year = String(issued?.["date-parts"]?.[0]?.[0] ?? new Date().getFullYear());
  return `${family.toLowerCase().replace(/[^a-z0-9]+/g, "")}${year}`;
}

function normalizePreviewSearch(value: string) {
  return value
    .replace(/[^\w' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findSourceIndex(source: string, search: string) {
  const target = normalizePreviewSearch(search).toLowerCase();
  if (!target) return -1;

  const exactIndex = source.toLowerCase().indexOf(target);
  if (exactIndex >= 0) return exactIndex;

  const sourceWords = Array.from(source.matchAll(/[A-Za-z0-9][A-Za-z0-9'\u2019-]*/g));
  const targetWords = target.split(/\s+/).filter(Boolean);
  if (!targetWords.length) return -1;

  for (let index = 0; index <= sourceWords.length - targetWords.length; index += 1) {
    const matches = targetWords.every((word, offset) => sourceWords[index + offset]?.[0].toLowerCase() === word);
    if (matches) return sourceWords[index].index ?? -1;
  }

  return -1;
}

function compileDiagnosticToLogIssue(diagnostic: CompileDiagnostic): LatexLogIssue {
  const line = Math.max(1, diagnostic.line ?? 1);
  const column = Math.max(1, diagnostic.column ?? 1);
  return {
    title: diagnostic.title || diagnostic.message,
    message: diagnostic.message || diagnostic.title,
    severity: diagnostic.severity,
    category: normalizeDiagnosticCategory(diagnostic.category, diagnostic.severity),
    filePath: diagnostic.filePath ?? undefined,
    excerpt: diagnostic.excerpt ?? undefined,
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: column + 120,
  };
}

function compileDiagnosticToLintDiagnostic(diagnostic: CompileDiagnostic): LatexLintDiagnostic {
  const line = Math.max(1, diagnostic.line ?? 1);
  const column = Math.max(1, diagnostic.column ?? 1);
  return {
    message: diagnostic.message || diagnostic.title,
    severity: diagnostic.severity,
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: column + 120,
  };
}

function normalizeDiagnosticCategory(category: string, severity: CompileDiagnostic["severity"]): LatexLogIssue["category"] {
  if (category.includes("citation")) return "citation";
  if (category.includes("reference")) return "reference";
  if (category.includes("file")) return "file";
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "info";
}

function projectReferenceDiagnostics(source: string, files: ProjectFile[]): LatexLintDiagnostic[] {
  const diagnostics: LatexLintDiagnostic[] = [];
  const projectPaths = new Set(files.map((file) => normalizePath(file.path)));
  const bibKeys = new Set<string>();

  for (const file of files) {
    if (file.kind !== "bib" || !file.content_text) continue;
    for (const match of file.content_text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) {
      bibKeys.add(match[1]);
    }
  }

  for (const match of source.matchAll(/\\(?:includegraphics)(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    const path = normalizePath(match[1]);
    if (projectPaths.has(path)) continue;
    diagnostics.push(diagnosticAt(source, match.index ?? 0, match[0].length, "error", `Image '${path}' is not in the project file tree.`));
  }

  for (const match of source.matchAll(/\\(?:input|include)\{([^}]+)\}/g)) {
    const path = normalizePath(match[1]);
    const candidates = path.endsWith(".tex") ? [path] : [path, `${path}.tex`];
    if (candidates.some((candidate) => projectPaths.has(candidate))) continue;
    diagnostics.push(diagnosticAt(source, match.index ?? 0, match[0].length, "error", `Input file '${path}' is not in the project file tree.`));
  }

  for (const match of source.matchAll(/\\bibliography\{([^}]+)\}/g)) {
    const names = match[1].split(",").map((name) => normalizePath(name.trim())).filter(Boolean);
    for (const name of names) {
      const path = name.endsWith(".bib") ? name : `${name}.bib`;
      if (projectPaths.has(path)) continue;
      diagnostics.push(diagnosticAt(source, match.index ?? 0, match[0].length, "warning", `Bibliography file '${path}' is missing.`));
    }
  }

  for (const match of source.matchAll(/\\cite(?:\[[^\]]*\])?(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    const keys = match[1].split(",").map((key) => key.trim()).filter(Boolean);
    const missing = keys.filter((key) => !bibKeys.has(key));
    if (!missing.length) continue;
    diagnostics.push(diagnosticAt(source, match.index ?? 0, match[0].length, "warning", `Missing BibTeX key${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`));
  }

  return diagnostics;
}

function escapePostgrestListValue(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function diagnosticAt(source: string, index: number, length: number, severity: LatexLintDiagnostic["severity"], message: string): LatexLintDiagnostic {
  const start = sourcePositionAt(source, index);
  const end = sourcePositionAt(source, index + length);
  return {
    message,
    severity,
    startLineNumber: start.line,
    startColumn: start.column,
    endLineNumber: end.line,
    endColumn: Math.max(end.column, start.column + 1),
  };
}

function sourcePositionAt(source: string, index: number) {
  const before = source.slice(0, index);
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

function compileSignature(project: Project, files: ProjectFile[]) {
  return JSON.stringify({
    rootFilePath: project.root_file_path,
    files: files
      .filter((file) => file.kind !== "folder")
      .map((file) => ({
        path: file.path,
        kind: file.kind,
        content: file.content_text,
        storagePath: file.storage_path,
        storageKey: file.storage_key,
        publicUrl: file.public_url,
        sizeBytes: file.size_bytes,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, type: string) {
  const cleaned = base64.replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
  const binary = window.atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type });
}

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function loadAssetBlob(file: ProjectFile, client: typeof supabase) {
  if (file.storage_provider === "uploadthing" && file.public_url) {
    const response = await fetch(file.public_url);
    if (!response.ok) throw new Error(`Could not fetch UploadThing asset: ${file.path}`);
    return response.blob();
  }

  if (!file.storage_path || !client) return null;
  const { data, error } = await client.storage.from(PROJECT_ASSETS_BUCKET).download(file.storage_path);
  if (error) throw error;
  return data;
}

function PanelButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted data-[active=true]:bg-muted data-[active=true]:text-foreground"
      data-active={active}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}
