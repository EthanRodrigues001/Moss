export const sampleLatex = String.raw`\documentclass[conference]{IEEEtran}
\usepackage{cite}
\usepackage{graphicx}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage{array}
\usepackage{hyperref}

\title{Moss Sample IEEE Paper}

\author{
\IEEEauthorblockN{Ethan Rodrigues}
\IEEEauthorblockA{
Moss Research Lab\\
Navi Mumbai, India\\
ethan@example.com}
\and
\IEEEauthorblockN{Moss Assistant}
\IEEEauthorblockA{
Cloud LaTeX Systems\\
Vercel and Supabase\\
assistant@example.com}
}

\begin{document}
\maketitle

\begin{abstract}
Moss is a web based LaTeX editor with cloud project storage, direct downloads, section-aware editing, citations, equations, diagrams, and a document-style preview. This starter project is intentionally broad: it includes IEEE formatting, text styles, equations, lists, several table styles, figures, citations, and a multi-file section.
\end{abstract}

\begin{IEEEkeywords}
LaTeX editor, IEEEtran, browser compilation, Supabase Storage, citations, equations, document preview
\end{IEEEkeywords}

\section{Introduction}
Moss stores LaTeX projects in Supabase, keeps uploaded diagrams in Supabase Storage, and downloads compiled artifacts directly instead of saving generated PDFs. This sample is designed as a quick test document for the editor surface.

Inline math works as usual, for example $E = mc^2$ and $\alpha + \beta = \gamma$. Citations use BibTeX, such as \cite{moss2026,lamport1994}. Text commands like \textbf{bold text}, \emph{emphasis}, \texttt{monospace text}, and \underline{underlined text} should survive normal editing.

\subsection{Section Levels}
IEEE papers commonly use sections, subsections, and subsubsections. Moss should preserve these levels in code mode, visual mode, and the section outline.

\subsubsection{Agent-ready content}
Future agents can work on one section at a time when Moss stores section hashes and rejects stale edits.

\section{Equations}
The equation tools should support inline math, display math, numbered equations, aligned equations, matrices, and cases.

\begin{equation}
  a^2 + b^2 = c^2
  \label{eq:pythagoras}
\end{equation}

\begin{align}
  \nabla \cdot \vec{E} &= \frac{\rho}{\varepsilon_0},\\
  \nabla \times \vec{B} &= \mu_0\vec{J} + \mu_0\varepsilon_0\frac{\partial \vec{E}}{\partial t}.
\end{align}

\[
A =
\begin{bmatrix}
1 & 2 & 3\\
4 & 5 & 6\\
7 & 8 & 9
\end{bmatrix}
\]

\begin{equation}
f(x)=
\begin{cases}
x^2, & x \geq 0,\\
-x, & x < 0.
\end{cases}
\end{equation}

\section{Lists And Formatting}
Use lists to verify indentation, numbering, and conversion between code and visual editing.

\begin{itemize}
\item File tree with text files and uploaded binary assets.
\item Manual compile plus debounced auto compile from the top dropdown.
\item Section parsing for future per-section agent patches.
\end{itemize}

\begin{enumerate}
\item Create or upload a project file.
\item Edit LaTeX in Monaco or the visual editor.
\item Preview, download PDF, or export ZIP.
\end{enumerate}

\section{Tables}
This section includes multiple table styles so Moss can test raw LaTeX preservation, browser preview rendering, and real Tectonic output.

\begin{table}[!t]
\centering
\renewcommand{\arraystretch}{1.2}
\caption{Bordered storage table}
\label{tab:bordered}
\begin{tabular}{|l|l|l|}
\hline
Feature & Storage & v1 behavior \\
\hline
Text files & Postgres & Editable source \\
\hline
Images & Storage & File tree assets \\
\hline
PDF output & Browser Blob & Direct download \\
\hline
\end{tabular}
\end{table}

\begin{table}[!t]
\centering
\caption{Booktabs quality table}
\label{tab:booktabs}
\begin{tabular}{@{}lll@{}}
\toprule
Mode & Purpose & Status \\
\midrule
Code & Precise LaTeX editing & Ready \\
Visual & Structured editing & Improving \\
Preview & Tectonic PDF output & Active \\
\bottomrule
\end{tabular}
\end{table}

\begin{table*}[!t]
\centering
\caption{Wide table across both IEEE columns}
\label{tab:wide}
\begin{tabular}{@{}p{0.18\linewidth}p{0.28\linewidth}p{0.44\linewidth}@{}}
\toprule
Area & Current behavior & Future direction \\
\midrule
Compilation & Tectonic backend returns PDFs directly. & Add cached bundles and richer diagnostics. \\
Citations & BibTeX files and citation metadata are stored with the project. & Add CSL import, DOI lookup, and citation insertion flows. \\
Agents & Sections are parsed for stable hashes. & Allow safe per-section patches with before-hash validation. \\
\bottomrule
\end{tabular}
\end{table*}

\section{Figures}
Upload a diagram to \texttt{figures/diagram.png}, then reference it like this:

\begin{figure}[!t]
\centering
\includegraphics[width=0.85\linewidth]{figures/diagram.png}
\caption{Uploaded diagrams are stored in Supabase Storage and kept in the same project file tree.}
\label{fig:diagram}
\end{figure}

Fig.~\ref{fig:diagram} should compile when the asset exists in the project tree.

\section{Multi-file Input}
The next line pulls content from another project file. This tests uploaded folders, file tree paths, and section parsing across multiple files.

\input{sections/notes.tex}

\section{Conclusion}
This starter document should exercise the main Moss v1 workflow: editing, visual structure, syntax linting, cloud persistence, assets, BibTeX citations, compilation, preview, and direct downloads.

\bibliographystyle{IEEEtran}
\bibliography{references}

\end{document}
`;

export const sampleNotesLatex = String.raw`\subsection{Notes From Another File}
This subsection comes from \texttt{sections/notes.tex}. It is useful for testing project file trees, folder uploads, source jumps, and future per-section agent edits.

\begin{equation}
  \eta = \frac{\text{useful output}}{\text{total input}}
\end{equation}

\begin{itemize}
\item Multi-file projects should preserve relative paths.
\item The root file can include sections with \texttt{\textbackslash input\{sections/notes.tex\}}.
\item Agent patches can eventually target this subsection independently.
\end{itemize}
`;

export const sampleBibtex = String.raw`@article{moss2026,
  title={Moss: A Browser Based LaTeX Editing Prototype},
  author={Rodrigues, Ethan},
  journal={Moss Draft Notes},
  year={2026}
}

@book{lamport1994,
  title={LaTeX: A Document Preparation System},
  author={Lamport, Leslie},
  publisher={Addison-Wesley},
  year={1994}
}
`;

export const sampleDiagramPngBase64 = "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";
