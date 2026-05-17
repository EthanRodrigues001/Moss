import type { CompileResult, Project, ProjectFile } from "@/lib/types";

type SwiftLatexFileData = string | Uint8Array;

type SwiftLatexCacheSeedFile = {
  fileid: string;
  cacheKeys: string[];
  src: Uint8Array;
};

type SwiftLatexCompileMessage = {
  cmd?: string;
  result?: string;
  status?: number;
  log?: string;
  pdf?: ArrayBuffer;
};

type StorageLoader = (file: ProjectFile) => Promise<Blob | Uint8Array | ArrayBuffer | null>;

let sharedEngine: SwiftLatexWorkerEngine | null = null;

const PDFTEX_FORMAT_CACHE_KEY = "10/swiftlatexpdftex.fmt";
const PDFTEX_FORMAT_FILE_ID = "swiftlatexpdftex.fmt";
const LOCAL_TEX_FORMATS = [1, 2, 3, 4, 5, 6, 8, 10];
const LATEX_2020_COMPAT_SHIM = String.raw`\makeatletter
\@ifundefined{DeclareCommandCopy}{\def\DeclareCommandCopy#1#2{\let#1#2}}{}
\@ifundefined{DeclareRobustCommandCopy}{\def\DeclareRobustCommandCopy#1#2{\let#1#2}}{}
\makeatother
`;

export async function compileProjectWithSwiftLatex(
  project: Project,
  files: ProjectFile[],
  loadStorageFile: StorageLoader,
): Promise<CompileResult> {
  if (typeof window === "undefined") {
    return {
      ok: false,
      log: "SwiftLaTeX can only run in the browser.",
      diagnostics: ["Browser compiler unavailable during SSR"],
    };
  }

  const root = files.find((file) => file.path === project.root_file_path);
  if (!root?.content_text) {
    return {
      ok: false,
      log: `Root file "${project.root_file_path}" was not found or is empty.`,
      diagnostics: ["Missing root file"],
    };
  }

  const engine = await getSwiftLatexEngine();
  engine.flushCache();
  await engine.clearLookupCache();
  await engine.ensureFormatFile();
  const localTexFiles = await engine.loadLocalTexFiles();
  await engine.seedLocalTexCache(localTexFiles);

  for (const file of localTexFiles) {
    engine.writeFile(file.fileid, file.src);
  }

  const writableFiles = await Promise.all(
    files
      .filter((file) => file.kind !== "folder")
      .map(async (file) => {
        const data = await fileData(file, loadStorageFile);
        const path = normalizeCompilerPath(file.path);
        return data ? { path, data: addLatex2020CompatibilityShim(path, data, project.root_file_path) } : null;
      }),
  );

  for (const entry of writableFiles) {
    if (!entry) continue;
    for (const folder of parentFolders(entry.path)) {
      engine.makeFolder(folder);
    }
    engine.writeFile(entry.path, entry.data);
  }

  const mainFile = normalizeCompilerPath(project.root_file_path);
  engine.setMainFile(mainFile);
  const result = await engine.compile();

  if (result.status === 0 && result.pdf) {
    return {
      ok: true,
      pdfBlob: new Blob([result.pdf], { type: "application/pdf" }),
      log: result.log || "Recompiled with SwiftLaTeX.",
      diagnostics: [],
    };
  }

  return {
    ok: false,
    log: result.log || `SwiftLaTeX failed with status ${result.status}.`,
    diagnostics: [`SwiftLaTeX status ${result.status}`],
  };
}

async function getSwiftLatexEngine() {
  if (!sharedEngine) {
    sharedEngine = new SwiftLatexWorkerEngine();
    await sharedEngine.load();
  }
  return sharedEngine;
}

async function fileData(file: ProjectFile, loadStorageFile: StorageLoader): Promise<SwiftLatexFileData | null> {
  if (file.content_text !== null) return file.content_text;
  if (!file.storage_path) return null;

  const loaded = await loadStorageFile(file);
  if (!loaded) return null;
  if (loaded instanceof Uint8Array) return loaded;
  if (loaded instanceof ArrayBuffer) return new Uint8Array(loaded);
  return new Uint8Array(await loaded.arrayBuffer());
}

function normalizeCompilerPath(path: string) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function addLatex2020CompatibilityShim(path: string, data: SwiftLatexFileData, rootFilePath: string): SwiftLatexFileData {
  if (path !== normalizeCompilerPath(rootFilePath) || typeof data !== "string") return data;
  if (data.includes("\\DeclareCommandCopy") || data.includes("\\DeclareRobustCommandCopy")) return data;
  return `${LATEX_2020_COMPAT_SHIM}\n${data}`;
}

function parentFolders(path: string) {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
}

class SwiftLatexWorkerEngine {
  private worker: Worker | null = null;

  async load() {
    if (this.worker) return;
    this.worker = new Worker("/swiftlatex/moss-pdftex-worker.js?v=20260507-tex-seed-batch");
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("SwiftLaTeX did not finish loading.")), 30000);
      this.worker!.onmessage = (event: MessageEvent<SwiftLatexCompileMessage>) => {
        if (event.data.result !== "ok") return;
        window.clearTimeout(timer);
        this.worker!.postMessage({ cmd: "settexliveurl", url: "/api/texlive/" });
        resolve();
      };
      this.worker!.onerror = (event) => {
        window.clearTimeout(timer);
        reject(new Error(event.message || "SwiftLaTeX worker failed to load."));
      };
    });
    this.worker.onmessage = null;
  }

  flushCache() {
    this.post({ cmd: "flushcache" });
  }

  makeFolder(path: string) {
    if (path) this.post({ cmd: "mkdir", url: path });
  }

  writeFile(path: string, data: SwiftLatexFileData) {
    this.post({ cmd: "writefile", url: path, src: data });
  }

  setMainFile(path: string) {
    this.post({ cmd: "setmainfile", url: path });
  }

  async compile() {
    const worker = this.requireWorker();
    return new Promise<Required<Pick<SwiftLatexCompileMessage, "status" | "log">> & { pdf?: ArrayBuffer }>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("SwiftLaTeX compile timed out.")), 120000);
      worker.onmessage = (event: MessageEvent<SwiftLatexCompileMessage>) => {
        if (event.data.cmd !== "compile") return;
        window.clearTimeout(timer);
        worker.onmessage = null;
        resolve({
          status: event.data.status ?? -254,
          log: event.data.log ?? "No SwiftLaTeX log returned.",
          pdf: event.data.pdf,
        });
      };
      worker.onerror = (event) => {
        window.clearTimeout(timer);
        reject(new Error(event.message || "SwiftLaTeX worker failed during compile."));
      };
      worker.postMessage({ cmd: "compilelatex" });
    });
  }

  async ensureFormatFile() {
    let format = await readCachedFormatFile();
    if (!format) {
      const response = await fetch("/swiftlatex/swiftlatexpdftex.fmt");
      if (!response.ok) throw new Error("Moss could not load the bundled SwiftLaTeX format file.");
      format = new Uint8Array(await response.arrayBuffer());
      await writeCachedFormatFile(format);
    }
    await this.writeCacheFile(PDFTEX_FORMAT_CACHE_KEY, PDFTEX_FORMAT_FILE_ID, format);
  }

  async loadLocalTexFiles() {
    const manifestResponse = await fetch("/texlive/pdftex/manifest.json");
    if (!manifestResponse.ok) return [];
    const filenames = (await manifestResponse.json()) as string[];

    const files = await Promise.all(filenames.map(async (filename): Promise<SwiftLatexCacheSeedFile | null> => {
      const response = await fetch(`/texlive/pdftex/${encodeURIComponent(filename)}`);
      if (!response.ok) return null;
      const data = new Uint8Array(await response.arrayBuffer());
      return {
        fileid: filename,
        cacheKeys: LOCAL_TEX_FORMATS.map((format) => `${format}/${filename}`),
        src: data,
      };
    }));
    return files.filter(isSwiftLatexCacheSeedFile);
  }

  async seedLocalTexCache(files: SwiftLatexCacheSeedFile[]) {
    await this.writeCacheFiles(files);
  }

  async clearLookupCache() {
    const worker = this.requireWorker();
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => resolve(), 5000);
      worker.onmessage = (event: MessageEvent<SwiftLatexCompileMessage>) => {
        if (event.data.cmd !== "cleartexlookupcache") return;
        window.clearTimeout(timer);
        worker.onmessage = null;
        resolve();
      };
      worker.postMessage({ cmd: "cleartexlookupcache" });
    });
  }

  private async writeCacheFile(cacheKey: string, fileid: string, data: Uint8Array) {
    const worker = this.requireWorker();
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("SwiftLaTeX cache write timed out.")), 30000);
      worker.onmessage = (event: MessageEvent<SwiftLatexCompileMessage>) => {
        if (event.data.cmd !== "writecachefile") return;
        window.clearTimeout(timer);
        worker.onmessage = null;
        if (event.data.result === "ok") {
          resolve();
        } else {
          reject(new Error("SwiftLaTeX could not write the local format cache."));
        }
      };
      worker.onerror = (event) => {
        window.clearTimeout(timer);
        reject(new Error(event.message || "SwiftLaTeX worker failed while writing its format cache."));
      };
      worker.postMessage({ cmd: "writecachefile", cacheKey, fileid, src: data });
    });
  }

  private async writeCacheFiles(files: SwiftLatexCacheSeedFile[]) {
    if (!files.length) return;
    const worker = this.requireWorker();
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("SwiftLaTeX local TeX cache write timed out.")), 30000);
      worker.onmessage = (event: MessageEvent<SwiftLatexCompileMessage>) => {
        if (event.data.cmd !== "writecachefiles") return;
        window.clearTimeout(timer);
        worker.onmessage = null;
        if (event.data.result === "ok") {
          resolve();
        } else {
          reject(new Error("SwiftLaTeX could not write the local TeX cache."));
        }
      };
      worker.onerror = (event) => {
        window.clearTimeout(timer);
        reject(new Error(event.message || "SwiftLaTeX worker failed while writing the local TeX cache."));
      };
      worker.postMessage({ cmd: "writecachefiles", files });
    });
  }

  private post(message: Record<string, unknown>) {
    this.requireWorker().postMessage(message);
  }

  private requireWorker() {
    if (!this.worker) throw new Error("SwiftLaTeX is not loaded.");
    return this.worker;
  }
}

async function readCachedFormatFile() {
  const cache = await openSwiftLatexCache();
  return new Promise<Uint8Array | null>((resolve, reject) => {
    const request = cache
      .transaction("files", "readonly")
      .objectStore("files")
      .get(PDFTEX_FORMAT_CACHE_KEY);
    request.onsuccess = () => {
      const value = request.result as { data?: ArrayBuffer } | undefined;
      resolve(value?.data ? new Uint8Array(value.data) : null);
    };
    request.onerror = () => reject(request.error);
  });
}

async function writeCachedFormatFile(data: Uint8Array) {
  const cache = await openSwiftLatexCache();
  return new Promise<void>((resolve, reject) => {
    const request = cache
      .transaction("files", "readwrite")
      .objectStore("files")
      .put({ key: PDFTEX_FORMAT_CACHE_KEY, data: data.buffer.slice(0) }, PDFTEX_FORMAT_CACHE_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function openSwiftLatexCache() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("moss-swiftlatex-cache", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("files");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function isSwiftLatexCacheSeedFile(file: SwiftLatexCacheSeedFile | null): file is SwiftLatexCacheSeedFile {
  return file !== null;
}
