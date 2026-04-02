import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import type { Editor } from 'obsidian';
import type CodexPlugin from '../main';
import type { Diagnostic } from '@codex-ide/core';

export const WARNINGS_VIEW_TYPE = 'codex-warnings';

export class WarningsView extends ItemView {
  private plugin: CodexPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: CodexPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return WARNINGS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Narrative warnings';
  }

  getIcon(): string {
    return 'scroll-text';
  }

  onOpen(): void {
    this.refresh();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  refresh(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass('codex-warnings-panel');

    const allDiagnostics = this.plugin.diagnosticEngine.diagnoseAll();
    const diagnostics = allDiagnostics.filter(d => {
      if (d.rule !== 'dead-link' || !d.relatedEntities?.[0]) return true;
      return !this.plugin.app.metadataCache.getFirstLinkpathDest(
        d.relatedEntities[0], d.filePath,
      );
    });

    if (diagnostics.length === 0) {
      const empty = container.createDiv({ cls: 'codex-empty-state' });
      empty.createEl('p', { text: 'No narrative issues found.' });
      empty.createEl('p', { text: 'Your world is consistent.', cls: 'codex-empty-subtitle' });
      return;
    }

    const warnings = diagnostics.filter(d => d.severity === 'warning');
    const hints = diagnostics.filter(d => d.severity === 'hint');
    const errors = diagnostics.filter(d => d.severity === 'error');

    const fileCount = new Set(diagnostics.map(d => d.filePath)).size;
    const header = container.createDiv({ cls: 'codex-warnings-header' });
    const parts: string[] = [];
    if (errors.length > 0) parts.push(`${errors.length} error${errors.length !== 1 ? 's' : ''}`);
    if (warnings.length > 0) parts.push(`${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`);
    if (hints.length > 0) parts.push(`${hints.length} hint${hints.length !== 1 ? 's' : ''}`);
    header.setText(`${parts.join(', ')} across ${fileCount} file${fileCount !== 1 ? 's' : ''}`);

    if (errors.length > 0) this.renderGroup(container, 'Errors', errors);
    if (warnings.length > 0) this.renderGroup(container, 'Warnings', warnings);
    if (hints.length > 0) this.renderGroup(container, 'Hints', hints);
  }

  private renderGroup(
    container: HTMLElement,
    title: string,
    diagnostics: Diagnostic[],
  ): void {
    const group = container.createDiv({ cls: 'codex-warning-group' });
    group.createDiv({ cls: 'codex-warning-group-title', text: title });

    for (const diag of diagnostics) {
      const item = group.createDiv({ cls: 'codex-warning-item' });
      item.createDiv({ cls: 'codex-warning-message', text: diag.message });

      const filename = diag.filePath.split('/').pop() ?? diag.filePath;
      item.createDiv({
        cls: 'codex-warning-file',
        text: `${filename}:${diag.line}`,
      });

      item.addEventListener('click', () => {
        void this.navigateTo(diag);
      });
    }
  }

  private async navigateTo(diag: Diagnostic): Promise<void> {
    const abstractFile = this.app.vault.getAbstractFileByPath(diag.filePath);
    if (!(abstractFile instanceof TFile)) return;

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(abstractFile);

    const view = leaf.view as unknown as { editor?: Editor };
    if (view.editor) {
      const pos = { line: diag.line - 1, ch: diag.column };
      view.editor.setCursor(pos);
      view.editor.scrollIntoView({ from: pos, to: pos }, true);
    }
  }
}
