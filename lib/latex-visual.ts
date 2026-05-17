import type { JSONContent } from "@tiptap/react";

export type LatexDocumentStyle = "article" | "ieee";

export function latexDocumentStyle(source: string): LatexDocumentStyle {
  return /\\documentclass(?:\[[^\]]*\])?\{IEEEtran\}/.test(source) || source.includes("\\IEEEauthorblockN")
    ? "ieee"
    : "article";
}

export function latexToTiptapDocument(source: string): JSONContent {
  const body = documentBody(source).replace(/\r/g, "");
  const lines = body.split("\n");
  const content: JSONContent[] = [];
  const paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (text) content.push({ type: "paragraph", content: inlineContent(text) });
    paragraph.length = 0;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const originalLine = lines[i];
    const line = stripComment(originalLine).trim();
    if (!line) {
      flushParagraph();
      continue;
    }

    if (line === "\\maketitle" || line.startsWith("\\FloatBarrier") || line.startsWith("\\label")) {
      flushParagraph();
      content.push(rawLatexNode(line));
      continue;
    }

    const heading = line.match(/^\\(section|subsection|subsubsection)\*?\{(.+)\}$/);
    if (heading) {
      flushParagraph();
      content.push({
        type: "heading",
        attrs: { level: heading[1] === "section" ? 1 : heading[1] === "subsection" ? 2 : 3 },
        content: [{ type: "text", text: unwrapText(heading[2]) }],
      });
      continue;
    }

    if (line.startsWith("\\[")) {
      flushParagraph();
      const math: string[] = [];
      const first = line.replace(/^\\\[/, "").replace(/\\\]$/, "").trim();
      if (first) math.push(first);
      while (i + 1 < lines.length && !lines[i + 1].includes("\\]")) {
        i += 1;
        math.push(lines[i]);
      }
      if (i + 1 < lines.length) {
        i += 1;
        const last = lines[i].replace(/\\\]/, "").trim();
        if (last) math.push(last);
      }
      content.push({ type: "blockMath", attrs: { latex: normalizeMath(math.join("\n")) } });
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
      content.push({ type: "blockMath", attrs: { latex: normalizeMath(math.join("\n")) } });
      continue;
    }

    if (line.startsWith("\\begin{itemize}") || line.startsWith("\\begin{enumerate}")) {
      flushParagraph();
      const ordered = line.startsWith("\\begin{enumerate}");
      const items: JSONContent[] = [];
      while (i + 1 < lines.length && !lines[i + 1].startsWith(`\\end{${ordered ? "enumerate" : "itemize"}}`)) {
        i += 1;
        const item = lines[i].trim().replace(/^\\item\s*/, "");
        if (item) items.push({ type: "listItem", content: [{ type: "paragraph", content: inlineContent(item) }] });
      }
      i += 1;
      content.push({ type: ordered ? "orderedList" : "bulletList", content: items });
      continue;
    }

    const rawEnvironment = rawEnvironmentForLine(line);
    if (rawEnvironment) {
      flushParagraph();
      const block = collectEnvironment(lines, i, rawEnvironment.name);
      content.push(rawLatexNode(block.source, rawEnvironment.label));
      i = block.endIndex;
      continue;
    }

    if (
      line.startsWith("\\end{abstract}")
      || line.startsWith("\\end{IEEEkeywords}")
      || line.startsWith("\\bibliographystyle")
      || line.startsWith("\\bibliography")
    ) {
      flushParagraph();
      content.push(rawLatexNode(line));
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

export function tiptapDocumentToLatex(doc: JSONContent) {
  return (doc.content ?? []).map(nodeToLatex).filter(Boolean).join("\n\n").trim();
}

export function replaceDocumentBody(source: string, body: string) {
  if (!source.includes("\\begin{document}") || !source.includes("\\end{document}")) return body;
  return source.replace(/(\\begin\{document\})([\s\S]*?)(\\end\{document\})/, `$1\n${body}\n\n$3`);
}

function nodeToLatex(node: JSONContent): string {
  if (node.type === "heading") {
    const level = Number(node.attrs?.level ?? 1);
    const command = level === 1 ? "section" : level === 2 ? "subsection" : "subsubsection";
    return `\\${command}{${inlineNodesToLatex(node.content)}}`;
  }
  if (node.type === "paragraph") return inlineNodesToLatex(node.content);
  if (node.type === "blockMath") return `\\[\n${node.attrs?.latex ?? ""}\n\\]`;
  if (node.type === "rawLatex") return String(node.attrs?.latex ?? "");
  if (node.type === "codeBlock") return inlineNodesToLatex(node.content);
  if (node.type === "bulletList" || node.type === "orderedList") {
    const environment = node.type === "bulletList" ? "itemize" : "enumerate";
    const items = (node.content ?? []).map((item) => `\\item ${inlineNodesToLatex(item.content?.[0]?.content)}`).join("\n");
    return `\\begin{${environment}}\n${items}\n\\end{${environment}}`;
  }
  return inlineNodesToLatex(node.content);
}

function inlineNodesToLatex(nodes?: JSONContent[]): string {
  return (nodes ?? []).map((node) => {
    if (node.type === "text") return marksToLatex(node.text ?? "", node.marks);
    if (node.type === "inlineMath") return `$${node.attrs?.latex ?? ""}$`;
    if (node.type === "hardBreak") return "\\\\";
    return inlineNodesToLatex(node.content);
  }).join("");
}

function inlineContent(text: string): JSONContent[] {
  const parts = text.split(/(\$[^$]+\$)/g).filter((part) => part.length > 0);
  return parts.map((part) => {
    if (part.startsWith("$") && part.endsWith("$")) {
      return { type: "inlineMath", attrs: { latex: normalizeMath(part.slice(1, -1)) } };
    }
    return { type: "text", text: unwrapText(part) };
  });
}

function marksToLatex(text: string, marks?: { type: string }[]): string {
  if (!marks?.length) return text;
  return marks.reduce((value, mark) => {
    if (mark.type === "bold") return `\\textbf{${value}}`;
    if (mark.type === "italic") return `\\emph{${value}}`;
    return value;
  }, text);
}

function documentBody(source: string) {
  return source.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/)?.[1] ?? source;
}

function collectEnvironment(lines: string[], startIndex: number, environment: string) {
  const collected = [lines[startIndex]];
  let index = startIndex;
  while (index + 1 < lines.length && !lines[index + 1].trim().startsWith(`\\end{${environment}}`)) {
    index += 1;
    collected.push(lines[index]);
  }
  if (index + 1 < lines.length) {
    index += 1;
    collected.push(lines[index]);
  }
  return { source: collected.join("\n"), endIndex: index };
}

function rawEnvironmentForLine(line: string) {
  const match = line.match(/^\\begin\{([^}]+)\}/);
  if (!match) return null;

  const labels: Record<string, string> = {
    abstract: "Abstract",
    IEEEkeywords: "IEEE keywords",
    figure: "Figure",
    "figure*": "Figure",
    table: "Table",
    "table*": "Table",
    tabular: "Table",
    "tabular*": "Table",
    tabularx: "Table",
    longtable: "Table",
    thebibliography: "Bibliography",
  };
  const name = match[1];
  const label = labels[name];
  return label ? { name, label } : null;
}

function rawLatexNode(latex: string, label = "LaTeX block"): JSONContent {
  return {
    type: "rawLatex",
    attrs: { latex, label },
  };
}

function stripComment(line: string) {
  return line.replace(/(^|[^\\])%.*/, "$1").trimEnd();
}

function unwrapText(value: string) {
  return value
    .replace(/\\textbf\{([^{}]+)\}/g, "$1")
    .replace(/\\emph\{([^{}]+)\}/g, "$1")
    .replace(/\\cite\{([^{}]+)\}/g, "[$1]")
    .replace(/\\LaTeX/g, "LaTeX")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ");
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
