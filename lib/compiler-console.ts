export function logCompilerUsed({
  compiler,
  engine,
  ok,
  source,
}: {
  compiler: string | undefined;
  engine: string | undefined;
  ok: boolean;
  source: "backend" | "browser";
}) {
  console.log(
    `%cMoss compiler used: ${source} -> ${compiler ?? "unknown"} / ${engine ?? "unknown"} (${ok ? "ok" : "failed"})`,
    [
      "color: #f97316",
      "background: #fff7ed",
      "border: 1px solid #fdba74",
      "border-radius: 4px",
      "font-weight: 800",
      "padding: 2px 6px",
    ].join(";"),
  );
}
