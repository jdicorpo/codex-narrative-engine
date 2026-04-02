import { Modal, Setting, TFile } from 'obsidian';
import type CodexPlugin from '../main';

const ENTITY_TEMPLATES: Record<string, (name: string) => string> = {
  npc: (name) => `---\ntype: npc\nname: "${name}"\nstatus: unknown\ntags: []\n---\n\n`,
  creature: (name) => `---\ntype: creature\nname: "${name}"\ntags: []\n---\n\n`,
  location: (name) => `---\ntype: location\nname: "${name}"\ntags: []\n---\n\n`,
  faction: (name) => `---\ntype: faction\nname: "${name}"\nstatus: active\ntags: []\n---\n\n`,
  item: (name) => `---\ntype: item\nname: "${name}"\ntags: []\n---\n\n`,
  session: (name) => `---\ntype: session\nname: "${name}"\ndate: ${new Date().toISOString().split('T')[0]}\ntags: []\n---\n\n`,
  quest: (name) => `---\ntype: quest\nname: "${name}"\nstatus: active\ntags: []\n---\n\n`,
  adventure: (name) => `---\ntype: adventure\nname: "${name}"\nstatus: active\ntags: []\n---\n\n`,
  event: (name) => `---\ntype: event\nname: "${name}"\ntags: []\n---\n\n`,
  world: (name) => `---\ntype: world\nname: "${name}"\ntags: []\n---\n\n`,
  rules: (name) => `---\ntype: rules\nname: "${name}"\ntags: []\n---\n\n`,
  handout: (name) => `---\ntype: handout\nname: "${name}"\ntags: []\n---\n\n`,
};

function getEntityTemplate(type: string): (name: string) => string {
  return ENTITY_TEMPLATES[type] ?? ((name: string) =>
    `---\ntype: ${type}\nname: "${name}"\ntags: []\n---\n\n`);
}

const TYPE_FOLDERS: Record<string, string> = {
  npc: 'npcs',
  creature: 'creatures',
  location: 'locations',
  faction: 'factions',
  item: 'items',
  session: 'sessions',
  quest: 'quests',
  adventure: 'adventures',
  event: 'events',
  world: 'world',
  rules: 'rules',
  handout: 'handouts',
};

class CreateEntityModal extends Modal {
  private plugin: CodexPlugin;
  private entityName: string;
  private entityType: string = 'npc';
  private onSubmit: (type: string, name: string) => void;

  constructor(
    plugin: CodexPlugin,
    suggestedName: string,
    onSubmit: (type: string, name: string) => void,
  ) {
    super(plugin.app);
    this.plugin = plugin;
    this.entityName = suggestedName;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Create entity' });

    new Setting(contentEl)
      .setName('Entity name')
      .addText(text =>
        text
          .setValue(this.entityName)
          .onChange(value => { this.entityName = value; }),
      );

    new Setting(contentEl)
      .setName('Entity type')
      .addDropdown(dropdown => {
        for (const t of this.plugin.getEntityTypes()) {
          dropdown.addOption(t, t.charAt(0).toUpperCase() + t.slice(1));
        }
        dropdown.setValue(this.entityType);
        dropdown.onChange(value => { this.entityType = value; });
      });

    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText('Create')
          .setCta()
          .onClick(() => {
            if (this.entityName.trim()) {
              this.close();
              this.onSubmit(this.entityType, this.entityName.trim());
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

export function registerCreateEntityCommand(plugin: CodexPlugin): void {
  plugin.addCommand({
    id: 'create-entity',
    name: 'Create entity',
    callback: () => {
      new CreateEntityModal(plugin, '', (type, name) => {
        void createEntityFile(plugin, type, name);
      }).open();
    },
  });

  plugin.addCommand({
    id: 'create-entity-from-link',
    name: 'Create entity from dead link',
    checkCallback: (checking: boolean) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file) return false;
      if (checking) return true;

      const activeView = plugin.app.workspace.activeEditor;
      let suggestedName = '';
      if (activeView?.editor) {
        const selection = activeView.editor.getSelection();
        const cleaned = selection.replace(/\[\[|\]\]/g, '').trim();
        if (cleaned) suggestedName = cleaned;
      }

      new CreateEntityModal(plugin, suggestedName, (type, name) => {
        void createEntityFile(plugin, type, name);
      }).open();

      return true;
    },
  });
}

async function createEntityFile(
  plugin: CodexPlugin,
  type: string,
  name: string,
): Promise<void> {
  const vault = plugin.app.vault;
  const folder = TYPE_FOLDERS[type] ?? (type + 's');
  const filename = name.replace(/[/\\:*?"<>|]/g, '').trim();
  const path = folder ? `${folder}/${filename}.md` : `${filename}.md`;

  if (folder) {
    const existing = vault.getAbstractFileByPath(folder);
    if (!existing) {
      await vault.createFolder(folder);
    }
  }

  if (vault.getAbstractFileByPath(path)) {
    const file = vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await plugin.app.workspace.getLeaf(false).openFile(file);
    }
    return;
  }

  const template = getEntityTemplate(type);
  const content = template(name);
  const file = await vault.create(path, content);
  await plugin.app.workspace.getLeaf(false).openFile(file);
}
