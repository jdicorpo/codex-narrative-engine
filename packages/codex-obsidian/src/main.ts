import { Menu, Notice, Plugin, TFile } from 'obsidian';
import { EntityRegistry, DiagnosticEngine, ContextAssembler, pluralVariants } from '@codex-ide/core';
import type { LLMProvider } from '@codex-ide/core';
import { VaultAdapter } from './adapters/vault-adapter';
import { WarningsView, WARNINGS_VIEW_TYPE } from './ui/warnings-view';
import { LoreChatView, CHAT_VIEW_TYPE } from './ui/chat-view';
import { createDiagnosticViewPlugin, createGutterViewPlugin, refreshDiagnostics } from './ui/diagnostic-decorations';
import { createLinkStylingPlugin } from './ui/link-styling';
import { createDeadLinkPostProcessor } from './ui/reading-mode-decorations';
import { installGlobalHover } from './ui/global-hover';
import { EntitySuggest } from './ui/entity-suggest';
import {
  suggestionField, createSuggestionDecorations,
  acceptAllSuggestions, rejectAllSuggestions,
  hasSuggestions, getHunkIdAtCursor, dismissSingleHunk, rejectSingleHunk,
} from './ui/suggestion-decorations';
import { registerRenameCommand, startRename } from './commands/rename-entity';
import { registerCreateEntityCommand } from './commands/create-entity';
import {
  registerAICommands, DEFAULT_TEMPLATES,
  enhanceNote, describeScene, extractEntities,
  reviseSelection, generateEntityFromContext,
} from './commands/ai-commands';
import { CodexSettingTab, CodexSettings, DEFAULT_SETTINGS, getProviderConfig } from './settings';
import { createProvider } from './ai/provider-factory';
import type { EditorView } from '@codemirror/view';

interface ObsidianEditorInternal {
  editor?: { cm?: EditorView };
  file?: TFile;
}

interface MenuItemWithSubmenu {
  setSubmenu(): Menu;
}

export default class CodexPlugin extends Plugin {
  registry!: EntityRegistry;
  diagnosticEngine!: DiagnosticEngine;
  vaultAdapter!: VaultAdapter;
  contextAssembler!: ContextAssembler;
  settings!: CodexSettings;
  entitySuggest!: EntitySuggest;

  private provider: LLMProvider | null = null;
  private teardownGlobalHover: (() => void) | null = null;

  async onload(): Promise<void> {
    console.debug('Codex plugin v0.2.0 loading');
    await this.loadSettings();

    this.registry = new EntityRegistry();
    this.syncCustomTypes();
    this.diagnosticEngine = new DiagnosticEngine(this.registry);
    this.vaultAdapter = new VaultAdapter(this.app, this.registry);
    this.contextAssembler = new ContextAssembler(this.registry, {
      recentSessionCount: this.settings.aiRecentSessions,
      linkExpansionDepth: this.settings.aiLinkDepth,
      includeWorldEntities: this.settings.aiIncludeWorld,
    });

    // Sidebar panels
    this.registerView(
      WARNINGS_VIEW_TYPE,
      (leaf) => new WarningsView(leaf, this),
    );
    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf) => new LoreChatView(leaf, this),
    );

    // CM6 editor extensions
    this.registerEditorExtension(createDiagnosticViewPlugin(this));
    this.registerEditorExtension(createGutterViewPlugin(this));
    this.registerEditorExtension(createLinkStylingPlugin(this));
    this.registerEditorExtension(suggestionField);
    this.registerEditorExtension(createSuggestionDecorations(this));

    // Reading mode dead-link badges
    this.registerMarkdownPostProcessor(createDeadLinkPostProcessor(this));

    // Global hover tooltip (works in Reading, Live Preview, and Source modes)
    this.teardownGlobalHover = installGlobalHover(this);

    // Autocomplete — replaces Obsidian's built-in link suggest with Codex's enhanced version
    this.entitySuggest = new EntitySuggest(this);
    this.registerEditorSuggest(this.entitySuggest);

    this.addRibbonIcon('scroll-text', 'Codex: Narrative Warnings', () => {
      this.activateWarningsPanel();
    });

    this.addRibbonIcon('message-square', 'Codex: Lore Chat', () => {
      this.activateChatPanel();
    });

    // Commands
    this.addCommand({
      id: 'open-warnings-panel',
      name: 'Open Narrative Warnings',
      callback: () => this.activateWarningsPanel(),
    });

    this.addCommand({
      id: 'reindex-vault',
      name: 'Re-index Vault',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'r' }],
      callback: async () => {
        this.registry.clear();
        await this.vaultAdapter.fullIndex();
        this.refreshWarningsView();
        this.refreshEditorDiagnostics();
        new Notice(`Codex: Re-indexed ${this.registry.size} entities`);
      },
    });

    this.addCommand({
      id: 'open-lore-chat',
      name: 'Open Lore Chat',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'l' }],
      callback: () => this.activateChatPanel(),
    });

    registerRenameCommand(this);
    registerCreateEntityCommand(this);
    registerAICommands(this);

    this.addCommand({
      id: 'accept-suggestions',
      name: 'Accept AI Suggestions',
      callback: () => acceptAllSuggestions(this),
    });

    this.addCommand({
      id: 'reject-suggestions',
      name: 'Reject AI Suggestions',
      callback: () => rejectAllSuggestions(this),
    });

    // Index vault when ready; also ensure template files exist
    this.app.workspace.onLayoutReady(async () => {
      await this.ensureTemplates();
      await this.vaultAdapter.fullIndex();
      console.debug(`Codex: Indexed ${this.registry.size} entities`);
      this.refreshWarningsView();
      this.refreshEditorDiagnostics();
    });

    // Incremental updates — refresh both warnings panel and editor diagnostics
    this.vaultAdapter.registerListeners(
      this.registerEvent.bind(this),
      () => {
        this.refreshWarningsView();
        this.refreshEditorDiagnostics();
      },
    );

    this.addSettingTab(new CodexSettingTab(this.app, this));

    // Editor context menu — "Codex AI" submenu + suggestion review items
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, _editor, view) => {
        const file = view.file;
        if (!file || file.extension !== 'md') return;

        const suggestionsActive = hasSuggestions(this);

        if (suggestionsActive) {
          const hunkId = getHunkIdAtCursor(this);

          if (hunkId != null) {
            menu.addItem((item) =>
              item.setTitle('Accept This Change').setIcon('check')
                .onClick(() => dismissSingleHunk(this, hunkId)),
            );
            menu.addItem((item) =>
              item.setTitle('Reject This Change').setIcon('x')
                .onClick(() => rejectSingleHunk(this, hunkId)),
            );
          }
          menu.addItem((item) =>
            item.setTitle('Accept All Changes').setIcon('check-check')
              .onClick(() => acceptAllSuggestions(this)),
          );
          menu.addItem((item) =>
            item.setTitle('Reject All Changes').setIcon('x')
              .onClick(() => rejectAllSuggestions(this)),
          );
          menu.addSeparator();
        }

        menu.addItem((item) => {
          item.setTitle('Codex AI').setIcon('wand-2');
          const submenu = (item as unknown as MenuItemWithSubmenu).setSubmenu();

          const editor = _editor;
          const cm = (view as unknown as ObsidianEditorInternal)?.editor?.cm;
          const selection = editor.getSelection();
          const hasSelection = selection && selection.trim().length > 0;

          if (hasSelection && cm) {
            const from = cm.state.selection.main.from;
            const to = cm.state.selection.main.to;
            submenu.addItem((sub) =>
              sub.setTitle('Revise Selection…').setIcon('pencil')
                .onClick(() => reviseSelection(this, file, selection, from, to)),
            );
          }

          if (cm) {
            const rawText = hasSelection
              ? selection.trim()
              : cm.state.wordAt(cm.state.selection.main.head)
                ? cm.state.doc.sliceString(
                    cm.state.wordAt(cm.state.selection.main.head)!.from,
                    cm.state.wordAt(cm.state.selection.main.head)!.to,
                  )
                : '';
            if (rawText) {
              const entityName = rawText.replace(/\[\[|\]\]|\*+|_+|^#+\s*/g, '').trim();
              const cursor = cm.state.selection.main.head;
              const doc = cm.state.doc.toString();
              const lineNum = cm.state.doc.lineAt(cursor).number;
              const startLine = Math.max(1, lineNum - 2);
              const endLine = Math.min(cm.state.doc.lines, lineNum + 2);
              const surrounding = doc.slice(
                cm.state.doc.line(startLine).from,
                cm.state.doc.line(endLine).to,
              ).slice(0, 300);

              submenu.addItem((sub) =>
                sub.setTitle(`Generate "${entityName}"…`).setIcon('plus-circle')
                  .onClick(() => generateEntityFromContext(this, entityName, surrounding)),
              );
            }
          }

          if (hasSelection || cm) {
            submenu.addSeparator();
          }

          submenu.addItem((sub) =>
            sub.setTitle('Enhance Note').setIcon('sparkles')
              .onClick(() => enhanceNote(this, file)),
          );
          submenu.addItem((sub) =>
            sub.setTitle('Describe Scene (Read-Aloud)').setIcon('eye')
              .onClick(() => describeScene(this, file)),
          );
          submenu.addSeparator();
          submenu.addItem((sub) =>
            sub.setTitle('Extract Entities').setIcon('scan-search')
              .onClick(() => extractEntities(this, file)),
          );
        });

        const entity = this.registry.getByPath(file.path);
        if (entity) {
          menu.addItem((item) =>
            item.setTitle(`Rename "${entity.name}"…`).setIcon('pencil-line')
              .onClick(() => startRename(this, file)),
          );
        }
      }),
    );

    // File explorer context menu — entity-related actions
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, abstractFile) => {
        if (!(abstractFile instanceof TFile) || abstractFile.extension !== 'md') return;

        const entity = this.registry.getByPath(abstractFile.path);
        if (entity) {
          menu.addItem((item) =>
            item.setTitle(`Codex: Rename "${entity.name}"…`).setIcon('pencil-line')
              .onClick(() => startRename(this, abstractFile)),
          );
        }

        menu.addItem((item) =>
          item.setTitle('Codex: Extract Entities').setIcon('scan-search')
            .onClick(() => extractEntities(this, abstractFile)),
        );
      }),
    );

    // Override link navigation to support aliases, name matching, and plurals
    this.installLinkNavigationOverride();

    this.applyStatblockWidth();
  }

  onunload(): void {
    this.teardownGlobalHover?.();
    this.entitySuggest?.restoreBuiltInSuggest();
    this.restoreLinkNavigation();
    this.removeStatblockStyle();
    this.registry.clear();
  }

  syncCustomTypes(): void {
    const builtIn = new Set(DEFAULT_SETTINGS.entityTypes);
    const custom = this.settings.entityTypes.filter(t => !builtIn.has(t));
    this.registry.setCustomTypes(custom);
  }

  getEntityTypes(): string[] {
    return this.settings.entityTypes;
  }

  applyStatblockWidth(): void {
    const width = this.settings.statblockWidth ?? 600;
    document.body.style.setProperty('--codex-statblock-width', `${width}px`);
  }

  private removeStatblockStyle(): void {
    document.body.style.removeProperty('--codex-statblock-width');
  }

  private originalOpenLinkText: ((linktext: string, sourcePath: string, newLeaf?: boolean | string, openViewState?: Record<string, unknown>) => Promise<void>) | null = null;

  private installLinkNavigationOverride(): void {
    const workspace = this.app.workspace;
    this.originalOpenLinkText = workspace.openLinkText.bind(workspace);

    workspace.openLinkText = async (
      linktext: string,
      sourcePath: string,
      newLeaf?: boolean | string,
      openViewState?: Record<string, unknown>,
    ) => {
      const nativeResolved = this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
      if (nativeResolved) {
        return this.originalOpenLinkText!(linktext, sourcePath, newLeaf, openViewState);
      }

      const resolver = this.diagnosticEngine.getResolver();
      const resolved = resolver.resolve(linktext);
      if (resolved.length > 0) {
        const targetFile = this.app.vault.getAbstractFileByPath(resolved[0].filePath);
        if (targetFile instanceof TFile) {
          const leaf = this.app.workspace.getLeaf(newLeaf ?? false);
          await leaf.openFile(targetFile, openViewState);
          return;
        }
      }

      return this.originalOpenLinkText!(linktext, sourcePath, newLeaf, openViewState);
    };
  }

  private restoreLinkNavigation(): void {
    if (this.originalOpenLinkText) {
      this.app.workspace.openLinkText = this.originalOpenLinkText;
      this.originalOpenLinkText = null;
    }
  }

  async ensureTemplates(): Promise<void> {
    const folder = this.settings.templateFolder || '_codex/templates';
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
    for (const [type, content] of Object.entries(DEFAULT_TEMPLATES)) {
      const path = `${folder}/${type}.md`;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        await this.app.vault.create(path, content);
      }
    }
  }

  async resetTemplates(): Promise<void> {
    const folder = this.settings.templateFolder || '_codex/templates';
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
    let count = 0;
    for (const [type, content] of Object.entries(DEFAULT_TEMPLATES)) {
      const path = `${folder}/${type}.md`;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(path, content);
      }
      count++;
    }
    new Notice(`Codex: Reset ${count} entity templates to defaults`);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.provider = null;
    this.contextAssembler = new ContextAssembler(this.registry, {
      recentSessionCount: this.settings.aiRecentSessions,
      linkExpansionDepth: this.settings.aiLinkDepth,
      includeWorldEntities: this.settings.aiIncludeWorld,
    });
  }

  getProvider(): LLMProvider | null {
    if (this.provider) return this.provider;

    const config = getProviderConfig(this.settings);
    const needsKey = ['gemini', 'openai', 'anthropic'].includes(config.type);
    if (needsKey && !config.apiKey) return null;

    try {
      this.provider = createProvider(config);
      return this.provider;
    } catch {
      return null;
    }
  }

  async activateChatPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async activateWarningsPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(WARNINGS_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: WARNINGS_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  refreshWarningsView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WARNINGS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof WarningsView) {
        view.refresh();
      }
    }
  }

  refreshEditorDiagnostics(): void {
    this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
      const cm = (leaf.view as unknown as ObsidianEditorInternal)?.editor?.cm;
      if (cm?.dispatch) {
        cm.dispatch({ effects: [refreshDiagnostics.of(null)] });
      }
    });
  }

  async generatePluralAliases(): Promise<void> {
    const entities = this.registry.getAllEntities();
    let updatedCount = 0;

    for (const entity of entities) {
      const file = this.app.vault.getAbstractFileByPath(entity.filePath);
      if (!(file instanceof TFile)) continue;

      const variants = pluralVariants(entity.name);
      const existingAliases = new Set(entity.aliases.map(a => a.toLowerCase()));
      existingAliases.add(entity.name.toLowerCase());

      const newAliases = variants.filter(v =>
        !existingAliases.has(v.toLowerCase())
      );

      if (newAliases.length === 0) continue;

      const allAliases = [...entity.aliases, ...newAliases];

      await this.app.vault.process(file, (content) => {
        const aliasYaml = `aliases:\n${allAliases.map(a => `  - "${a}"`).join('\n')}`;

        if (/^aliases:/m.test(content)) {
          return content.replace(
            /^aliases:.*(?:\n\s+-.*)*$/m,
            aliasYaml,
          );
        }

        return content.replace(
          /^(---\n)/,
          `$1${aliasYaml}\n`,
        );
      });

      updatedCount++;
    }

    if (updatedCount > 0) {
      this.registry.clear();
      await this.vaultAdapter.fullIndex();
      this.refreshWarningsView();
    }

    new Notice(`Codex: Added plural aliases to ${updatedCount} entit${updatedCount !== 1 ? 'ies' : 'y'}`);
  }
}
