import katex from "katex";
import type { CompileResult, Project, ProjectFile } from "@/lib/types";
import { logCompilerUsed } from "@/lib/compiler-console";

type PreviewBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "abstract"; text: string }
  | { kind: "keywords"; text: string }
  | { kind: "math"; text: string }
  | { kind: "image"; path: string; caption?: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; rows: string[][]; caption?: string };

type PreviewDocument = {
  title: string;
  author: string;
  authors: PreviewAuthor[];
  date: string;
  layout: "article" | "ieee";
  blocks: PreviewBlock[];
};

type PreviewAuthor = {
  name: string;
  lines: string[];
};

export async function compileProject(project: Project, files: ProjectFile[], imageUrls: Record<string, string> = {}): Promise<CompileResult> {
  const root = files.find((file) => file.path === project.root_file_path);
  if (!root?.content_text) {
    return {
      ok: false,
      log: `Root file "${project.root_file_path}" was not found or is empty.`,
      diagnostics: ["Missing root file"],
    };
  }

  if (!root.content_text.includes("\\begin{document}") || !root.content_text.includes("\\end{document}")) {
    return {
      ok: false,
      log: "The root file must contain \\begin{document} and \\end{document}.",
      diagnostics: ["Invalid LaTeX document structure"],
    };
  }

  const expanded = expandInputs(root.content_text, files);
  const preview = parseLatex(expanded, project);
  const previewHtml = renderPreviewHtml(preview, imageUrls);
  const pageCount = countPreviewPages(previewHtml);
  logCompilerUsed({ source: "browser", compiler: "moss-preview", engine: preview.layout, ok: true });

  return {
    ok: true,
    previewHtml,
    pageCount,
    log: [
      "Recompiled with Moss custom browser preview compiler.",
      `Layout: ${preview.layout === "ieee" ? "IEEE-style two column" : "article-style single column"}.`,
      `Pages: ${pageCount}.`,
      "Generated PDFs use the visible preview pages directly; compiled output is not stored.",
    ].join("\n"),
    diagnostics: [],
  };
}

function countPreviewPages(html: string) {
  const matches = html.match(/class="[^"]*\bpage\b/g);
  return Math.max(1, matches?.length ?? 1);
}

function expandInputs(source: string, files: ProjectFile[]) {
  return source.replace(/\\(?:input|include)\{([^}]+)\}/g, (_match, path: string) => {
    const normalized = path.endsWith(".tex") ? path : `${path}.tex`;
    const file = files.find((item) => item.path === normalized || item.path === path);
    if (!file?.content_text) return `\n[Missing input: ${path}]\n`;
    return `\n${file.content_text}\n`;
  });
}

function parseLatex(source: string, project: Project): PreviewDocument {
  const layout = /\\documentclass(?:\[[^\]]*\])?\{IEEEtran\}/.test(source) || source.includes("\\IEEEauthorblockN") ? "ieee" : "article";
  const title = cleanLatex(commandValue(source, "title") || project.title);
  const authorSource = commandValue(source, "author");
  const authors = parseAuthors(authorSource);
  const author = authors.length ? authors.map((item) => item.name).join(", ") : cleanLatex(authorSource || "Moss");
  const date = cleanLatex((commandValue(source, "date") || todayLabel()).replace("\\today", todayLabel()));
  const body = removeCommandBlocks(documentBody(source), ["title", "author", "thanks"]);
  const lines = body.replace(/\r/g, "").split("\n");
  const blocks: PreviewBlock[] = [];
  const paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph.length = 0;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = stripComment(lines[i]);
    const line = raw.trim();
    if (!line || line === "\\maketitle") {
      flushParagraph();
      continue;
    }

    if (line.startsWith("\\title") || line.startsWith("\\author") || line.startsWith("\\IEEEauthorblock") || line === "\\and") {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^\\(section|subsection|subsubsection)\*?\{(.+)\}$/);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", level: headingLevel(heading[1]), text: heading[2] });
      continue;
    }

    if (line.startsWith("\\[")) {
      flushParagraph();
      const math: string[] = [];
      const firstLine = line.replace(/^\\\[/, "").replace(/\\\]$/, "").trim();
      if (firstLine) math.push(firstLine);
      while (i + 1 < lines.length && !lines[i + 1].includes("\\]")) {
        i += 1;
        math.push(lines[i]);
      }
      if (i + 1 < lines.length) {
        i += 1;
        const lastLine = lines[i].replace(/\\\]/, "").trim();
        if (lastLine) math.push(lastLine);
      }
      blocks.push({ kind: "math", text: math.join("\n").trim() });
      continue;
    }

    if (/^\\begin\{(?:equation|align)\*?\}/.test(line)) {
      flushParagraph();
      const math: string[] = [];
      while (i + 1 < lines.length && !/\\end\{(?:equation|align)\*?\}/.test(lines[i + 1])) {
        i += 1;
        math.push(lines[i]);
      }
      i += 1;
      blocks.push({ kind: "math", text: math.join("\n").trim() });
      continue;
    }

    if (line.startsWith("\\begin{itemize}") || line.startsWith("\\begin{enumerate}")) {
      flushParagraph();
      const ordered = line.startsWith("\\begin{enumerate}");
      const items: string[] = [];
      while (i + 1 < lines.length && !lines[i + 1].startsWith(`\\end{${ordered ? "enumerate" : "itemize"}}`)) {
        i += 1;
        const item = lines[i].trim().replace(/^\\item\s*/, "");
        if (item) items.push(item);
      }
      i += 1;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (line.startsWith("\\begin{abstract}")) {
      flushParagraph();
      const abstractLines: string[] = [];
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith("\\end{abstract}")) {
        i += 1;
        abstractLines.push(stripComment(lines[i]).trim());
      }
      i += 1;
      blocks.push({ kind: "abstract", text: abstractLines.join(" ").replace(/\s+/g, " ").trim() });
      continue;
    }

    if (line.startsWith("\\begin{IEEEkeywords}")) {
      flushParagraph();
      const keywordLines: string[] = [];
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith("\\end{IEEEkeywords}")) {
        i += 1;
        keywordLines.push(stripComment(lines[i]).trim());
      }
      i += 1;
      blocks.push({ kind: "keywords", text: keywordLines.join(" ").replace(/\s+/g, " ").trim() });
      continue;
    }

    if (line.startsWith("\\begin{table}")) {
      flushParagraph();
      const tableLines: string[] = [];
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith("\\end{table}")) {
        i += 1;
        tableLines.push(lines[i].trim());
      }
      i += 1;
      const tableSource = tableLines.join("\n");
      const rows = parseTabularRows(tableSource);
      const caption = tableSource.match(/\\caption\{([^}]+)\}/)?.[1];
      if (rows.length) blocks.push({ kind: "table", rows, caption });
      continue;
    }

    if (line.startsWith("\\begin{tabular}")) {
      flushParagraph();
      const tabularLines: string[] = [line];
      while (i + 1 < lines.length && !lines[i + 1].startsWith("\\end{tabular}")) {
        i += 1;
        tabularLines.push(lines[i]);
      }
      if (i + 1 < lines.length) tabularLines.push(lines[(i += 1)]);
      const rows = parseTabularRows(tabularLines.join("\n"));
      blocks.push({ kind: "table", rows });
      continue;
    }

    if (line.startsWith("\\begin{figure}")) {
      flushParagraph();
      const figureLines: string[] = [];
      while (i + 1 < lines.length && !lines[i + 1].startsWith("\\end{figure}")) {
        i += 1;
        figureLines.push(lines[i].trim());
      }
      i += 1;
      const figure = figureLines.join("\n");
      const image = figure.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/);
      const caption = figure.match(/\\caption\{([^}]+)\}/);
      blocks.push({ kind: "image", path: image?.[1] ?? "missing-image", caption: caption?.[1] });
      continue;
    }

    const image = line.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/);
    if (image) {
      flushParagraph();
      blocks.push({ kind: "image", path: image[1] });
      continue;
    }

    if (line.startsWith("\\end{abstract}") || line.startsWith("\\end{IEEEkeywords}") || line.startsWith("\\bibliography") || line.startsWith("\\FloatBarrier")) {
      flushParagraph();
      continue;
    }

    if (line.startsWith("\\begin{thebibliography}")) {
      flushParagraph();
      blocks.push({ kind: "heading", level: 1, text: "References" });
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith("\\end{thebibliography}")) {
        i += 1;
        const reference = stripComment(lines[i]).trim();
        if (reference.startsWith("\\bibitem")) {
          paragraph.push(reference.replace(/\\bibitem\{[^}]+\}/, ""));
          flushParagraph();
        } else if (reference) {
          paragraph.push(reference);
        }
      }
      flushParagraph();
      i += 1;
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return { title, author, authors, date, layout, blocks: layout === "ieee" ? trimIeeePreambleBlocks(blocks) : blocks };
}

function renderPreviewHtml(document: PreviewDocument, imageUrls: Record<string, string>) {
  if (document.layout === "ieee") return renderIeeePreviewHtml(document, imageUrls);
  const blocks = document.blocks.map((block) => renderBlock(block, imageUrls, document.layout)).join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.45/dist/katex.min.css" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f5f5; color: #171717; font-family: "Times New Roman", Times, serif; }
    .page { width: 720px; min-height: 1018px; margin: 0 auto; padding: 62px 76px; background: white; box-shadow: 0 1px 8px rgba(0,0,0,.16); }
    .title { margin: 0 0 8px; text-align: center; font-size: 28px; font-weight: 600; line-height: 1.15; }
    .byline, .date { text-align: center; font-size: 14px; line-height: 1.35; }
    .date { margin-bottom: 32px; }
    h2 { margin: 26px 0 10px; text-align: center; font-size: 14px; letter-spacing: .06em; text-transform: uppercase; }
    h3 { margin: 22px 0 8px; font-size: 14px; font-variant: small-caps; }
    h4 { margin: 18px 0 8px; font-size: 13px; font-style: italic; }
    p { margin: 0 0 11px; font-size: 14px; line-height: 1.45; text-align: justify; }
    .display-math { margin: 18px 0; overflow-x: auto; text-align: center; font-size: 15px; }
    code { border: 1px solid #ddd; border-radius: 4px; padding: 1px 4px; font-family: "Courier New", monospace; font-size: 12px; }
    ul, ol { margin: 8px 0 14px 24px; padding: 0; font-size: 14px; line-height: 1.45; }
    table { width: 100%; margin: 16px 0; border-collapse: collapse; font-size: 13px; }
    td { border: 1px solid #d4d4d4; padding: 6px 8px; }
    figure { margin: 18px 0; text-align: center; }
    .image-box { display: flex; min-height: 170px; align-items: center; justify-content: center; border: 1px dashed #999; background: #fafafa; font-size: 13px; color: #555; }
    .figure-image { max-width: 100%; max-height: 300px; object-fit: contain; }
    figcaption { margin-top: 6px; font-size: 12px; color: #444; }
    .cite { white-space: nowrap; }
  </style>
</head>
<body>
  <main class="page">
    <h1 class="title">${renderInline(document.title)}</h1>
    <div class="byline">${renderInline(document.author)}</div>
    <div class="date">${renderInline(document.date)}</div>
    ${blocks}
  </main>
  ${previewClickScript()}
</body>
</html>`;
}

function renderIeeePreviewHtml(document: PreviewDocument, imageUrls: Record<string, string>) {
  const pages = paginateBlocks(document.blocks, 1850, 2450);
  let sectionIndex = 0;
  let subsectionIndex = 0;
  const renderedPages = pages.map((pageBlocks, index) => {
    const title = index === 0 ? renderIeeeTitle(document) : "";
    const blocks = pageBlocks.map((block) => {
      let sectionPrefix = "";
      if (block.kind === "heading" && block.level === 1) {
        sectionIndex += 1;
        subsectionIndex = 0;
        sectionPrefix = `${toRoman(sectionIndex)}. `;
      }
      if (block.kind === "heading" && block.level === 2) {
        subsectionIndex += 1;
        sectionPrefix = `${String.fromCharCode(64 + subsectionIndex)}. `;
      }
      return renderBlock(block, imageUrls, document.layout, sectionPrefix);
    }).join("\n");
    return `<section class="page ieee-page">${title}<div class="ieee-columns">${blocks}</div></section>`;
  }).join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f3f4f6; color: #000; font-family: "Times New Roman", Times, serif; }
    .page { width: 760px; min-height: 1068px; margin: 0 auto 22px; padding: 34px 42px; background: #fff; box-shadow: 0 1px 8px rgba(0,0,0,.16); overflow: hidden; }
    .ieee-title { margin: 0 0 26px; text-align: center; }
    .ieee-title h1 { margin: 0 0 26px; font-size: 31px; font-weight: 400; line-height: 1.12; letter-spacing: 0; }
    .ieee-authors { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px 28px; margin-bottom: 26px; }
    .ieee-author { text-align: center; font-size: 14px; line-height: 1.18; }
    .ieee-author strong { display: block; margin-bottom: 2px; font-size: 15px; font-weight: 400; }
    .ieee-author em { font-style: italic; }
    .ieee-columns { height: 980px; column-count: 2; column-gap: 26px; column-fill: auto; }
    .ieee-page:first-child .ieee-columns { height: 730px; }
    .ieee-columns > * { break-inside: avoid; page-break-inside: avoid; }
    h2 { margin: 16px 0 9px; text-align: center; font-size: 13px; font-weight: 400; letter-spacing: .04em; text-transform: uppercase; }
    h3 { margin: 13px 0 7px; font-size: 14px; font-weight: 400; font-style: italic; }
    h4 { margin: 10px 0 6px; font-size: 13px; font-weight: 400; font-style: italic; }
    p { margin: 0 0 8px; font-size: 14px; line-height: 1.16; text-align: justify; hyphens: auto; }
    .abstract, .keywords { margin-bottom: 7px; font-size: 13px; line-height: 1.12; text-align: justify; font-weight: 700; }
    .abstract .label, .keywords .label { font-style: italic; }
    ul, ol { margin: 6px 0 10px 18px; padding: 0; font-size: 14px; line-height: 1.18; }
    li { margin-bottom: 4px; break-inside: avoid; }
    .display-math { margin: 10px 0; overflow-x: auto; text-align: center; font-size: 13px; }
    table { width: 100%; margin: 9px 0; border-collapse: collapse; font-size: 10px; }
    td { border: 1px solid #333; padding: 3px 4px; vertical-align: top; }
    figure { margin: 10px 0; text-align: center; }
    .image-box { display: flex; min-height: 110px; align-items: center; justify-content: center; border: 1px solid #bbb; background: #fafafa; font-size: 11px; color: #555; }
    .figure-image { max-width: 100%; max-height: 190px; object-fit: contain; }
    figcaption { margin-top: 5px; font-size: 11px; line-height: 1.15; color: #111; }
    code { border: 1px solid #ddd; border-radius: 3px; padding: 0 3px; font-family: "Courier New", monospace; font-size: 11px; }
    .cite { white-space: nowrap; }
  </style>
</head>
<body>
  ${renderedPages}
  ${previewClickScript()}
</body>
</html>`;
}

function previewClickScript() {
  return `<script>
    function mossPreviewWordFromPoint(event) {
      var range = document.caretRangeFromPoint ? document.caretRangeFromPoint(event.clientX, event.clientY) : null;
      if (!range && document.caretPositionFromPoint) {
        var position = document.caretPositionFromPoint(event.clientX, event.clientY);
        if (position) {
          range = document.createRange();
          range.setStart(position.offsetNode, position.offset);
        }
      }
      var node = range && range.startContainer;
      if (!node || node.nodeType !== Node.TEXT_NODE) return "";
      var text = node.textContent || "";
      var offset = range.startOffset || 0;
      var left = offset;
      var right = offset;
      while (left > 0 && /[A-Za-z0-9'\\u2019\\u2013\\u2014-]/.test(text.charAt(left - 1))) left -= 1;
      while (right < text.length && /[A-Za-z0-9'\\u2019\\u2013\\u2014-]/.test(text.charAt(right))) right += 1;
      return text.slice(left, right).trim();
    }
    document.addEventListener("click", function(event) {
      var word = mossPreviewWordFromPoint(event);
      if (!word || word.length < 2) return;
      parent.postMessage({ type: "moss-preview-word", text: word }, "*");
    });
  </script>`;
}

function renderIeeeTitle(document: PreviewDocument) {
  const authors = document.authors.length
    ? document.authors.map((author) => `<div class="ieee-author"><strong>${renderInline(author.name)}</strong>${author.lines.map((line) => `<div>${renderInline(line)}</div>`).join("")}</div>`).join("")
    : `<div class="ieee-author"><strong>${renderInline(document.author)}</strong></div>`;
  return `<header class="ieee-title"><h1>${renderInline(document.title)}</h1><div class="ieee-authors">${authors}</div></header>`;
}

function renderBlock(block: PreviewBlock, imageUrls: Record<string, string>, layout: PreviewDocument["layout"], sectionPrefix = "") {
  if (block.kind === "heading") {
    const tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
    return `<${tag}>${sectionPrefix}${renderInline(block.text)}</${tag}>`;
  }
  if (block.kind === "abstract") return `<p class="abstract"><span class="label">Abstract</span>&mdash;${renderInline(block.text)}</p>`;
  if (block.kind === "keywords") return `<p class="keywords"><span class="label">Index Terms</span>&mdash;${renderInline(block.text)}</p>`;
  if (block.kind === "paragraph") return `<p>${renderInline(block.text)}</p>`;
  if (block.kind === "math") return `<div class="display-math">${renderMath(block.text, true)}</div>`;
  if (block.kind === "image") {
    const imageUrl = resolveImageUrl(block.path, imageUrls);
    const image = imageUrl
      ? `<img class="figure-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(block.caption ?? block.path)}" />`
      : `Image asset not found: ${escapeHtml(block.path)}`;
    return `<figure><div class="image-box">${image}</div>${block.caption ? `<figcaption>${renderInline(block.caption)}</figcaption>` : ""}</figure>`;
  }
  if (block.kind === "list") {
    const tag = block.ordered ? "ol" : "ul";
    return `<${tag}>${block.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`;
  }
  return `${block.caption ? `<figure><figcaption>${renderInline(block.caption)}</figcaption>` : ""}<table>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("")}</table>${block.caption ? "</figure>" : ""}`;
}

function resolveImageUrl(path: string, imageUrls: Record<string, string>) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (imageUrls[normalized]) return imageUrls[normalized];
  const withoutExtension = normalized.replace(/\.[^/.]+$/, "");
  return Object.entries(imageUrls).find(([candidate]) => candidate.replace(/\.[^/.]+$/, "") === withoutExtension)?.[1] ?? "";
}

function renderInline(text: string) {
  return text
    .split(/(\$[^$]+\$)/g)
    .map((part) => {
      if (part.startsWith("$") && part.endsWith("$")) return renderMath(part.slice(1, -1), false);
      return renderText(part);
    })
    .join("");
}

function renderText(text: string) {
  let value = escapeHtml(text)
    .replace(/\\textbf\{([^{}]+)\}/g, "<strong>$1</strong>")
    .replace(/\\emph\{([^{}]+)\}/g, "<em>$1</em>")
    .replace(/\\textit\{([^{}]+)\}/g, "<em>$1</em>")
    .replace(/\\textsuperscript\{([^{}]+)\}/g, "<sup>$1</sup>")
    .replace(/\\verb(.)(.*?)\1/g, "<code>$2</code>")
    .replace(/\\cite\{([^{}]+)\}/g, '<span class="cite">[$1]</span>')
    .replace(/\\ref\{([^{}]+)\}/g, "$1")
    .replace(/\\LaTeX/g, "LaTeX")
    .replace(/~/g, " ");
  value = value.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, "").replace(/[{}]/g, "");
  return value;
}

function renderMath(value: string, displayMode: boolean) {
  try {
    return katex.renderToString(normalizeMath(value), { displayMode, throwOnError: false, strict: false });
  } catch {
    return `<code>${escapeHtml(value)}</code>`;
  }
}

function commandValue(source: string, command: string) {
  const start = source.search(new RegExp(`\\\\${command}\\s*\\{`));
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const escaped = index > 0 && source[index - 1] === "\\";
    if (character === "{" && !escaped) depth += 1;
    if (character === "}" && !escaped) depth -= 1;
    if (depth === 0) return source.slice(open + 1, index).trim();
  }
  return "";
}

function removeCommandBlocks(source: string, commands: string[]) {
  let output = source;
  for (const command of commands) {
    let searchFrom = 0;
    while (searchFrom < output.length) {
      const match = output.slice(searchFrom).match(new RegExp(`\\\\${command}\\s*\\{`));
      if (!match?.index && match?.index !== 0) break;
      const start = searchFrom + match.index;
      const open = output.indexOf("{", start);
      let depth = 0;
      let end = -1;
      for (let index = open; index < output.length; index += 1) {
        const character = output[index];
        const escaped = index > 0 && output[index - 1] === "\\";
        if (character === "{" && !escaped) depth += 1;
        if (character === "}" && !escaped) depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
      if (end < 0) break;
      output = `${output.slice(0, start)}\n${output.slice(end)}`;
      searchFrom = start + 1;
    }
  }
  return output;
}

function documentBody(source: string) {
  return source.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/)?.[1] ?? source;
}

function headingLevel(command: string) {
  if (command === "section") return 1;
  if (command === "subsection") return 2;
  return 3;
}

function stripComment(line: string) {
  return line.replace(/(^|[^\\])%.*/, "$1").trimEnd();
}

function todayLabel() {
  return new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function normalizeMath(value: string) {
  return value
    .replace(/\\begin\{align\*?\}/g, "\\begin{aligned}")
    .replace(/\\end\{align\*?\}/g, "\\end{aligned}")
    .replace(/\\begin\{equation\*?\}/g, "")
    .replace(/\\end\{equation\*?\}/g, "")
    .replace(/\\\]/g, "")
    .replace(/\\\[/g, "")
    .trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function trimIeeePreambleBlocks(blocks: PreviewBlock[]) {
  const firstContentIndex = blocks.findIndex((block) => block.kind === "abstract" || block.kind === "keywords" || block.kind === "heading");
  return firstContentIndex > 0 ? blocks.slice(firstContentIndex) : blocks;
}

function parseTabularRows(source: string) {
  const body = source.match(/\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/)?.[1] ?? source;
  return body
    .split(/\\\\/)
    .map((row) => row
      .replace(/\\hline/g, "")
      .replace(/\\cline\{[^}]+\}/g, "")
      .replace(/\\toprule|\\midrule|\\bottomrule/g, "")
      .trim())
    .filter(Boolean)
    .map((row) => row.split("&").map((cell) => cell.trim()).filter(Boolean))
    .filter((row) => row.length);
}

function parseAuthors(authorSource: string): PreviewAuthor[] {
  if (!authorSource.trim()) return [];
  return authorSource
    .split(/\\and/g)
    .map((chunk) => {
      const name = cleanLatex(commandValue(chunk, "IEEEauthorblockN"));
      const affiliation = commandValue(chunk, "IEEEauthorblockA");
      const fallback = chunk.replace(/\\IEEEauthorblockN\{[\s\S]*?\}/, "");
      const lines = cleanAuthorLines(affiliation || fallback);
      return name ? { name, lines } : null;
    })
    .filter((author): author is PreviewAuthor => Boolean(author));
}

function cleanAuthorLines(value: string) {
  return value
    .split(/\\\\|\n/)
    .map(cleanLatex)
    .map((line) => line.trim())
    .filter(Boolean);
}

function cleanLatex(value: string) {
  return value
    .replace(/\\footnotesize/g, "")
    .replace(/\\IEEEauthorblock[A-Z]\s*\{([\s\S]*?)\}/g, "$1")
    .replace(/\\textit\{([^{}]+)\}/g, "$1")
    .replace(/\\textbf\{([^{}]+)\}/g, "$1")
    .replace(/\\textsuperscript\{([^{}]+)\}/g, "$1")
    .replace(/\\thanks\{[\s\S]*?\}/g, "")
    .replace(/\\\\/g, " ")
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, "")
    .replace(/\\/g, " ")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function paginateBlocks(blocks: PreviewBlock[], firstPageBudget: number, pageBudget: number) {
  const pages: PreviewBlock[][] = [];
  let page: PreviewBlock[] = [];
  let budget = firstPageBudget;
  let used = 0;

  for (const block of blocks) {
    const cost = estimateBlockCost(block);
    if (page.length && used + cost > budget) {
      pages.push(page);
      page = [];
      budget = pageBudget;
      used = 0;
    }
    page.push(block);
    used += cost;
  }

  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}

function estimateBlockCost(block: PreviewBlock) {
  if (block.kind === "heading") return block.level === 1 ? 120 : 80;
  if (block.kind === "abstract") return Math.ceil(block.text.length / 1.6);
  if (block.kind === "keywords") return Math.ceil(block.text.length / 2.1);
  if (block.kind === "paragraph") return Math.ceil(block.text.length / 2.2) + 30;
  if (block.kind === "list") return block.items.reduce((total, item) => total + Math.ceil(item.length / 2.4) + 38, 30);
  if (block.kind === "math") return 120;
  if (block.kind === "image") return 280;
  if (block.kind === "table") return Math.max(180, block.rows.length * 34);
  return 100;
}

function toRoman(value: number) {
  const numerals: Array<[number, string]> = [
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let remaining = value;
  let result = "";
  for (const [number, symbol] of numerals) {
    while (remaining >= number) {
      result += symbol;
      remaining -= number;
    }
  }
  return result;
}
