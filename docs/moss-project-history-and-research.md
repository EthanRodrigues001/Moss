# Moss: Project History, Research Notes, and Current Architecture

> Living document.
> This file records what Moss started as, what changed during development, why those choices changed, and what the current build is trying to become. Keep appending dated notes as the project evolves.

Last updated: 2026-05-17

## 1. Original Idea

Moss started as a single-user, web-based LaTeX editor inspired by the strengths of Overleaf, Dociere, and newer AI-native scientific writing tools such as OpenAI Prism.

The first priority was not collaboration. The first priority was a powerful personal LaTeX editor that works in the browser, stores projects in the cloud, supports uploaded diagrams and templates, and gives a strong editing experience before adding advanced AI workflows.

The long-term ambition is bigger:

- A section-aware LaTeX editor where sections are first-class data.
- An AI-first document model that can assign different document sections to different agents.
- A future sub-agent workflow where agents work on isolated sections and produce safe patches.
- Hash-based patch validation so an AI agent cannot overwrite a section that changed after it read it.
- A system that keeps LaTeX as the source of truth instead of replacing it with a simplified document format.

The project name became **Moss**.

## 2. Initial Feature Target

The original desired feature list was:

1. Equation generation with a built-in equation editor that outputs LaTeX syntax.
2. Zotero-like citation management with reliable storage and export in multiple formats.
3. Sections View that reduces project complexity by showing relevant document sections and their contents.
4. Overleaf-like file tree in a sidebar.
5. Code and visual editor modes like Overleaf.
6. Compile button plus auto compile.
7. Undo, redo, and download options.
8. Multiple documents and LaTeX files, including rename and delete.
9. Uploaded project assets such as diagrams, images, `.cls`, `.sty`, and `.bib` files.
10. Direct PDF and ZIP downloads, without storing compiled PDFs.

The early architectural preference was serverless because the goal was to deploy the Next.js app to Vercel free tier and avoid paid infrastructure.

## 3. Early Architecture Plan

The first serious plan was:

- Frontend: Next.js App Router with TypeScript.
- UI: shadcn/ui, Tailwind, lucide-react, Sonner.
- Auth and database: Supabase Auth and Supabase Postgres.
- File storage: Supabase Storage for binary assets.
- Text files: stored in Postgres as `project_files.content_text`.
- Binary assets: stored in Supabase Storage under `user_id/project_id/path/to/file`.
- Generated PDFs: direct browser downloads only, not stored.
- ZIP export: created client-side with JSZip.
- Optional offline cache: IndexedDB/Dexie only as cache, not source of truth.
- Compiler: initially hoped to use browser-side LaTeX WASM to avoid server cost.

The important correction during planning was that **IndexedDB is not a cloud database**. It can help offline, but it cannot be the primary source of truth for a web app used across machines. That moved the source of truth to Supabase.

## 4. Current Build Snapshot

As of this build, Moss is a Next.js application backed by Supabase plus a Rust/Tectonic compiler service.

Current major files:

- `components/moss-app.tsx`: main editor shell, project/file operations, compile flow, panels, upload, downloads, lint integration.
- `components/pdf-preview.tsx`: PDF.js-based rendered PDF preview with clickable text chunks.
- `components/latex-visual-editor.tsx`: Tiptap-based visual editing surface.
- `components/equation-editor.tsx`: MathLive + KaTeX equation editor.
- `lib/remote-compiler.ts`: sends the project file tree to the Rust compiler backend.
- `lib/compiler.ts`: older custom browser preview fallback.
- `lib/latex-lint.ts`: local LaTeX linting plus parsed compiler log diagnostics.
- `lib/latex-repair.ts`: repair helpers for common damaged LaTeX serialization.
- `lib/moss-sample.ts`: sample document, sample notes file, sample BibTeX, and sample diagram.
- `backend/src/main.rs`: Rust Axum compiler backend using Tectonic.
- `backend/bin/tectonic.exe`: local bundled Tectonic executable for development.
- `delete.md`: list of old compiler experiment files to remove later.

Current dependencies include:

- Next.js 16.2.5
- React 19.2.4
- Supabase JS 2.105.3
- Monaco editor wrapper
- Tiptap 3
- MathLive
- KaTeX
- citation-js
- JSZip
- PDF.js
- Rust Axum/Tokio backend

## 5. Database And Storage Model

Moss uses Supabase as the cloud source of truth.

### Tables

`projects`

- Owns the project metadata.
- Fields include `id`, `user_id`, `title`, `root_file_path`, timestamps.
- Every project belongs to `auth.uid()`.

`project_files`

- Stores the file tree.
- Text files use `content_text`.
- Binary files use `storage_path`, `storage_provider`, `storage_key`, and metadata.
- Supports paths such as `main.tex`, `references.bib`, `sections/notes.tex`, `figures/diagram.png`.

`sections`

- Stores parsed section records for future AI workflows.
- Includes heading, level, order, content hash, source start/end.
- This is the foundation for future section-scoped agent edits.

`citations`

- Stores citation records with `cite_key`, CSL JSON, BibTeX, and tags.
- Intended to support citation-js import/export flows.

### Storage

Supabase Storage bucket:

```text
project-assets
```

Path convention:

```text
user_id/project_id/path/to/file.png
```

Reasoning:

- Text files remain queryable and editable in Postgres.
- Binary assets are not forced into Postgres.
- LaTeX paths remain project-relative, so `\includegraphics{figures/diagram.png}` works after compile.
- Supabase Storage avoids needing Cloudflare R2, Vercel Blob, or UploadThing in v1.

### Security

The Supabase migration enables Row Level Security on project tables and uses policies based on `auth.uid()`. Storage object policies use the first folder segment of the object path as the user id. This matches Supabase's own RLS/security model, where policies can restrict rows and storage objects per authenticated user.

## 6. UI Evolution

Moss moved toward an Overleaf-style layout:

- Left sidebar for projects and file tree.
- Center editor with Code and Visual modes.
- Right panel for Preview, Logs, Sections, Citations, and Math.
- Top compile controls with a dropdown for auto compile.
- Direct download controls for PDF, active file, and ZIP.

The preview was repeatedly refined because early versions were hard to read:

- The PDF/preview area was made larger and more document-like.
- Multiple page rendering was added.
- Zoom controls were wired into the preview.
- PDF.js was used when real PDF blobs became available.
- Rendering cancellation from rapid recompiles was caught so it does not produce unhandled promise errors.

## 7. Code Editor And Visual Editor

### Code Editor

The code editor currently uses Monaco. It supports:

- LaTeX syntax highlighting.
- Active file editing.
- Insertion at cursor.
- Markers for lint and compiler diagnostics.
- Jumping to lines from log issues.
- Source jumps from preview text clicks.

There was discussion about moving to CodeMirror 6 later. CodeMirror 6 may be a better long-term editor core for deeply custom LaTeX workflows because it is modular, easier to extend with custom syntax/lint tooling, and lighter than Monaco. For now Monaco remains in place.

### Visual Editor

The visual editor uses Tiptap and converts between:

```text
Monaco/code source -> parse LaTeX -> Tiptap document
Tiptap edits -> serialize document body -> LaTeX source
```

The visual editor is intentionally not a complete LaTeX renderer. It is a structured editing surface for common document parts:

- Paragraphs
- Sections/subsections
- Lists
- Inline math
- Display math
- Raw LaTeX blocks for unsupported structures

IEEE format exposed the hard problem: visual editors often struggle with complex LaTeX macros, custom author blocks, multi-column output, and class-specific behavior. The current approach keeps LaTeX source as the real truth and lets the visual editor handle what it safely understands.

## 8. Equation Editor

The equation workflow is:

- MathLive provides the WYSIWYG math input surface.
- KaTeX renders a live preview.
- Confirming an equation inserts the generated LaTeX at the code cursor.
- Visual mode can represent math nodes and edit them.

This is deliberately separate from `@react-pdf/renderer`. That package generates PDFs from React component trees; it does not compile `.tex` documents. It is useful for React-designed PDFs, not for LaTeX source projects.

## 9. Citation Direction

Citation management is planned around `citation-js` because it can parse and generate citation formats without depending on a paid API key.

Planned/import paths:

- Paste DOI -> resolve metadata -> CSL JSON -> Supabase.
- Paste raw BibTeX -> parse -> CSL JSON -> Supabase.
- Manual entry -> CSL JSON -> Supabase.
- Export selected/project citations as `.bib`.

Current linting and compiler log parsing already highlights missing BibTeX keys and undefined citations, making citation problems more visible while editing.

## 10. Compiler Journey

The compiler changed several times. This was the hardest part of the project so far.

### Stage 1: Placeholder Browser Compiler

The earliest compile flow was a custom browser preview. It did not truly compile LaTeX. It parsed recognizable LaTeX constructs and produced a document-like HTML preview.

Why it existed:

- It proved the direct-download flow.
- It let the editor UI be built before a real compiler existed.
- It avoided server costs.

Problems:

- It was not real LaTeX.
- Formatting was approximate.
- IEEE formatting, real packages, real tables, floats, bibliographies, and images could not be faithfully handled.
- Generated PDFs from this preview did not match real LaTeX output.

Status:

- Still present as `lib/compiler.ts` as a fallback when `NEXT_PUBLIC_COMPILER_API_URL` is not configured.
- Listed in `delete.md` as something to remove later once the real compiler is stable.

### Stage 2: SwiftLaTeX / Browser WASM Attempt

SwiftLaTeX was attractive because it promised browser-side compilation:

- No compile server.
- Lower running cost.
- Works well with the original serverless dream.
- Could theoretically support offline compilation after assets are cached.

What went wrong:

1. CORS blocked remote SwiftLaTeX TeX Live asset downloads.
2. A Next.js proxy was added for TeX Live files.
3. The compiler then downloaded format and package files slowly.
4. It failed on missing core files such as `pdflatex.ini` and `article.cls`.
5. Manual seeding of TeX Live files caused version mismatch issues.
6. Newer LaTeX packages used commands such as `\DeclareCommandCopy` and `\AddToHook`, but the SwiftLaTeX engine/package combination was too old or inconsistent.
7. Cache writes timed out.
8. The first compile experience was too slow and fragile.

Representative failures:

```text
File `article.cls' not found.
Undefined control sequence \DeclareCommandCopy
Undefined control sequence \AddToHook
SwiftLaTeX cache write timed out.
```

Conclusion:

SwiftLaTeX was not a good default compiler for Moss v1. The idea is elegant, but getting a reliable, modern, package-complete, fast browser compiler is not simple. It also pushes too much package/cache complexity into the client.

Status:

- Kept only as historical code for now.
- Listed in `delete.md`:
  - `lib/swiftlatex-compiler.ts`
  - `public/swiftlatex`
  - `public/texlive/pdftex`
  - `app/api/texlive/[engine]/[...path]/route.ts`

### Stage 3: Custom Preview Made More Production-Like

After SwiftLaTeX frustration, the project temporarily returned to the custom compiler and made it better:

- Added support for multiple pages.
- Added larger document-style preview.
- Added image preview support.
- Added rough IEEE-style two-column rendering.
- Added tables, figures, lists, abstract, keywords, and equations.
- Added direct PDF generation from visible preview.

This helped the UI, but it still was not real LaTeX. The more the sample document resembled an actual IEEE paper, the more obvious it became that approximating LaTeX in browser HTML is a dead end for a serious editor.

### Stage 4: Rust/Tectonic Backend

The current build uses a Rust backend running Tectonic.

Frontend:

```text
Moss editor -> collect all project files -> fetch Supabase Storage blobs -> send JSON to backend
```

Backend:

```text
Axum endpoint -> write files to temp workspace -> run Tectonic -> return PDF bytes
```

Why Tectonic is better for the current build:

- It is a real TeX/LaTeX engine, not a visual approximation.
- It is based on XeTeX and supports modern font/unicode behavior.
- It is designed to hide interactive TeX prompts and run as a more automation-friendly tool.
- It can run on a backend such as Render.
- It returns actual PDF output.
- It avoids trying to compile huge TeX engines inside every browser.
- It supports `.tex`, `.bib`, images, `.sty`, `.cls`, and multi-file projects when the full file tree is sent.

Current backend behavior:

- `GET /health` returns `{ ok: true, compiler: "tectonic" }`.
- `POST /compile` accepts `rootFilePath`, `projectTitle`, and all project files.
- Text files are sent as UTF-8 text.
- Binary assets are sent as base64.
- The backend rejects unsafe paths such as parent-directory traversal.
- It runs Tectonic with:
  - `--keep-logs`
  - `--synctex`
  - `--outdir`
  - a temp working directory
  - `TECTONIC_CACHE_DIR`
- It returns `application/pdf` on success.
- It returns JSON logs/diagnostics on failure.
- It does not store compiled PDFs.

Tradeoffs:

- It is no longer purely serverless.
- Render free instances can sleep, so the first compile after idle may be slower.
- Tectonic still needs a package bundle/cache.
- Some font issues can occur depending on runtime environment.
- The backend must be secured and rate-limited before public release.

Why this is still the best current direction:

The goal of Moss is a serious LaTeX editor. A serious LaTeX editor needs real LaTeX compilation. The Tectonic backend gives Moss actual PDF output while keeping the frontend lightweight and keeping compiled PDFs out of permanent storage.

## 11. Dociere Research

The original inspiration included:

- `Dociere/DocierePro`
- `Dociere/DociereServer`

### What Dociere Pro Is

Dociere Pro describes itself as an offline-first desktop application for academic and technical writing. Its README says it combines LaTeX precision with modern visual editing, synchronized editors, offline data management, versioning, and Zotero-compatible citation support. It is built on Electron.

Important Dociere Pro features from its README:

- Equation generation.
- Zotero-like citation manager.
- Collaborative editing.
- AI chat mode.
- Sections View.

This heavily influenced Moss's feature direction.

### How Dociere Pro Compiles LaTeX

From `DocierePro/server.js`, Dociere Pro compiles with a local `pdflatex`/TinyTeX flow.

Key observations:

- It imports `exec` and `spawn` from Node `child_process`.
- It has a `setup-tex` script: `node scripts/setup-tinytex.js`.
- It imports `getTinyTexBinPath` from `scripts/setup-tinytex.js`.
- In development it can use local `pdflatex`.
- In production it uses TinyTeX paths.
- `runPdfLatexPermissive()` spawns `pdflatex`.
- The command includes:
  - `-shell-escape`
  - `-output-directory=...`
  - `-interaction=nonstopmode`
  - `-file-line-error`
  - `-synctex=1`
- It writes all project files into a temporary job directory before compiling.
- It preserves folder structure.
- It writes binary image files from base64 into the job directory.
- It sets `TEXINPUTS` so LaTeX can resolve project folders such as `sections`.
- It can run BibTeX if `.bib` files exist.
- It reruns PDFLaTeX when labels or citations need another pass.
- It saves SyncTeX output and exposes a `/api/synctex` route.
- It includes a missing-package installer using `tlmgr`.
- It streams the final PDF back to the client.

This is a practical desktop/server-local approach. It expects a LaTeX distribution to be available, either locally or through TinyTeX. Moss's current Tectonic backend is similar in spirit because it writes a complete temporary project workspace and returns a PDF, but Moss uses Rust/Axum plus Tectonic instead of Node/Express plus PDFLaTeX/TinyTeX.

### What Moss Learned From Dociere

Dociere reinforced these ideas:

- Preserve the full file tree.
- Compile from a project workspace, not a single text string.
- Images must be written as binary files before compile.
- Multi-pass compilation matters for citations and references.
- SyncTeX/source navigation is important.
- A serious editor needs both project/file management and compile diagnostics.

Moss differs in deployment target:

- Dociere Pro is desktop/Electron-first.
- Moss is web-first with Next.js and Supabase.
- Dociere stores and compiles locally.
- Moss stores projects in Supabase and compiles through a deployable backend.

## 12. Competitor And Reference Study

### Overleaf

Overleaf is the main product reference for the editor experience.

Relevant Overleaf strengths:

- Code editor and visual editor.
- File tree and project structure.
- Compile/recompile button.
- Auto compile every few seconds.
- Error logs and syntax checks.
- PDF preview.
- Templates.
- Bibliography and citation integrations.
- Collaboration.
- History/versioning.

Important lesson:

Moss should copy the editing ergonomics, not the whole business model. Moss v1 is single-user and private by default. Collaboration can come later.

Overleaf also shows that compile UX matters as much as compiler technology. Users need:

- A clear Recompile button.
- Auto compile toggle.
- Logs grouped into errors/warnings/info.
- Click-to-jump from log to source line.
- A preview that looks like the final PDF.

### OpenAI Prism

OpenAI Prism is relevant because it is AI-native and LaTeX-native. OpenAI describes Prism as a free LaTeX editor and scientific workspace with ChatGPT/Codex integrated into writing and collaboration.

Prism validates the long-term Moss thesis:

- Scientific writing workflows are fragmented.
- AI should be project-aware.
- Citations, literature, editing, formatting, and compiling should live in one workspace.
- LaTeX remains important for scientific writing.

Moss should not try to beat Prism by scale. Moss's opportunity is being open, understandable, single-user friendly, and built around a section-aware data model that can become agent-safe.

### Dociere

Dociere is the closest open-source inspiration because it already attempts:

- LaTeX editing.
- Visual editing.
- Equation generation.
- Citation manager.
- Sections View.
- AI chat.
- Desktop offline-first workflows.

Moss borrows the ambition but changes the platform:

- Browser instead of Electron.
- Supabase instead of local-only project storage.
- Rust/Tectonic backend instead of Node/TinyTeX PDFLaTeX.
- Single-user v1 instead of collaboration-first.

### LaTeX.Online And API Compilers

LaTeX.Online is an example of a cloud compiler/API style service. It shows that a remote compile API is a known pattern:

```text
send source/project -> get PDF
```

Moss's backend follows the same general idea, but keeps the compiler service under the project's control instead of relying on a third-party API with unknown limits.

### Typst

Typst is not a LaTeX editor, but it is an important competitor in the "scientific writing without pain" category. Typst's lesson is speed and live preview. Moss should respect that expectation, but Moss's mission is different: preserve LaTeX compatibility for existing academic templates such as IEEE, ACM, journals, theses, and university formats.

## 13. Current Compile Flow In Detail

### Frontend Compile Flow

In `components/moss-app.tsx`:

1. User clicks Compile or auto compile triggers.
2. Active editor value is merged into the in-memory file list.
3. Local linting checks for obvious LaTeX syntax errors.
4. The active file is saved to Supabase.
5. Common damaged LaTeX serialization can be repaired.
6. Missing sample files/assets may be added for the starter project.
7. If `NEXT_PUBLIC_COMPILER_API_URL` is configured, Moss calls `compileProjectRemotely()`.
8. If not configured, Moss falls back to `compileProject()` custom preview.
9. On success, the right panel switches to Preview.
10. On failure, manual compiles switch to Logs.

### Remote Compiler Payload

`lib/remote-compiler.ts` builds payload files:

- Text files:

```json
{
  "path": "main.tex",
  "kind": "tex",
  "contentText": "..."
}
```

- Binary files:

```json
{
  "path": "figures/diagram.png",
  "kind": "image",
  "contentBase64": "..."
}
```

The backend sees the same project-relative paths that LaTeX sees.

### Backend Compile Flow

`backend/src/main.rs`:

1. Validate request is not empty.
2. Validate all file paths are safe.
3. Create a temporary workspace.
4. Write every file to disk.
5. Ensure the root file exists.
6. Run Tectonic.
7. Read the generated PDF.
8. Return the PDF as `application/pdf`.
9. Return logs as JSON if compile fails.

### Why Direct Download Is Preserved

The current design still avoids storing compiled PDFs:

- PDF preview uses a browser Blob.
- PDF download uses the returned Blob.
- ZIP export builds an archive from current source files and assets.
- Supabase stores project source and assets, not generated output.

This reduces storage usage and keeps the database focused on editable project state.

## 14. Auto Compile Debounce And Loop Fixes

Auto compile originally risked too many backend requests.

Current protections:

- Auto compile waits `AUTO_COMPILE_DEBOUNCE_MS`.
- Auto compile only starts after a real user edit, tracked by `editorRevision`.
- Programmatic file loads reset `editorRevision` to `0`.
- Compile signatures ignore timestamp churn.
- If a compile result matches the last compiled signature, auto compile skips it.
- If a compile is already running, auto compile queues only one follow-up.
- Sample file/diagram repair toasts are only shown on manual compile.
- PDF.js rendering cancellations are caught so rapid preview replacement does not crash the page.

This matters because Supabase writes can update `updated_at`, and helper functions can modify the file list. Without signature guards, the app can accidentally treat its own maintenance writes as user edits and recompile in a loop.

## 15. Linting And Diagnostics

Moss now has two layers of diagnostics.

### Local Lint

`lib/latex-lint.ts` catches common source issues before compile:

- Unbalanced braces.
- Unclosed math delimiters.
- Mismatched `\begin` and `\end`.
- Missing project files referenced by `\input`.
- Missing image assets referenced by `\includegraphics`.
- Missing `.bib` files.
- Missing BibTeX keys.

These appear as Monaco markers.

### Compile Log Parsing

Tectonic logs are parsed into Overleaf-style issue cards:

- Errors.
- Warnings.
- Info.
- Undefined citations.
- Undefined references.
- Missing files.
- Package errors.
- Font warnings.

The log panel now shows grouped cards plus raw logs. Clicking an issue can jump to the source line when the log contains one.

## 16. Asset Uploads

Moss supports:

- Uploading individual LaTeX/text files.
- Uploading binary assets.
- Uploading folders.
- Preserving paths.

This is necessary because real LaTeX projects are not single files. A template may include:

```text
main.tex
references.bib
sections/introduction.tex
figures/diagram.png
IEEEtran.cls
custom.sty
```

The most important bug learned here was that images must be sent to the compiler as real binary files in the correct relative path. Merely showing a storage note in the file tree is not enough. The compiler only sees what is written into the temporary workspace.

## 17. Current Known Rough Edges

These are not failures; they are the next build map.

- Visual editor is useful but not yet robust for all IEEE/custom LaTeX structures.
- SyncTeX is enabled in Tectonic, but true PDF click-to-source should eventually use SyncTeX data instead of text matching.
- The custom preview fallback should eventually be removed or clearly labeled.
- SwiftLaTeX artifacts should be deleted after the Tectonic path is fully stable.
- Tectonic on Render may need cache strategy improvements.
- Backend needs production security hardening before public use.
- Citation manager import UI needs deeper polish.
- Multi-pass bibliography/reference behavior should be tested with larger real projects.
- CodeMirror 6 remains a possible future replacement for Monaco.

## 18. Why The Current Build Is Better

The current architecture is better than the earlier versions because it separates concerns correctly:

- Next.js handles the app experience.
- Supabase handles authenticated cloud persistence.
- Supabase Storage handles uploaded binary assets.
- Rust/Axum handles the compile API.
- Tectonic handles real LaTeX compilation.
- PDF.js handles real PDF preview.
- Monaco/Tiptap handle editing modes.
- MathLive/KaTeX handle equation editing.

The big improvement is that Moss no longer pretends HTML preview is LaTeX compilation. It can now send a real project workspace to a real compiler and receive a real PDF.

## 19. Recommended Next Build Steps

1. Finish stabilizing the compile loop and sample maintenance behavior.
2. Keep `npm run lint` and `npm run build` clean after each major UI/compiler patch.
3. Add a backend integration test that compiles a real multi-file IEEE sample with image and `.bib`.
4. Add a frontend test project fixture that uploads folders and verifies paths.
5. Improve log cards with exact line/column extraction.
6. Add a clear compiler status indicator:
   - backend connected
   - backend unreachable
   - compiling
   - cache warming
7. Add citation manager import flows.
8. Decide whether Monaco remains or CodeMirror 6 becomes the long-term code editor.
9. Use SyncTeX for proper preview-to-source navigation.
10. Prepare Render deployment notes and environment variable checklist.

## 20. Sources And Research Links

- Overleaf features overview: https://www.overleaf.com/about/features-overview
- Overleaf recompiling docs: https://docs.overleaf.com/getting-started/recompiling-your-project
- Tectonic Rust docs: https://docs.rs/tectonic/latest/tectonic/
- Supabase Row Level Security docs: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Storage access control docs: https://supabase.com/docs/guides/storage/security/access-control
- OpenAI Prism page: https://openai.com/prism/
- OpenAI Prism announcement: https://openai.com/index/introducing-prism/
- Dociere Pro repository: https://github.com/Dociere/DocierePro
- Dociere Server repository: https://github.com/Dociere/DociereServer
- Dociere Pro `server.js`: https://github.com/Dociere/DocierePro/blob/main/server.js
- Dociere Pro `package.json`: https://github.com/Dociere/DocierePro/blob/main/package.json
- LaTeX.Online: https://latexonline.cc/

## 21. How To Keep Extending This File

Use this format for new build notes:

```md
## YYYY-MM-DD Build Note

### What changed

### Why it changed

### What broke

### What fixed it

### What this means for Moss
```

The most useful notes are not just "what changed", but "why the previous idea failed". That is the part that will make this strong as an ebook later.
