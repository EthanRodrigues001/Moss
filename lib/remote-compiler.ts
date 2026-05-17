import type { CompileDiagnostic, CompileEngine, CompileResult, Project, ProjectFile } from "@/lib/types";

const compilerApiUrl = process.env.NEXT_PUBLIC_COMPILER_API_URL?.replace(/\/+$/, "") ?? "";

export const isRemoteCompilerConfigured = Boolean(compilerApiUrl);

type StorageLoader = (file: ProjectFile) => Promise<Blob | null>;

type RemoteCompileFile = {
  path: string;
  kind: ProjectFile["kind"];
  mimeType?: string | null;
  contentText?: string;
  contentBase64?: string;
};

type RemoteCompileSuccess = {
  ok: true;
  compileId: string;
  compiler: "latexmk" | "tectonic" | string;
  engine: CompileEngine | string;
  durationMs: number;
  filename: string;
  pdfBase64: string;
  log: string;
  diagnostics: CompileDiagnostic[];
  synctexAvailable: boolean;
};

type RemoteCompileFailure = {
  ok: false;
  compiler?: string;
  engine?: CompileEngine | string;
  code?: string;
  log?: string;
  diagnostics?: CompileDiagnostic[];
};

type SynctexReverseResponse =
  | { ok: true; filePath: string; line: number; column?: number | null }
  | { ok: false; error: string };

export async function compileProjectRemotely(
  project: Project,
  files: ProjectFile[],
  loadStorageFile: StorageLoader,
): Promise<CompileResult> {
  if (!compilerApiUrl) {
    return {
      ok: false,
      log: "Remote compiler URL is not configured.",
      diagnostics: ["Missing NEXT_PUBLIC_COMPILER_API_URL"],
    };
  }

  const payloadFiles: RemoteCompileFile[] = [];
  for (const file of files) {
    if (file.kind === "folder") continue;
    if (file.content_text !== null) {
      payloadFiles.push({
        path: file.path,
        kind: file.kind,
        mimeType: file.mime_type,
        contentText: file.content_text,
      });
      continue;
    }

    const blob = await loadStorageFile(file);
    if (!blob) continue;
    payloadFiles.push({
      path: file.path,
      kind: file.kind,
      mimeType: file.mime_type ?? blob.type,
      contentBase64: await blobToBase64(blob),
    });
  }

  let response: Response;
  try {
    response = await fetch(`${compilerApiUrl}/compile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        projectTitle: project.title,
        rootFilePath: project.root_file_path,
        files: payloadFiles,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      log: [
        `Could not reach the Moss compiler backend at ${compilerApiUrl}.`,
        "Make sure the Rust/Tectonic backend is running, then compile again.",
        "",
        error instanceof Error ? error.message : "Network request failed.",
      ].join("\n"),
      diagnostics: ["Compiler backend is unreachable"],
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (response.ok && contentType.includes("application/pdf")) {
    logBackendCompiler("legacy-pdf", "tectonic", true);
    return {
      ok: true,
      pdfBlob: await response.blob(),
      log: response.headers.get("x-moss-log") || "Recompiled with the Moss Render Tectonic compiler.",
      diagnostics: [],
    };
  }

  const jsonPayload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : null;

  if (response.ok && jsonPayload?.ok === true && typeof jsonPayload.pdfBase64 === "string") {
    const payload = jsonPayload as RemoteCompileSuccess;
    logBackendCompiler(payload.compiler, payload.engine, true);
    return {
      ok: true,
      pdfBlob: base64ToBlob(payload.pdfBase64, "application/pdf"),
      log: payload.log || "Recompiled",
      diagnostics: diagnosticsToStrings(payload.diagnostics),
      structuredDiagnostics: payload.diagnostics ?? [],
      compileId: payload.compileId,
      compiler: payload.compiler,
      engine: payload.engine,
      synctexAvailable: payload.synctexAvailable,
    };
  }

  const errorPayload = jsonPayload as RemoteCompileFailure | null;
  const log = typeof errorPayload?.log === "string"
    ? errorPayload.log
    : await response.text().catch(() => "Remote compiler failed.");
  const structuredDiagnostics = Array.isArray(errorPayload?.diagnostics) ? errorPayload.diagnostics : [];
  logBackendCompiler(errorPayload?.compiler ?? "unknown", errorPayload?.engine ?? "unknown", false);

  return {
    ok: false,
    log,
    diagnostics: structuredDiagnostics.length ? diagnosticsToStrings(structuredDiagnostics) : ["Remote compiler failed"],
    structuredDiagnostics,
    compiler: errorPayload?.compiler,
    engine: errorPayload?.engine,
  };
}

export async function reverseSynctex(compileId: string, page: number, x: number, y: number): Promise<SynctexReverseResponse> {
  if (!compilerApiUrl) return { ok: false, error: "Remote compiler URL is not configured." };

  try {
    const response = await fetch(`${compilerApiUrl}/synctex/reverse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ compileId, page, x, y }),
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.ok === true && typeof payload.filePath === "string" && typeof payload.line === "number") {
      return {
        ok: true,
        filePath: payload.filePath,
        line: payload.line,
        column: typeof payload.column === "number" ? payload.column : null,
      };
    }
    return {
      ok: false,
      error: typeof payload?.error === "string" ? payload.error : "SyncTeX lookup failed.",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "SyncTeX lookup failed.",
    };
  }
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function diagnosticsToStrings(diagnostics: CompileDiagnostic[] = []) {
  return diagnostics.map((diagnostic) => diagnostic.title || diagnostic.message).filter(Boolean);
}

function logBackendCompiler(compiler: string | undefined, engine: string | undefined, ok: boolean) {
  console.info(
    `%cMoss backend compiler: ${compiler ?? "unknown"} / ${engine ?? "unknown"} (${ok ? "ok" : "failed"})`,
    "color: #f97316; font-weight: 700;",
  );
}
