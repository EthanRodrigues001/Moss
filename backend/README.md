# Moss Rust Compiler Backend

This is the Render-ready Rust compiler service for Moss. It accepts the current project file tree as JSON, writes it to a temporary workspace, runs `latexmk`/PDFLaTeX by default, and returns the compiled PDF as a short-lived direct preview/download artifact. It does not store PDFs in Supabase.

## Local Run

Install `latexmk` with a TeX Live distribution for the main path. Tectonic is still supported as a fallback. On Windows, Tectonic's official quick installer is:

```powershell
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://drop-ps1.fullyjustified.net'))
```

For local development in this repo, Moss also auto-detects:

```text
backend/bin/tectonic.exe
```

You can still move `tectonic.exe` into a directory on `PATH`, or set `TECTONIC_BIN` to its full path before running this backend.

Then run the Axum service:

```bash
cd backend
cargo run
```

The service starts at `http://localhost:8787`.

Verify compiler tools are visible:

```bash
latexmk -v
tectonic --help
```

Moss stores Tectonic's local bundle cache in:

```text
backend/.tectonic-cache
```

The first real compile may download the bundle; later compiles reuse the cache.

Set this in the Next.js app:

```bash
NEXT_PUBLIC_COMPILER_API_URL=http://localhost:8787
```

## Render Deploy

Deploy this folder as a Docker web service.

Recommended environment variables:

```bash
CORS_ORIGIN=*
MAX_UPLOAD_MB=80
COMPILE_TIMEOUT_MS=60000
MOSS_COMPILER_ENGINE=latexmk
LATEXMK_BIN=latexmk
SYNCTEX_BIN=synctex
ENABLE_XELATEX=false
ENABLE_LUALATEX=false
COMPILE_WORK_DIR=/tmp/moss-compile-work
COMPILE_ARTIFACT_DIR=/tmp/moss-compile-artifacts
COMPILE_ARTIFACT_TTL_MS=600000
```

Render free instances can sleep, so the first compile after idle may be slow. The Docker image installs Perl, `latexmk`, and PDFLaTeX-focused TeX Live packages. `CORS_ORIGIN=*` is convenient for early testing; replace it with your final Vercel domain before a public launch. XeLaTeX/LuaLaTeX projects are detected and rejected with a clear structured error unless `ENABLE_XELATEX=true` or `ENABLE_LUALATEX=true` is set and the image is extended for those engines.

## API

`GET /health` returns:

```json
{ "ok": true, "compiler": "moss-compiler" }
```

`POST /compile` accepts:

```json
{
  "projectTitle": "Moss Draft",
  "rootFilePath": "main.tex",
  "files": [
    { "path": "main.tex", "contentText": "\\documentclass{article}\\begin{document}Hi\\end{document}" },
    { "path": "figures/diagram.png", "contentBase64": "..." }
  ]
}
```

On success, the response body is JSON:

```json
{
  "ok": true,
  "compileId": "short-lived-id",
  "compiler": "latexmk",
  "engine": "pdflatex",
  "durationMs": 1234,
  "filename": "Moss_Draft.pdf",
  "pdfBase64": "...",
  "log": "Recompiled with Moss pdflatex compiler in 1234 ms.",
  "diagnostics": [],
  "synctexAvailable": true
}
```

`POST /synctex/reverse` accepts `{ "compileId": "...", "page": 1, "x": 120, "y": 240 }` and returns `{ "ok": true, "filePath": "main.tex", "line": 42 }` while the short-lived artifact exists.
