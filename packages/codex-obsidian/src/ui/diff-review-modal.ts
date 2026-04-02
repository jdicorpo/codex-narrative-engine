import { Modal, Notice, TFile } from 'obsidian';
import { computeLineDiff } from '@codex-ide/core';
import type { DiffLine } from '@codex-ide/core';
import type CodexPlugin from '../main';

/**
 * Collapse long unchanged regions, keeping `margin` context lines around changes.
 */
function collapseContext(lines: DiffLine[], margin = 3): (DiffLine | { type: 'collapsed'; count: number })[] {
  const isChange = (l: DiffLine) => l.type !== 'context';
  const changeIndices = lines.map((l, i) => isChange(l) ? i : -1).filter(i => i >= 0);

  if (changeIndices.length === 0) {
    if (lines.length <= margin * 2 + 1) return lines;
    return [
      ...lines.slice(0, margin),
      { type: 'collapsed' as const, count: lines.length - margin * 2 },
      ...lines.slice(lines.length - margin),
    ];
  }

  const visible = new Set<number>();
  for (const ci of changeIndices) {
    for (let k = Math.max(0, ci - margin); k <= Math.min(lines.length - 1, ci + margin); k++) {
      visible.add(k);
    }
  }

  const output: (DiffLine | { type: 'collapsed'; count: number })[] = [];
  let hiddenRun = 0;

  for (let i = 0; i < lines.length; i++) {
    if (visible.has(i)) {
      if (hiddenRun > 0) {
        output.push({ type: 'collapsed', count: hiddenRun });
        hiddenRun = 0;
      }
      output.push(lines[i]);
    } else {
      hiddenRun++;
    }
  }
  if (hiddenRun > 0) {
    output.push({ type: 'collapsed', count: hiddenRun });
  }

  return output;
}

// ---------------------------------------------------------------------------
// Diff Review Modal
// ---------------------------------------------------------------------------

class DiffReviewModal extends Modal {
  private resolved = false;
  private onResolve: (accepted: boolean) => void = () => {};

  constructor(
    private plugin: CodexPlugin,
    private file: TFile,
    private oldContent: string,
    private newContent: string,
    private label: string,
  ) {
    super(plugin.app);
  }

  readonly result = new Promise<boolean>(resolve => {
    this.onResolve = resolve;
  });

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('codex-diff-modal');

    const rawDiff = computeLineDiff(this.oldContent, this.newContent);
    const additions = rawDiff.filter(l => l.type === 'add').length;
    const removals = rawDiff.filter(l => l.type === 'remove').length;
    const collapsed = collapseContext(rawDiff);

    contentEl.createEl('h3', { text: `Review: ${this.label}` });
    contentEl.createEl('p', {
      text: `${this.file.basename}  —  +${additions} / -${removals} lines`,
      cls: 'codex-diff-summary',
    });

    const body = contentEl.createDiv({ cls: 'codex-diff-body' });

    for (const entry of collapsed) {
      if (entry.type === 'collapsed') {
        const row = body.createDiv({ cls: 'codex-diff-collapsed' });
        row.setText(`··· ${entry.count} unchanged lines ···`);
        continue;
      }
      const row = body.createDiv({ cls: `codex-diff-line codex-diff-line-${entry.type}` });
      const prefix = entry.type === 'add' ? '+ ' : entry.type === 'remove' ? '- ' : '  ';
      row.setText(prefix + entry.text);
    }

    const actions = contentEl.createDiv({ cls: 'codex-diff-actions' });

    const rejectBtn = actions.createEl('button', { text: 'Reject' });
    rejectBtn.addEventListener('click', () => {
      this.resolved = true;
      this.onResolve(false);
      this.close();
    });

    const acceptBtn = actions.createEl('button', { text: 'Accept', cls: 'mod-cta' });
    acceptBtn.addEventListener('click', () => {
      this.resolved = true;
      this.onResolve(true);
      this.close();
    });
  }

  onClose(): void {
    if (!this.resolved) {
      this.onResolve(false);
    }
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Show a diff review modal for an AI-proposed edit.
 * Returns true if the user accepted the changes (file already written),
 * false if rejected.
 */
export async function proposeEdit(
  plugin: CodexPlugin,
  file: TFile,
  newContent: string,
  label: string,
): Promise<boolean> {
  const oldContent = await plugin.app.vault.read(file);

  if (oldContent === newContent) {
    new Notice('Codex: no changes to suggest.');
    return false;
  }

  const modal = new DiffReviewModal(plugin, file, oldContent, newContent, label);
  modal.open();

  const accepted = await modal.result;

  if (accepted) {
    await plugin.app.vault.modify(file, newContent);
    new Notice(`Codex: applied changes to ${file.basename}`);
  } else {
    new Notice('Codex: changes rejected.');
  }

  return accepted;
}
