import type { ProjectFile } from "@/lib/types";

export type ParsedSection = {
  sectionKey: string;
  filePath: string;
  heading: string;
  level: number;
  orderIndex: number;
  sourceStart: number;
  sourceEnd: number;
  sourceText: string;
  contentHash: string;
  fileId: string;
};

const SECTION_RE = /\\(section|subsection|subsubsection)\*?\{([^}]*)\}/g;

export async function hashContent(content: string) {
  const bytes = new TextEncoder().encode(content);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function parseFileSections(file: ProjectFile) {
  const content = file.content_text ?? "";
  const matches = Array.from(content.matchAll(SECTION_RE));
  const sections: ParsedSection[] = [];
  const occurrences = new Map<string, number>();

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const nextMatch = matches[index + 1];
    const sourceStart = match.index ?? 0;
    const sourceEnd = nextMatch?.index ?? content.length;
    const body = content.slice(sourceStart, sourceEnd);
    const level = match[1] === "section" ? 1 : match[1] === "subsection" ? 2 : 3;
    const heading = match[2] || "Untitled";
    const slug = slugifyHeading(heading);
    const occurrenceKey = `${level}:${slug}`;
    const occurrenceIndex = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrenceIndex + 1);

    sections.push({
      sectionKey: `${file.path}::${level}::${slug}::${occurrenceIndex}`,
      filePath: file.path,
      heading,
      level,
      orderIndex: index,
      sourceStart,
      sourceEnd,
      sourceText: body,
      contentHash: await hashContent(body),
      fileId: file.id,
    });
  }

  return sections;
}

function slugifyHeading(heading: string) {
  const slug = heading
    .toLowerCase()
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?\{([^}]*)\}/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "untitled";
}
