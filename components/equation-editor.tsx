"use client";

import katex from "katex";
import { useEffect, useRef } from "react";

export function EquationEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const fieldRef = useRef<HTMLElement | null>(null);
  const preview = katex.renderToString(value || " ", { displayMode: true, throwOnError: false, strict: false });

  useEffect(() => {
    void import("mathlive");
  }, []);

  useEffect(() => {
    const field = fieldRef.current as (HTMLElement & { value?: string }) | null;
    if (field && field.value !== value) field.value = value;
  }, [value]);

  return (
    <div className="flex flex-col gap-3">
      <math-field
        ref={(element) => {
          fieldRef.current = element;
        }}
        className="min-h-20 rounded-md border bg-background p-2 text-lg"
        onInput={(event) => onChange((event.currentTarget as HTMLElement & { value?: string }).value ?? "")}
      />
      <div className="rounded-md border bg-muted/40 p-4 text-center" dangerouslySetInnerHTML={{ __html: preview }} />
    </div>
  );
}
