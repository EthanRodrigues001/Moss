"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import katex from "katex";
import {
  Bold,
  ChevronDown,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Pilcrow,
  Redo2,
  Sigma,
  Undo2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { latexDocumentStyle, latexToTiptapDocument, replaceDocumentBody, tiptapDocumentToLatex, type LatexDocumentStyle } from "@/lib/latex-visual";

const InlineMath = Node.create({
  name: "inlineMath",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { latex: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "span[data-inline-math]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-inline-math": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView);
  },
});

const BlockMath = Node.create({
  name: "blockMath",
  group: "block",
  atom: true,
  addAttributes() {
    return { latex: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-block-math]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-block-math": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView);
  },
});

const RawLatex = Node.create({
  name: "rawLatex",
  group: "block",
  atom: true,
  addAttributes() {
    return {
      latex: { default: "" },
      label: { default: "LaTeX block" },
    };
  },
  parseHTML() {
    return [{ tag: "pre[data-raw-latex]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["pre", mergeAttributes(HTMLAttributes, { "data-raw-latex": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(RawLatexNodeView);
  },
});

export function LatexVisualEditor({
  latex,
  pendingSearch,
  onPendingSearchHandled,
  onLatexChange,
}: {
  latex: string;
  pendingSearch?: string;
  onPendingSearchHandled?: () => void;
  onLatexChange: (latex: string) => void;
}) {
  const latestLatexRef = useRef(latex);
  const updatingFromEditorRef = useRef(false);
  const [, refreshToolbar] = useState(0);
  const documentStyle = latexDocumentStyle(latex);

  useEffect(() => {
    latestLatexRef.current = latex;
  }, [latex]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      InlineMath,
      BlockMath,
      RawLatex,
      Placeholder.configure({ placeholder: "Write visually, Moss keeps LaTeX underneath." }),
    ],
    content: latexToTiptapDocument(latex),
    editorProps: {
      attributes: {
        class:
          "min-h-full bg-background px-12 py-10 text-[15px] leading-7 outline-none prose-headings:font-semibold",
      },
    },
    onUpdate({ editor }) {
      updatingFromEditorRef.current = true;
      const body = tiptapDocumentToLatex(editor.getJSON());
      onLatexChange(replaceDocumentBody(latestLatexRef.current, body));
      refreshToolbar((version) => version + 1);
      queueMicrotask(() => {
        updatingFromEditorRef.current = false;
      });
    },
    onSelectionUpdate() {
      refreshToolbar((version) => version + 1);
    },
  });

  useEffect(() => {
    if (!editor || updatingFromEditorRef.current) return;
    editor.commands.setContent(latexToTiptapDocument(latex), { emitUpdate: false });
  }, [editor, latex]);

  useEffect(() => {
    if (!editor || !pendingSearch) return;
    if (selectTextInVisualEditor(editor, pendingSearch)) {
      onPendingSearchHandled?.();
    }
  }, [editor, pendingSearch, onPendingSearchHandled]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <VisualToolbar editor={editor} documentStyle={documentStyle} />
      <EditorContent className="h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden [&_.tiptap]:min-h-full [&_.tiptap]:pb-24 [&_.tiptap_code]:rounded [&_.tiptap_code]:bg-muted [&_.tiptap_code]:px-1 [&_.tiptap_pre]:mb-4 [&_.tiptap_pre]:max-h-56 [&_.tiptap_pre]:overflow-auto [&_.tiptap_pre]:rounded-md [&_.tiptap_pre]:border [&_.tiptap_pre]:bg-muted/40 [&_.tiptap_pre]:p-3 [&_.tiptap_pre]:text-xs [&_.tiptap_p]:mb-3 [&_.tiptap_h1]:mb-4 [&_.tiptap_h1]:text-2xl [&_.tiptap_h2]:mb-3 [&_.tiptap_h2]:text-xl [&_.tiptap_h3]:mb-2 [&_.tiptap_h3]:text-lg [&_.tiptap_ul]:mb-4 [&_.tiptap_ul]:list-disc [&_.tiptap_ul]:pl-6 [&_.tiptap_ol]:mb-4 [&_.tiptap_ol]:list-decimal [&_.tiptap_ol]:pl-6" editor={editor} />
    </div>
  );
}

function selectTextInVisualEditor(editor: Editor, search: string) {
  const target = normalizeVisualSearch(search).toLowerCase();
  if (!target) return false;

  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, position) => {
    if (found || !node.isText || !node.text) return !found;
    const normalizedText = normalizeVisualSearch(node.text).toLowerCase();
    const index = normalizedText.indexOf(target);
    if (index < 0) return true;

    found = {
      from: position + index,
      to: position + index + target.length,
    };
    return false;
  });

  if (!found) return false;
  editor.chain().focus().setTextSelection(found).run();
  requestAnimationFrame(() => {
    editor.view.dom.ownerDocument
      .getSelection()
      ?.anchorNode?.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
  });
  return true;
}

function normalizeVisualSearch(value: string) {
  return value
    .replace(/[^\w' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function VisualToolbar({ editor, documentStyle }: { editor: Editor | null; documentStyle: LatexDocumentStyle }) {
  const disabled = !editor;
  const labels = documentStyle === "ieee"
    ? { menu: "LaTeX structure", paragraph: "Paragraph", h1: "Section", h2: "Subsection", h3: "Subsubsection" }
    : { menu: "Block style", paragraph: "Paragraph", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3" };
  const blockLabel = editor?.isActive("heading", { level: 1 })
    ? labels.h1
    : editor?.isActive("heading", { level: 2 })
      ? labels.h2
      : editor?.isActive("heading", { level: 3 })
        ? labels.h3
        : labels.paragraph;

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b bg-card px-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled}>
            <Pilcrow data-icon="inline-start" />
            {blockLabel}
            <ChevronDown data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          <DropdownMenuLabel>{labels.menu}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <ToolbarMenuItem onSelect={() => editor?.chain().focus().setParagraph().run()}>
            <Pilcrow data-icon="inline-start" />
            {labels.paragraph}
          </ToolbarMenuItem>
          <ToolbarMenuItem onSelect={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
            <Heading1 data-icon="inline-start" />
            {labels.h1}
          </ToolbarMenuItem>
          <ToolbarMenuItem onSelect={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
            <Heading2 data-icon="inline-start" />
            {labels.h2}
          </ToolbarMenuItem>
          <ToolbarMenuItem onSelect={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>
            <Heading3 data-icon="inline-start" />
            {labels.h3}
          </ToolbarMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ToolbarButton active={Boolean(editor?.isActive("bold"))} disabled={disabled} label="Bold" onClick={() => editor?.chain().focus().toggleBold().run()}>
        <Bold data-icon="inline-start" />
      </ToolbarButton>
      <ToolbarButton active={Boolean(editor?.isActive("italic"))} disabled={disabled} label="Italic" onClick={() => editor?.chain().focus().toggleItalic().run()}>
        <Italic data-icon="inline-start" />
      </ToolbarButton>
      <ToolbarButton active={Boolean(editor?.isActive("bulletList"))} disabled={disabled} label="Bullet list" onClick={() => editor?.chain().focus().toggleBulletList().run()}>
        <List data-icon="inline-start" />
      </ToolbarButton>
      <ToolbarButton active={Boolean(editor?.isActive("orderedList"))} disabled={disabled} label="Numbered list" onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
        <ListOrdered data-icon="inline-start" />
      </ToolbarButton>

      <div className="mx-1 h-6 w-px bg-border" />

      <ToolbarButton disabled={disabled} label="Inline equation" onClick={() => insertMath(editor, false)}>
        <Sigma data-icon="inline-start" />
        Inline
      </ToolbarButton>
      <ToolbarButton disabled={disabled} label="Display equation" onClick={() => insertMath(editor, true)}>
        <Sigma data-icon="inline-start" />
        Display
      </ToolbarButton>

      <div className="mx-1 h-6 w-px bg-border" />

      <ToolbarButton disabled={disabled || !editor?.can().undo()} label="Undo" onClick={() => editor?.chain().focus().undo().run()}>
        <Undo2 data-icon="inline-start" />
      </ToolbarButton>
      <ToolbarButton disabled={disabled || !editor?.can().redo()} label="Redo" onClick={() => editor?.chain().focus().redo().run()}>
        <Redo2 data-icon="inline-start" />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  active,
  children,
  disabled,
  label,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button variant={active ? "secondary" : "ghost"} size="sm" disabled={disabled} title={label} aria-label={label} onClick={onClick}>
      {children}
    </Button>
  );
}

function ToolbarMenuItem({
  children,
  onSelect,
}: {
  children: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={(event) => {
        event.preventDefault();
        onSelect();
      }}
    >
      {children}
    </DropdownMenuItem>
  );
}

function insertMath(editor: Editor | null, displayMode: boolean) {
  if (!editor) return;
  const latex = window.prompt("Equation LaTeX", displayMode ? "\\int_0^1 x^2\\,dx = \\frac{1}{3}" : "E = mc^2");
  if (latex === null) return;
  if (displayMode) {
    editor.chain().focus().insertContent({ type: "blockMath", attrs: { latex } }).run();
    return;
  }
  editor.chain().focus().insertContent([{ type: "inlineMath", attrs: { latex } }, { type: "text", text: " " }]).run();
}

function MathNodeView({
  node,
  updateAttributes,
}: {
  node: { attrs: { latex?: string }; type: { name: string } };
  updateAttributes: (attrs: Record<string, string>) => void;
}) {
  const latex = node.attrs.latex ?? "";
  const displayMode = node.type.name === "blockMath";
  const html = katex.renderToString(latex, { displayMode, throwOnError: false, strict: false });

  return (
    <NodeViewWrapper
      as={displayMode ? "div" : "span"}
      className={displayMode ? "my-4 cursor-pointer rounded-md bg-muted/50 p-3 text-center" : "mx-1 cursor-pointer rounded bg-muted px-1 py-0.5"}
      contentEditable={false}
      onClick={() => {
        const next = window.prompt("Edit equation LaTeX", latex);
        if (next !== null) updateAttributes({ latex: next });
      }}
    >
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </NodeViewWrapper>
  );
}

function RawLatexNodeView({
  node,
  updateAttributes,
}: {
  node: { attrs: { latex?: string; label?: string } };
  updateAttributes: (attrs: Record<string, string>) => void;
}) {
  const latex = node.attrs.latex ?? "";
  const label = node.attrs.label ?? "LaTeX block";

  return (
    <NodeViewWrapper className="my-3 rounded-md border bg-muted/40 p-3" contentEditable={false}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            const next = window.prompt("Edit raw LaTeX", latex);
            if (next !== null) updateAttributes({ latex: next });
          }}
        >
          Edit LaTeX
        </Button>
      </div>
      <pre className="max-h-28 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{latex}</pre>
    </NodeViewWrapper>
  );
}
