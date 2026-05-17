"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";

type PdfPreviewProps = {
  pdfBlob: Blob;
  zoom: number;
  onPageCountChange?: (pages: number) => void;
  onTextClick?: (hit: PdfTextHit) => void;
};

export type PdfTextHit = {
  text: string;
  page: number;
  x: number;
  y: number;
};

export function PdfPreview({ pdfBlob, zoom, onPageCountChange, onTextClick }: PdfPreviewProps) {
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let loadedDocument: PDFDocumentProxy | null = null;

    async function loadPdf() {
      try {
        setError("");
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const data = await pdfBlob.arrayBuffer();
        const loadingTask = pdfjs.getDocument({ data });
        loadedDocument = await loadingTask.promise;
        if (cancelled) {
          await loadedDocument.destroy();
          return;
        }
        setDocumentProxy(loadedDocument);
        onPageCountChange?.(loadedDocument.numPages);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Could not render PDF preview.");
          onPageCountChange?.(0);
        }
      }
    }

    void loadPdf();

    return () => {
      cancelled = true;
      setDocumentProxy(null);
      if (loadedDocument) void loadedDocument.destroy();
    };
  }, [pdfBlob, onPageCountChange]);

  if (error) {
    return (
      <div className="mx-auto flex min-h-[720px] w-[520px] flex-col items-center justify-center rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
        {error}
      </div>
    );
  }

  if (!documentProxy) {
    return (
      <div className="mx-auto flex min-h-[720px] w-[520px] items-center justify-center rounded-lg border bg-background p-8 text-sm text-muted-foreground">
        Loading PDF preview...
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-5">
      {Array.from({ length: documentProxy.numPages }, (_value, index) => (
        <PdfPage
          documentProxy={documentProxy}
          key={`${documentProxy.fingerprints?.[0] ?? "pdf"}-${index + 1}-${zoom}`}
          pageNumber={index + 1}
          zoom={zoom}
          onTextClick={onTextClick}
        />
      ))}
    </div>
  );
}

function PdfPage({
  documentProxy,
  pageNumber,
  zoom,
  onTextClick,
}: {
  documentProxy: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  onTextClick?: (hit: PdfTextHit) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [textItems, setTextItems] = useState<TextItem[]>([]);
  const viewport = useMemo(() => page?.getViewport({ scale: zoom / 100 }) ?? null, [page, zoom]);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;

    async function renderPage() {
      try {
        const pdfPage = await documentProxy.getPage(pageNumber);
        if (cancelled) return;
        setPage(pdfPage);

        const pageViewport = pdfPage.getViewport({ scale: zoom / 100 });
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;

        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(pageViewport.width * outputScale);
        canvas.height = Math.floor(pageViewport.height * outputScale);
        canvas.style.width = `${pageViewport.width}px`;
        canvas.style.height = `${pageViewport.height}px`;

        context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        renderTask = pdfPage.render({ canvas, canvasContext: context, viewport: pageViewport });
        await renderTask.promise;

        const textContent = await pdfPage.getTextContent();
        if (!cancelled) {
          setTextItems(textContent.items.filter(isTextItem));
        }
      } catch (error) {
        if (!isPdfRenderCancellation(error)) {
          console.error(error);
        }
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [documentProxy, pageNumber, zoom]);

  return (
    <div
      className="relative bg-background shadow-sm"
      style={{ width: viewport?.width ?? 612, height: viewport?.height ?? 792 }}
    >
      <canvas ref={canvasRef} />
      {viewport ? (
        <div className="absolute inset-0 overflow-hidden">
          {textItems.map((item, index) => (
            <PdfTextChunk
              item={item}
              key={`${index}-${item.str}`}
              pageNumber={pageNumber}
              viewportTransform={viewport.transform}
              zoom={zoom}
              onTextClick={onTextClick}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function isPdfRenderCancellation(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && "name" in error
    && String((error as { name?: string }).name) === "RenderingCancelledException",
  );
}

function PdfTextChunk({
  item,
  pageNumber,
  viewportTransform,
  zoom,
  onTextClick,
}: {
  item: TextItem;
  pageNumber: number;
  viewportTransform: number[];
  zoom: number;
  onTextClick?: (hit: PdfTextHit) => void;
}) {
  const transform = multiplyTransform(viewportTransform, item.transform);
  const fontHeight = Math.hypot(transform[2], transform[3]);
  const x = transform[4];
  const y = transform[5] - fontHeight;

  return (
    <span
      className="absolute cursor-text text-transparent"
      onClick={(event) => {
        event.stopPropagation();
        const scale = zoom / 100;
        onTextClick?.({
          text: item.str,
          page: pageNumber,
          x: (x + item.width / 2) / scale,
          y: (y + fontHeight / 2) / scale,
        });
      }}
      style={{
        left: x,
        top: y,
        fontSize: fontHeight,
        lineHeight: 1,
        transform: `scaleX(${item.width > 0 && item.str.length ? item.width / Math.max(item.str.length * fontHeight * 0.45, 1) : 1})`,
        transformOrigin: "0 0",
        whiteSpace: "pre",
      }}
    >
      {item.str}
    </span>
  );
}

function isTextItem(item: unknown): item is TextItem {
  return Boolean(item && typeof item === "object" && "str" in item && "transform" in item);
}

function multiplyTransform(first: number[], second: number[]) {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}
