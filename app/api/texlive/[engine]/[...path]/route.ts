import { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SWIFTLATEX_TEXLIVE_ENDPOINT = "https://texlive2.swiftlatex.com";
const ALLOWED_ENGINES = new Set(["pdftex", "xetex", "dvipdfm"]);

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ engine: string; path: string[] }> },
) {
  const { engine, path } = await context.params;
  if (!ALLOWED_ENGINES.has(engine) || !path.length) {
    return new Response("Not found", { status: 404 });
  }

  if (engine === "pdftex") {
    const local = await localTexFileResponse(path.at(-1) ?? "");
    if (local) return local;
  }

  const safePath = path.map(encodeURIComponent).join("/");
  const upstreamUrl = `${SWIFTLATEX_TEXLIVE_ENDPOINT}/${engine}/${safePath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { redirect: "manual", signal: controller.signal });
  } catch {
    return new Response(null, { status: 301 });
  } finally {
    clearTimeout(timeout);
  }

  if (upstream.status !== 200) {
    return new Response(null, { status: upstream.status });
  }

  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  });

  const fileId = upstream.headers.get("fileid");
  const pkId = upstream.headers.get("pkid");
  if (fileId) headers.set("fileid", fileId);
  if (pkId) headers.set("pkid", pkId);

  return new Response(upstream.body, {
    status: 200,
    headers,
  });
}

async function localTexFileResponse(filename: string) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) return null;
  const filePath = filename === "swiftlatexpdftex.fmt"
    ? join(process.cwd(), "public", "swiftlatex", "swiftlatexpdftex.fmt")
    : join(process.cwd(), "public", "texlive", "pdftex", filename);

  let file: Buffer;
  try {
    file = await readFile(filePath);
  } catch {
    return null;
  }

  return new Response(new Uint8Array(file), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      fileid: filename,
    },
  });
}
