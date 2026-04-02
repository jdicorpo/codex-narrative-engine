import { App, Modal, Notice, TFile, Setting } from 'obsidian';
import type CodexPlugin from '../main';

class RenameModal extends Modal {
  private oldName: string;
  private newName: string;
  private onSubmit: (newName: string) => void;

  constructor(app: App, oldName: string, onSubmit: (newName: string) => void) {
    super(app);
    this.oldName = oldName;
    this.newName = oldName;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Rename entity' });
    contentEl.createEl('p', {
      text: `Current name: ${this.oldName}`,
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .setName('New name')
      .addText(text =>
        text
          .setValue(this.oldName)
          .onChange(value => { this.newName = value; })
          .inputEl.focus()
      );

    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText('Rename')
          .setCta()
          .onClick(() => {
            if (this.newName && this.newName !== this.oldName) {
              this.close();
              this.onSubmit(this.newName);
            }
          })
      )
      .addButton(btn =>
        btn
          .setButtonText('Cancel')
          .onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ConfirmRenameModal extends Modal {
  private oldName: string;
  private newName: string;
  private affectedFiles: string[];
  private onConfirm: () => void;

  constructor(
    app: App,
    oldName: string,
    newName: string,
    affectedFiles: string[],
    onConfirm: () => void,
  ) {
    super(app);
    this.oldName = oldName;
    this.newName = newName;
    this.affectedFiles = affectedFiles;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Confirm rename' });
    contentEl.createEl('p', {
      text: `Rename "${this.oldName}" → "${this.newName}"`,
    });
    contentEl.createEl('p', {
      text: `This will update ${this.affectedFiles.length} file${this.affectedFiles.length !== 1 ? 's' : ''}:`,
    });

    const list = contentEl.createEl('ul');
    for (const file of this.affectedFiles.slice(0, 20)) {
      list.createEl('li', { text: file });
    }
    if (this.affectedFiles.length > 20) {
      list.createEl('li', {
        text: `...and ${this.affectedFiles.length - 20} more`,
        cls: 'setting-item-description',
      });
    }

    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText(`Rename in ${this.affectedFiles.length} files`)
          .setCta()
          .onClick(() => {
            this.close();
            this.onConfirm();
          })
      )
      .addButton(btn =>
        btn
          .setButtonText('Cancel')
          .onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function startRename(plugin: CodexPlugin, file: TFile): void {
  const entity = plugin.registry.getByPath(file.path);
  if (!entity) return;

  new RenameModal(plugin.app, entity.name, (newName) => {
    const refs = plugin.registry.findReferences(entity.name);
    const affectedPaths = new Set<string>();

    affectedPaths.add(entity.filePath);
    for (const ref of refs) {
      affectedPaths.add(ref.sourcePath);
    }

    const affectedFiles = [...affectedPaths];

    new ConfirmRenameModal(
      plugin.app,
      entity.name,
      newName,
      affectedFiles,
      () => {
        void performRename(plugin, entity.filePath, entity.name, newName, affectedFiles);
      },
    ).open();
  }).open();
}

export function registerRenameCommand(plugin: CodexPlugin): void {
  plugin.addCommand({
    id: 'rename-entity',
    name: 'Rename entity',
    checkCallback: (checking: boolean) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file) return false;

      const entity = plugin.registry.getByPath(file.path);
      if (!entity) return false;

      if (checking) return true;
      startRename(plugin, file);
      return true;
    },
  });
}

async function performRename(
  plugin: CodexPlugin,
  entityPath: string,
  oldName: string,
  newName: string,
  affectedFiles: string[],
): Promise<void> {
  const vault = plugin.app.vault;

  for (const filePath of affectedFiles) {
    const file = vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) continue;

    await vault.process(file, (content) => {
      let updated = content;

      if (filePath === entityPath) {
        updated = updated.replace(
          new RegExp(`(name:\\s*["']?)${escapeRegex(oldName)}(["']?)`, 'g'),
          `$1${newName}$2`,
        );
      }

      updated = updated.replace(
        new RegExp(`\\[\\[${escapeRegex(oldName)}(\\|[^\\]]*)?\\]\\]`, 'g'),
        `[[${newName}$1]]`,
      );

      return updated;
    });
  }

  // Rename the file on disk to match the new entity name
  const entityFile = vault.getAbstractFileByPath(entityPath);
  if (entityFile instanceof TFile) {
    const dir = entityFile.parent?.path ?? '';
    const newPath = dir ? `${dir}/${newName}.md` : `${newName}.md`;
    if (newPath !== entityPath) {
      await vault.rename(entityFile, newPath);
    }
  }

  new Notice(
    `Codex: Renamed "${oldName}" → "${newName}" across ${affectedFiles.length} file${affectedFiles.length !== 1 ? 's' : ''}`,
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
