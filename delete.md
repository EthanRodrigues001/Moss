# Moss Cleanup Notes

Delete later after the Rust Render compiler is stable:

- `lib/swiftlatex-compiler.ts` - failed SwiftLaTeX browser compiler adapter.
- `components/pdf-preview.tsx` and `pdfjs-dist` - keep only if the remote compiler PDF preview path remains useful.
- `public/swiftlatex` - downloaded SwiftLaTeX assets.
- `public/texlive/pdftex` - temporary hand-seeded TeX Live files from the SwiftLaTeX experiment.
- `app/api/texlive/[engine]/[...path]/route.ts` - SwiftLaTeX asset proxy.
- `public/pdf.worker.min.mjs` - PDF.js worker copied for the SwiftLaTeX/PDF.js path.

Keep for v1:

- `lib/compiler.ts` - local browser preview fallback when `NEXT_PUBLIC_COMPILER_API_URL` is not configured.
- `html2canvas` and `jspdf` - used to export the visible browser preview as a PDF fallback.
