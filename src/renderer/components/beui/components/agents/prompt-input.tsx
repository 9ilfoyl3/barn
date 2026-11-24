"use client";

import * as React from "react";

import { ArrowUp, LoaderCircle, Plus, Square } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/beui/components/motion/button";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/beui/components/motion/popover-morph";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/beui/components/motion/select";
import { SPRING_LAYOUT, SPRING_SWAP } from "@/components/beui/lib/ease";
import { cn } from "@/components/beui/lib/utils";
import { promptTextSegments } from "@/composer-links";

export interface PromptModel {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PromptAction {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PromptCommand {
  value: string;
  label: string;
  description?: string;
  keywords?: string;
}

export interface PromptInputProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children" | "onChange" | "onInput" | "onSubmit"
> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  models?: PromptModel[];
  model?: string;
  defaultModel?: string;
  onModelChange?: (model: string) => void;
  actions?: PromptAction[];
  onAction?: (action: string) => void;
  commands?: PromptCommand[];
  commandMenuLabel?: string;
  commandHint?: string;
  commandEmpty?: string;
  onSubmit?: (value: string, model?: string) => void | Promise<void>;
  loading?: boolean;
  stopping?: boolean;
  onStop?: () => void;
  minRows?: number;
  maxRows?: number;
  leadingAction?: ReactNode;
  addActionLabel?: string;
  sendLabel?: string;
  stopLabel?: string;
  stoppingLabel?: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  onInput?: React.FormEventHandler<HTMLDivElement>;
}

interface EditorSelection {
  start: number;
  end: number;
}

interface SlashToken {
  query: string;
  start: number;
  end: number;
}

interface EditorPoint {
  container: Node;
  offset: number;
}

const EDITOR_LINE_SENTINEL = "\u200b";

function parseSlashToken(value: string): SlashToken | undefined {
  const match = /(^|\s)\/([^\s/]*)$/u.exec(value);
  if (match === null) return undefined;
  return {
    query: (match[2] ?? "").toLocaleLowerCase(),
    start: match.index + (match[1]?.length ?? 0),
    end: value.length,
  };
}

function appendTextWithBreaks(parent: DocumentFragment, text: string): void {
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line) parent.append(document.createTextNode(line));
    if (index < lines.length - 1) {
      parent.append(document.createElement("br"));
      if (index === lines.length - 2 && lines[index + 1] === "") {
        parent.append(document.createTextNode(EDITOR_LINE_SENTINEL));
      }
    }
  });
}

function editorText(node: Node): string {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let text = "";
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current.nodeType === Node.TEXT_NODE) {
      text += (current.textContent ?? "").replaceAll(EDITOR_LINE_SENTINEL, "");
    } else if (current.nodeName === "BR") {
      text += "\n";
    }
  }
  return text;
}

function editorSelection(editor: HTMLDivElement): EditorSelection | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
    return undefined;
  }

  const beforeStart = document.createRange();
  beforeStart.selectNodeContents(editor);
  beforeStart.setEnd(range.startContainer, range.startOffset);

  const beforeEnd = document.createRange();
  beforeEnd.selectNodeContents(editor);
  beforeEnd.setEnd(range.endContainer, range.endOffset);

  return {
    start: editorText(beforeStart.cloneContents()).length,
    end: editorText(beforeEnd.cloneContents()).length,
  };
}

function editorPoint(editor: HTMLDivElement, target: number): EditorPoint | undefined {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let remaining = target;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return { container: node, offset: remaining };
      remaining -= length;
      continue;
    }
    if (node.nodeName !== "BR") continue;
    if (remaining === 0) {
      const parent = node.parentNode;
      if (parent) return { container: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node) };
    }
    remaining -= 1;
    if (remaining === 0) {
      const parent = node.parentNode;
      if (parent) return { container: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node) + 1 };
    }
  }
  return undefined;
}

function restoreEditorSelection(editor: HTMLDivElement, selection: EditorSelection): void {
  const range = document.createRange();
  const start = editorPoint(editor, selection.start);
  const end = editorPoint(editor, selection.end);
  if (!start || !end) {
    range.selectNodeContents(editor);
    range.collapse(false);
  } else {
    range.setStart(start.container, start.offset);
    range.setEnd(end.container, end.offset);
  }

  const activeSelection = window.getSelection();
  activeSelection?.removeAllRanges();
  activeSelection?.addRange(range);
}

function renderEditorContent(editor: HTMLDivElement, value: string): void {
  const selection = editorSelection(editor);
  const segments = promptTextSegments(value);
  const hasLinks = segments.some((segment) => segment.kind === "link");
  const fragment = document.createDocumentFragment();

  for (const segment of segments) {
    if (segment.kind === "text") {
      appendTextWithBreaks(fragment, segment.text);
      continue;
    }

    const link = document.createElement("span");
    link.className = "prompt-editor-link";

    const icon = document.createElement("span");
    icon.className = "prompt-editor-link-icon";
    icon.contentEditable = "false";
    icon.setAttribute("aria-hidden", "true");

    link.append(icon, document.createTextNode(segment.text));
    fragment.append(link);
  }

  editor.replaceChildren(fragment);
  editor.dataset.renderValue = value;
  editor.dataset.hasLinks = hasLinks ? "true" : "false";
  if (selection) restoreEditorSelection(editor, selection);
}

function normalizeEditorValue(value: string): string {
  return value.trim().length === 0 ? "" : value;
}

function clearEditor(editor: HTMLDivElement): void {
  editor.replaceChildren();
  editor.dataset.renderValue = "";
  editor.dataset.hasLinks = "false";
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function PromptInput({
  value,
  defaultValue = "",
  onValueChange,
  models = [],
  model,
  defaultModel,
  onModelChange,
  actions = [],
  onAction,
  commands = [],
  commandMenuLabel = "Commands",
  commandHint = "Type to search commands",
  commandEmpty = "No matching commands",
  onSubmit,
  loading = false,
  stopping = false,
  onStop,
  minRows = 2,
  maxRows = 8,
  leadingAction,
  addActionLabel = "Add to prompt",
  sendLabel = "Send prompt",
  stopLabel = "Stop generating",
  stoppingLabel = "Stopping",
  className,
  disabled,
  placeholder = "Ask the agent to do something…",
  "aria-label": ariaLabel = "Prompt",
  onKeyDown,
  onInput,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  ...editorProps
}: PromptInputProps) {
  const reduce = useReducedMotion() ?? false;
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [internalModel, setInternalModel] = useState(
    defaultModel ?? models[0]?.value,
  );
  const [actionsOpen, setActionsOpen] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const currentValue = value ?? internalValue;
  const currentModelValue = model ?? internalModel;
  const currentModel = models.find(
    (option) => option.value === currentModelValue,
  );
  const canSubmit = Boolean(currentValue.trim()) && !disabled && !loading;
  const hasWebLinks = promptTextSegments(currentValue).some(
    (segment) => segment.kind === "link",
  );
  const slashToken = commandDismissed ? undefined : parseSlashToken(currentValue);
  const filteredCommands = slashToken === undefined || commands.length === 0
    ? []
    : commands
        .filter((command) => {
          const haystack = `${command.label} ${command.description ?? ""} ${command.keywords ?? ""}`.toLocaleLowerCase();
          return haystack.includes(slashToken.query);
        });
  const commandMenuOpen = slashToken !== undefined && commands.length > 0;

  useEffect(() => {
    setCommandIndex(0);
  }, [slashToken?.query, commands.length]);

  useEffect(() => {
    setCommandDismissed(false);
  }, [currentValue]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || composingRef.current) return;

    if (
      editor.dataset.renderValue === currentValue
      && editor.dataset.hasLinks === (hasWebLinks ? "true" : "false")
    ) {
      return;
    }
    if (!hasWebLinks && editor.textContent === currentValue && editor.dataset.hasLinks !== "true") {
      editor.dataset.renderValue = currentValue;
      editor.dataset.hasLinks = "false";
      return;
    }
    renderEditorContent(editor, currentValue);
  }, [currentValue, hasWebLinks]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (currentValue.length === 0) {
      setMultiline(false);
      return;
    }
    const style = getComputedStyle(editor);
    const lineHeight = Number.parseFloat(style.lineHeight) || 20;
    const verticalPadding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const contentHeight = editor.scrollHeight - verticalPadding;
    if (currentValue.includes("\n") || contentHeight > lineHeight * 1.5) setMultiline(true);
  }, [currentValue]);

  const setValue = (next: string) => {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
  };

  const chooseCommand = (command: PromptCommand) => {
    if (slashToken === undefined) return;
    const next = `${currentValue.slice(0, slashToken.start)}${command.value} ${currentValue.slice(slashToken.end)}`;
    setValue(next);
    setCommandDismissed(true);
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  };

  const setModel = (next: string) => {
    if (model === undefined) setInternalModel(next);
    onModelChange?.(next);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = currentValue.trim();
    if (!prompt || disabled || loading) return;

    onSubmit?.(prompt, currentModelValue);
    if (value === undefined) {
      setInternalValue("");
      if (editorRef.current) renderEditorContent(editorRef.current, "");
    }
    editorRef.current?.focus({ preventScroll: true });
  };

  const insertPlainText = (text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();

    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0
      && editor.contains(selection.anchorNode)
      ? selection.getRangeAt(0)
      : document.createRange();
    if (range.startContainer === document || !editor.contains(range.startContainer)) {
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    const inserted = document.createDocumentFragment();
    appendTextWithBreaks(inserted, text);
    const lastNode = inserted.lastChild;
    range.deleteContents();
    range.insertNode(inserted);
    if (lastNode) range.setStartAfter(lastNode);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    setValue(editorText(editor));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (commandMenuOpen) {
      if (event.key === "Escape") {
        event.preventDefault();
        setCommandDismissed(true);
        return;
      }
      if (filteredCommands.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        setCommandIndex((current) => (
          current + (event.key === "ArrowDown" ? 1 : filteredCommands.length - 1)
        ) % filteredCommands.length);
        return;
      }
      if (filteredCommands.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        chooseCommand(filteredCommands[commandIndex] ?? filteredCommands[0]!);
        return;
      }
    }
    if (event.key !== "Enter") return;

    event.preventDefault();
    if (event.shiftKey) {
      insertPlainText("\n");
      return;
    }
    submit();
  };

  return (
    <motion.form
      layout
      transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
      onSubmit={submit}
      data-multiline={multiline ? "true" : "false"}
      className={cn(
        "relative w-full rounded-lg border border-border/80 bg-background p-2 transition-colors focus-within:border-foreground/25",
        disabled && "opacity-60",
        className,
      )}
    >
      {commandMenuOpen ? (
        <div className="prompt-command-menu" role="listbox" aria-label={commandMenuLabel}>
          <div className="prompt-command-list">
            {filteredCommands.length === 0 ? (
              <div className="prompt-command-empty">{commandEmpty}</div>
            ) : filteredCommands.map((command, index) => (
              <button
                key={command.value}
                type="button"
                role="option"
                aria-selected={index === commandIndex}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setCommandIndex(index)}
                onClick={() => chooseCommand(command)}
                className={cn("prompt-command-row", index === commandIndex && "active")}
              >
                <span className="prompt-command-name">{command.label}</span>
                {command.description ? (
                  <span className="prompt-command-description">{command.description}</span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="prompt-command-hint">{commandHint}</div>
        </div>
      ) : null}
      <div
        ref={editorRef}
        {...editorProps}
        role="textbox"
        contentEditable={!disabled}
        suppressContentEditableWarning
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-multiline="true"
        aria-disabled={disabled || undefined}
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        data-empty={currentValue.length === 0 ? "true" : "false"}
        data-web-link={hasWebLinks ? "true" : undefined}
        onInput={(event) => {
          onInput?.(event);
          const editor = editorRef.current;
          if (!editor) return;
          const next = normalizeEditorValue(editorText(editor));
          if (next.length === 0) clearEditor(editor);
          setCommandDismissed(false);
          setValue(next);
        }}
        onKeyDown={handleKeyDown}
        onPaste={(event) => {
          onPaste?.(event);
          if (event.defaultPrevented) return;
          const text = event.clipboardData.getData("text/plain");
          if (!text) return;
          event.preventDefault();
          insertPlainText(text);
        }}
        onCompositionStart={(event) => {
          onCompositionStart?.(event);
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          onCompositionEnd?.(event);
          composingRef.current = false;
          const editor = editorRef.current;
          if (!editor) return;
          const next = normalizeEditorValue(editorText(editor));
          setCommandDismissed(false);
          setValue(next);
          if (next.length === 0) clearEditor(editor);
          else renderEditorContent(editor, next);
        }}
        style={{
          minHeight: `${minRows * 24}px`,
          maxHeight: `${maxRows * 24}px`,
        }}
        className="prompt-input-editor scrollbar-hide"
      />

      <motion.div
        layout
        transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
        className="mt-1 flex min-h-8 items-center gap-1"
      >
        {actions.length ? (
          <MorphPopover open={actionsOpen} onOpenChange={setActionsOpen}>
            <MorphPopoverTrigger>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || loading}
                aria-label={addActionLabel}
                className="size-8"
              >
                <motion.span
                  aria-hidden="true"
                  animate={{ rotate: actionsOpen ? 45 : 0 }}
                  transition={reduce ? { duration: 0 } : SPRING_SWAP}
                >
                  <Plus className="size-4" />
                </motion.span>
              </Button>
            </MorphPopoverTrigger>

            <MorphPopoverContent
              side="top"
              align="start"
              sideOffset={8}
              radius={10}
              className="w-56 p-1.5"
            >
              {actions.map((action) => (
                <button
                  key={action.value}
                  type="button"
                  disabled={action.disabled}
                  onClick={() => {
                    onAction?.(action.value);
                    setActionsOpen(false);
                  }}
                  className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  {action.icon ? (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                      {action.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground">
                      {action.label}
                    </span>
                    {action.description ? (
                      <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                        {action.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </MorphPopoverContent>
          </MorphPopover>
        ) : null}
        {leadingAction}
        {models.length ? (
          <Select
            value={currentModelValue ?? ""}
            onValueChange={setModel}
            disabled={disabled || loading}
            className="min-w-0"
          >
            <SelectTrigger className="h-8 w-auto max-w-52 rounded-md border-0 bg-transparent px-2 py-0 text-xs hover:bg-muted focus-visible:ring-2">
              <span className="flex min-w-0 items-center gap-1.5">
                {currentModel?.icon ? (
                  <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&_svg]:size-3.5">
                    {currentModel.icon}
                  </span>
                ) : null}
                <span className="truncate text-muted-foreground">
                  {currentModel?.label ?? "Choose model"}
                </span>
              </span>
            </SelectTrigger>
            <SelectContent className="right-auto w-52 shadow-none">
              {models.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
                  className="py-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {option.icon ? (
                      <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                        {option.icon}
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {option.label}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <Button
          type={loading ? "button" : "submit"}
          size="icon"
          disabled={loading ? !onStop || stopping : !canSubmit}
          aria-label={loading ? (stopping ? stoppingLabel : stopLabel) : sendLabel}
          onClick={loading ? onStop : undefined}
          className="ml-auto size-8"
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={loading ? "stop" : "send"}
              initial={reduce ? { opacity: 1 } : { opacity: 0, y: 3, scale: 0.8 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.8 }}
              transition={reduce ? { duration: 0 } : SPRING_SWAP}
              className="grid place-items-center"
            >
              {loading ? (
                stopping ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Square className="size-3 fill-current" />
                )
              ) : (
                <ArrowUp className="size-4" />
              )}
            </motion.span>
          </AnimatePresence>
        </Button>
      </motion.div>
    </motion.form>
  );
}
