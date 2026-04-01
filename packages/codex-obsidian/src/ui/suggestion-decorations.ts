import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';
import { EditorSelection, StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { Notice, TFile } from 'obsidian';
import { computeLineDiff } from '@codex-ide/core';
import type { DiffLine } from '@codex-ide/core';
import type CodexPlugin from '../main';

interface ObsidianEditorInternal {
  editor?: { cm?: EditorView };
  file?: TFile;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SuggestionHunk {
  id: number;
  /** Character offset in the new document where this hunk's additions begin. */
  from: number;
  /** Character offset in the new document where this hunk's additions end. */
  to: number;
  /** Lines removed from the original that this hunk replaces. */
  removedLines: string[];
}

interface SuggestionData {
  originalContent: string;
  newContent: string;
  filePath: string;
  label: string;
  hunks: SuggestionHunk[];
  additions: number;
  removals: number;
}

interface FieldState {
  data: SuggestionData;
}

// ---------------------------------------------------------------------------
// Paragraph-aware hunk building from a line diff
// ---------------------------------------------------------------------------

/**
 * Walk the diff and group consecutive changed lines into hunks, splitting
 * at paragraph boundaries (blank lines in the new text).
 */
function buildHunks(diff: DiffLine[], newText: string): SuggestionHunk[] {
  const hunks: SuggestionHunk[] = [];
  let newLineIdx = 0;
  let charOffset = 0;
  const newLines = newText.split('\n');

  let currentAdded: { from: number; to: number } | null = null;
  let currentRemoved: string[] = [];
  let id = 0;

  function flushHunk() {
    if (currentAdded || currentRemoved.length > 0) {
      hunks.push({
        id: id++,
        from: currentAdded?.from ?? charOffset,
        to: currentAdded?.to ?? charOffset,
        removedLines: currentRemoved,
      });
      currentAdded = null;
      currentRemoved = [];
    }
  }

  for (const entry of diff) {
    if (entry.type === 'remove') {
      currentRemoved.push(entry.text);
      continue;
    }

    const lineText = newLines[newLineIdx] ?? '';
    const lineLen = lineText.length;
    const isBlank = lineText.trim() === '';

    if (entry.type === 'add') {
      if (isBlank && (currentAdded || currentRemoved.length > 0)) {
        flushHunk();
      } else {
        if (!currentAdded) {
          currentAdded = { from: charOffset, to: charOffset + lineLen };
        } else {
          currentAdded.to = charOffset + lineLen;
        }
      }
    } else {
      // context line — flush any pending hunk
      if (currentAdded || currentRemoved.length > 0) {
        if (isBlank) {
          flushHunk();
        } else {
          flushHunk();
        }
      }
    }

    charOffset += lineLen + 1; // +1 for newline
    newLineIdx++;
  }

  flushHunk();
  return hunks;
}

// ---------------------------------------------------------------------------
// State effects & field
// ---------------------------------------------------------------------------

const setSuggestions = StateEffect.define<SuggestionData>();
const clearSuggestions = StateEffect.define<null>();
const dismissHunk = StateEffect.define<number>();
const revertHunk = StateEffect.define<number>();

export const suggestionField = StateField.define<FieldState | null>({
  create: () => null,

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSuggestions)) return { data: effect.value };
      if (effect.is(clearSuggestions)) return null;
      if (effect.is(dismissHunk) && value) {
        const remaining = value.data.hunks.filter(h => h.id !== effect.value);
        if (remaining.length === 0) return null;
        return { data: { ...value.data, hunks: remaining } };
      }
      if (effect.is(revertHunk) && value) {
        const remaining = value.data.hunks.filter(h => h.id !== effect.value);
        if (remaining.length === 0) return null;
        return { data: { ...value.data, hunks: remaining } };
      }
    }
    if (value && tr.docChanged) {
      const isOurChange = tr.effects.some(
        e => e.is(setSuggestions) || e.is(revertHunk),
      );
      if (!isOurChange) return null;
    }
    return value;
  },
});

// ---------------------------------------------------------------------------
// Strikethrough widget for removed lines
// ---------------------------------------------------------------------------

class RemovedLinesWidget extends WidgetType {
  constructor(private lines: string[]) {
    super();
  }

  eq(other: RemovedLinesWidget): boolean {
    return this.lines.length === other.lines.length &&
      this.lines.every((l, i) => l === other.lines[i]);
  }

  toDOM(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'codex-suggestion-removed';
    for (const line of this.lines) {
      const el = document.createElement('div');
      el.className = 'codex-suggestion-removed-line';
      el.textContent = line || '\u00A0';
      container.appendChild(el);
    }
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Decoration StateField
// ---------------------------------------------------------------------------

const addMark = Decoration.mark({ class: 'codex-suggestion-add' });

export function createSuggestionDecorations(_plugin: CodexPlugin) {
  return StateField.define<DecorationSet>({
    create() {
      return Decoration.none;
    },

    update(_, tr) {
      const state = tr.state.field(suggestionField, false);
      if (!state || state.data.hunks.length === 0) return Decoration.none;

      const { data } = state;
      const builder = new RangeSetBuilder<Decoration>();
      const docLen = tr.state.doc.length;

      const sorted = [...data.hunks].sort((a, b) => a.from - b.from);
      for (const hunk of sorted) {
        const from = Math.min(hunk.from, docLen);
        const to = Math.min(hunk.to, docLen);

        if (hunk.removedLines.length > 0) {
          builder.add(from, from, Decoration.widget({
            widget: new RemovedLinesWidget(hunk.removedLines),
            side: -1,
            block: true,
          }));
        }

        if (from < to) {
          builder.add(from, to, addMark);
        }
      }

      return builder.finish();
    },

    provide: (field) => EditorView.decorations.from(field),
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function findEditorViewsWithSuggestions(plugin: CodexPlugin): EditorView[] {
  const views: EditorView[] = [];
  plugin.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
    const cm = (leaf.view as unknown as ObsidianEditorInternal)?.editor?.cm;
    if (cm && cm.state.field(suggestionField, false)) {
      views.push(cm);
    }
  });
  return views;
}

/** Returns true if there are active suggestions in any open editor. */
export function hasSuggestions(plugin: CodexPlugin): boolean {
  return findEditorViewsWithSuggestions(plugin).some(
    (cm) => cm.state.field(suggestionField, false) != null,
  );
}

/**
 * Returns the hunk ID at the current cursor position, or null if the cursor
 * isn't inside a suggestion hunk.
 */
export function getHunkIdAtCursor(plugin: CodexPlugin): number | null {
  for (const view of findEditorViewsWithSuggestions(plugin)) {
    const state = view.state.field(suggestionField, false);
    if (!state) continue;
    const cursor = view.state.selection.main.head;
    for (const hunk of state.data.hunks) {
      if (cursor >= hunk.from && cursor <= hunk.to) return hunk.id;
    }
  }
  return null;
}

/** Accept a single hunk — dismiss the highlight, keep the new text. */
export function dismissSingleHunk(plugin: CodexPlugin, hunkId: number): void {
  for (const view of findEditorViewsWithSuggestions(plugin)) {
    view.dispatch({ effects: [dismissHunk.of(hunkId)] });
  }
}

/** Reject a single hunk — replace its new text with the original removed lines. */
export function rejectSingleHunk(plugin: CodexPlugin, hunkId: number): void {
  for (const view of findEditorViewsWithSuggestions(plugin)) {
    const state = view.state.field(suggestionField, false);
    if (!state) continue;

    const hunk = state.data.hunks.find(h => h.id === hunkId);
    if (!hunk) continue;

    const originalText = hunk.removedLines.join('\n');
    const from = Math.min(hunk.from, view.state.doc.length);
    const to = Math.min(hunk.to, view.state.doc.length);

    const offsetDelta = originalText.length - (to - from);

    const updatedHunks = state.data.hunks
      .filter(h => h.id !== hunkId)
      .map(h => {
        if (h.from > from) {
          return { ...h, from: h.from + offsetDelta, to: h.to + offsetDelta };
        }
        return h;
      });

    const newData: SuggestionData = {
      ...state.data,
      hunks: updatedHunks,
    };

    view.dispatch({
      changes: { from, to, insert: originalText },
      effects: updatedHunks.length > 0
        ? [revertHunk.of(hunkId), setSuggestions.of(newData)]
        : [clearSuggestions.of(null)],
    });
  }
}

export function acceptAllSuggestions(plugin: CodexPlugin): void {
  for (const view of findEditorViewsWithSuggestions(plugin)) {
    view.dispatch({ effects: [clearSuggestions.of(null)] });
  }
  new Notice('Codex: Suggestions accepted.');
}

export function rejectAllSuggestions(plugin: CodexPlugin): void {
  for (const view of findEditorViewsWithSuggestions(plugin)) {
    const state = view.state.field(suggestionField, false);
    if (!state) continue;

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: state.data.originalContent },
      effects: [clearSuggestions.of(null)],
      selection: EditorSelection.cursor(0),
    });
  }
  new Notice('Codex: Suggestions rejected — original content restored.');
}

// ---------------------------------------------------------------------------
// Public API — called by AI commands
// ---------------------------------------------------------------------------

export async function applySuggestedEdit(
  plugin: CodexPlugin,
  file: TFile,
  newContent: string,
  label: string,
): Promise<void> {
  const oldContent = await plugin.app.vault.read(file);

  if (oldContent === newContent) {
    new Notice('Codex: No changes to suggest.');
    return;
  }

  const diff = computeLineDiff(oldContent, newContent);
  const hunks = buildHunks(diff, newContent);
  const additions = diff.filter(l => l.type === 'add').length;
  const removals = diff.filter(l => l.type === 'remove').length;

  const data: SuggestionData = {
    originalContent: oldContent,
    newContent,
    filePath: file.path,
    label,
    hunks,
    additions,
    removals,
  };

  let applied = false;
  plugin.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
    const internal = leaf.view as unknown as ObsidianEditorInternal;
    const leafFile = internal?.file;
    if (leafFile?.path !== file.path) return;
    const cm = internal?.editor?.cm;
    if (!cm) return;

    cm.dispatch({
      changes: { from: 0, to: cm.state.doc.length, insert: newContent },
      effects: [setSuggestions.of(data)],
      selection: EditorSelection.cursor(0),
    });
    applied = true;
  });

  if (!applied) {
    await plugin.app.vault.modify(file, newContent);
  }
}
