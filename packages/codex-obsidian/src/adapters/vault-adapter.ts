import { App, TFile, TAbstractFile, EventRef } from 'obsidian';
import { EntityRegistry } from '@codex-ide/core';

export class VaultAdapter {
  constructor(
    private app: App,
    private registry: EntityRegistry,
  ) {}

  get configDir(): string {
    return this.app.vault.configDir;
  }

  /**
   * Perform a full index of all Markdown files in the vault.
   */
  async fullIndex(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      if (this.shouldIgnore(file.path)) continue;
      const content = await this.app.vault.cachedRead(file);
      this.registry.indexFile(file.path, content);
    }
  }

  /**
   * Register vault event listeners for incremental index updates.
   */
  registerListeners(
    registerEvent: (event: EventRef) => void,
    onUpdate: () => void,
  ): void {
    registerEvent(
      this.app.metadataCache.on('changed', async (file: TFile) => {
        if (file.extension !== 'md') return;
        if (this.shouldIgnore(file.path)) return;
        const content = await this.app.vault.cachedRead(file);
        this.registry.indexFile(file.path, content);
        onUpdate();
      }),
    );

    registerEvent(
      this.app.vault.on('delete', (file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.registry.removeFile(file.path);
          onUpdate();
        }
      }),
    );

    registerEvent(
      this.app.vault.on('rename', async (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.registry.removeFile(oldPath);
          if (!this.shouldIgnore(file.path)) {
            const content = await this.app.vault.cachedRead(file);
            this.registry.indexFile(file.path, content);
          }
          onUpdate();
        }
      }),
    );
  }

  private shouldIgnore(path: string): boolean {
    const ignoredPrefixes = [`${this.app.vault.configDir}/`, '.trash/', '.codex/'];
    return ignoredPrefixes.some(prefix => path.startsWith(prefix));
  }
}
