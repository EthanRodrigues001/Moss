export function repairCommonLatexSerializationDamage(source: string) {
  let repaired = source
    .replace(/\\begintabular([lcrXpmb|]+)\b/g, (_match, columns: string) => `\\begin{tabular}{${columns}}`)
    .replace(/\\endtabular\b/g, "\\end{tabular}");

  repaired = upgradeMossSampleTable(repaired);
  repaired = upgradeMossSampleFigure(repaired);
  if (repaired.includes("\\begin{table}[H]") || repaired.includes("\\begin{figure}[H]")) {
    repaired = ensurePackage(repaired, "float");
  }

  return repaired;
}

function upgradeMossSampleTable(source: string) {
  const oldSampleTable = String.raw`\begin{tabular}{lll}
\hline
Feature & Storage & v1 behavior \\
\hline
Text files & Postgres & Editable in Monaco \\
Images & Supabase Storage & Visible in file tree \\
PDF output & Browser Blob & Direct download only \\
\hline
\end{tabular}`;

  const newSampleTable = String.raw`\begin{table}[H]
\centering
\renewcommand{\arraystretch}{1.25}
\begin{tabular}{|l|l|l|}
\hline
Feature & Storage & v1 behavior \\
\hline
Text files & Postgres & Editable in Monaco \\
\hline
Images & Supabase Storage & Visible in file tree \\
\hline
PDF output & Browser Blob & Direct download only \\
\hline
\end{tabular}
\caption{Moss v1 storage behavior.}
\end{table}`;

  return source.replace(oldSampleTable, newSampleTable);
}

function upgradeMossSampleFigure(source: string) {
  const oldSampleFigure = String.raw`\begin{figure}
\includegraphics[width=0.6\linewidth]{figures/diagram.png}
\caption{Uploaded diagrams are stored in Supabase Storage and kept in the same project file tree.}
\end{figure}`;

  const newSampleFigure = String.raw`\begin{figure}[H]
\centering
\includegraphics[width=0.6\linewidth]{figures/diagram.png}
\caption{Uploaded diagrams are stored in Supabase Storage and kept in the same project file tree.}
\end{figure}`;

  return source.replace(oldSampleFigure, newSampleFigure);
}

function ensurePackage(source: string, packageName: string) {
  if (new RegExp(String.raw`\\usepackage(?:\[[^\]]*\])?\{${packageName}\}`).test(source)) return source;
  const packageLines = Array.from(source.matchAll(/^\\usepackage(?:\[[^\]]*\])?\{[^}]+\}$/gm));
  const lastPackageLine = packageLines.at(-1);
  if (lastPackageLine?.index !== undefined) {
    const insertAt = lastPackageLine.index + lastPackageLine[0].length;
    return `${source.slice(0, insertAt)}\n\\usepackage{${packageName}}${source.slice(insertAt)}`;
  }
  const documentClass = source.match(/^\\documentclass(?:\[[^\]]*\])?\{[^}]+\}$/m);
  if (documentClass?.index !== undefined) {
    const insertAt = documentClass.index + documentClass[0].length;
    return `${source.slice(0, insertAt)}\n\\usepackage{${packageName}}${source.slice(insertAt)}`;
  }
  return `\\usepackage{${packageName}}\n${source}`;
}
