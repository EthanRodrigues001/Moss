import type { User } from "@supabase/supabase-js";

export type FileKind =
  | "tex"
  | "bib"
  | "style"
  | "class"
  | "bst"
  | "image"
  | "pdf"
  | "asset"
  | "folder";

export type Project = {
  id: string;
  user_id: string;
  title: string;
  root_file_path: string;
  created_at: string;
  updated_at: string;
};

export type ProjectFile = {
  id: string;
  project_id: string;
  user_id: string;
  path: string;
  kind: FileKind;
  content_text: string | null;
  storage_path: string | null;
  storage_provider: "supabase" | "uploadthing";
  storage_key: string | null;
  public_url: string | null;
  mime_type: string | null;
  size_bytes: number;
  created_at: string;
  updated_at: string;
};

export type SectionRecord = {
  id: string;
  project_id: string;
  file_id: string | null;
  user_id: string;
  section_key: string | null;
  file_path: string | null;
  heading: string;
  level: number;
  order_index: number;
  content_hash: string;
  source_start: number;
  source_end: number;
  source_text: string | null;
  updated_at: string;
};

export type Citation = {
  id: string;
  project_id: string;
  user_id: string;
  cite_key: string;
  csl_json: Record<string, unknown>;
  bibtex: string;
  tags: string[];
  updated_at: string;
};

export type SessionUser = Pick<User, "id" | "email">;

export type CompileDiagnostic = {
  severity: "error" | "warning" | "info";
  title: string;
  message: string;
  filePath?: string | null;
  line?: number | null;
  column?: number | null;
  excerpt?: string | null;
  category: string;
};

export type CompileEngine = "pdflatex" | "xelatex" | "lualatex" | "tectonic";

export type CompileResult = {
  ok: boolean;
  pdfBlob?: Blob;
  previewHtml?: string;
  pageCount?: number;
  log: string;
  diagnostics: string[];
  structuredDiagnostics?: CompileDiagnostic[];
  compileId?: string;
  compiler?: "latexmk" | "tectonic" | string;
  engine?: CompileEngine | string;
  synctexAvailable?: boolean;
};
