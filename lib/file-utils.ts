import JSZip from "jszip";
import { PROJECT_ASSETS_BUCKET, supabase } from "@/lib/supabase";
import type { Project, ProjectFile } from "@/lib/types";

export const TEXT_EXTENSIONS = new Set(["tex", "ltx", "latex", "bib", "sty", "cls", "bst", "txt"]);
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "svg", "webp", "gif"]);
export const BINARY_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, "pdf", "eps"]);
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 100 * 1024 * 1024;

export function extensionFor(path: string) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

export function kindForPath(path: string) {
  const ext = extensionFor(path);
  if (ext === "tex") return "tex";
  if (ext === "bib") return "bib";
  if (ext === "sty") return "style";
  if (ext === "cls") return "class";
  if (ext === "bst") return "bst";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return TEXT_EXTENSIONS.has(ext) ? "asset" : "asset";
}

export function normalizePath(path: string) {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function downloadText(content: string, filename: string, type = "text/plain") {
  downloadBlob(new Blob([content], { type }), filename);
}

export async function buildProjectZip(project: Project, files: ProjectFile[]) {
  const zip = new JSZip();

  for (const file of files) {
    if (file.kind === "folder") continue;
    if (file.content_text !== null) {
      zip.file(file.path, file.content_text);
      continue;
    }

    if (file.storage_provider === "uploadthing" && file.public_url) {
      const response = await fetch(file.public_url);
      if (!response.ok) throw new Error(`Could not download ${file.path}`);
      zip.file(file.path, await response.blob());
      continue;
    }

    if (file.storage_path && supabase) {
      const { data, error } = await supabase.storage
        .from(PROJECT_ASSETS_BUCKET)
        .download(file.storage_path);
      if (error) throw error;
      zip.file(file.path, data);
    }
  }

  return zip.generateAsync({ type: "blob" }).then((blob) => ({
    blob,
    filename: `${project.title.replace(/[^a-z0-9_-]+/gi, "_") || "moss-project"}.zip`,
  }));
}

export function storagePathFor(userId: string, projectId: string, path: string) {
  return `${userId}/${projectId}/${normalizePath(path)}`;
}
