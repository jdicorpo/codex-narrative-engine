import {
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  TFile,
} from 'obsidian';
import type CodexPlugin from '../main';
import type { Entity, EntityType } from '@codex-ide/core';

interface EditorSuggestInstance {
  onTrigger: ((...args: unknown[]) => unknown) | null;
  selectSuggestion: ((...args: unknown[]) => void) | null;
  constructor?: { name?: string };
}

interface WorkspaceWithSuggest {
  editorSuggest?: {
    suggests?: EditorSuggestInstance[];
  };
}

const TYPE_ICONS: Record<string, string> = {
  npc: '👤',
  creature: '🐉',
  location: '🏰',
  faction: '⚔️',
  item: '🗡️',
  session: '📜',
  quest: '❗',
  adventure: '🗺️',
  event: '⚡',
  world: '🌍',
  rules: '📏',
  handout: '📨',
  custom: '📄',
};

interface SuggestItem {
  entity: Entity | null;
  file: TFile | null;
  display: string;
}

export class EntitySuggest extends EditorSuggest<SuggestItem> {
  private plugin: CodexPlugin;
  private savedMethods: {
    suggest: EditorSuggestInstance;
    onTrigger: EditorSuggestInstance['onTrigger'];
    selectSuggestion: EditorSuggestInstance['selectSuggestion'];
  } | null = null;

  constructor(plugin: CodexPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.disableBuiltInSuggest();
  }

  /**
   * Disable Obsidian's built-in link suggest so Codex can take over [[.
   * Suppresses both onTrigger (prevent popup) and selectSuggestion (prevent
   * the internal DOM render that conflicts with our popup lifecycle).
   */
  private disableBuiltInSuggest(): void {
    try {
      const ws = this.plugin.app.workspace as unknown as WorkspaceWithSuggest;
      const editorSuggest = ws.editorSuggest;
      if (editorSuggest?.suggests) {
        for (const suggest of editorSuggest.suggests) {
          if (suggest !== this && suggest.constructor?.name !== 'EntitySuggest') {
            if (!this.savedMethods) {
              this.savedMethods = {
                suggest,
                onTrigger: suggest.onTrigger?.bind(suggest),
                selectSuggestion: suggest.selectSuggestion?.bind(suggest),
              };
              suggest.onTrigger = () => null;
              suggest.selectSuggestion = () => {};
              console.debug('Codex: Disabled built-in link suggest, Codex suggest active');
            }
          }
        }
      }
    } catch {
      console.debug('Codex: Could not disable built-in suggest, running alongside it');
    }
  }

  restoreBuiltInSuggest(): void {
    try {
      if (this.savedMethods) {
        const { suggest, onTrigger, selectSuggestion } = this.savedMethods;
        if (onTrigger) suggest.onTrigger = onTrigger;
        if (selectSuggestion) suggest.selectSuggestion = selectSuggestion;
        this.savedMethods = null;
        console.debug('Codex: Restored built-in link suggest');
      }
    } catch {
      // Best effort
    }
  }

  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    _file: TFile | null,
  ): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const sub = line.substring(0, cursor.ch);

    const openBracket = sub.lastIndexOf('[[');
    if (openBracket === -1) return null;

    const afterOpen = sub.substring(openBracket + 2);
    if (afterOpen.includes(']]')) return null;

    return {
      start: { line: cursor.line, ch: openBracket + 2 },
      end: cursor,
      query: afterOpen,
    };
  }

  getSuggestions(context: EditorSuggestContext): SuggestItem[] {
    const query = context.query;
    const items: SuggestItem[] = [];

    // Type filtering: [[npc:Greg or [[location:Iron
    const colonIndex = query.indexOf(':');
    if (colonIndex !== -1) {
      const typePrefix = query.substring(0, colonIndex).trim().toLowerCase();
      const nameQuery = query.substring(colonIndex + 1).trim();
      const entities = this.plugin.registry.suggest(nameQuery, typePrefix as EntityType);
      for (const e of entities) {
        const basename = e.filePath.replace(/\.md$/i, '').split('/').pop() ?? e.name;
        items.push({ entity: e, file: null, display: basename });
      }
      return items;
    }

    // Entity results first
    const entities = this.plugin.registry.suggest(query);
    const entityPaths = new Set<string>();
    for (const e of entities) {
      const basename = e.filePath.replace(/\.md$/i, '').split('/').pop() ?? e.name;
      items.push({ entity: e, file: null, display: basename });
      entityPaths.add(e.filePath);
    }

    // Then vault files that aren't already shown as entities (fallback for non-entity files)
    const lower = query.toLowerCase();
    if (lower.length > 0) {
      const files = this.plugin.app.vault.getMarkdownFiles();
      for (const f of files) {
        if (entityPaths.has(f.path)) continue;
        const basename = f.basename.toLowerCase();
        if (basename.includes(lower)) {
          items.push({ entity: null, file: f, display: f.basename });
        }
        if (items.length >= 50) break;
      }
    }

    return items.slice(0, 50);
  }

  renderSuggestion(item: SuggestItem, el: HTMLElement): void {
    const container = el.createDiv({ cls: 'codex-suggest-item' });

    if (item.entity) {
      const entity = item.entity;
      const icon = container.createSpan({ cls: 'codex-suggest-type' });
      icon.textContent = TYPE_ICONS[entity.type] ?? '📄';

      const title = entity.frontmatter.title;
      if (typeof title === 'string') {
        container.createSpan({ text: `${title} `, cls: 'codex-suggest-title' });
      }
      container.createSpan({ text: entity.name });

      if (entity.aliases.length > 0) {
        const aliasEl = container.createSpan({ cls: 'codex-suggest-alias' });
        aliasEl.textContent = `(${entity.aliases.join(', ')})`;
      }

      const status = entity.frontmatter.status;
      if (typeof status === 'string') {
        const statusEl = container.createSpan({ cls: 'codex-suggest-status' });
        statusEl.textContent = status;
      }
    } else if (item.file) {
      const icon = container.createSpan({ cls: 'codex-suggest-type' });
      icon.textContent = '📝';
      container.createSpan({ text: item.display });
      const pathEl = container.createSpan({ cls: 'codex-suggest-status' });
      pathEl.textContent = item.file.parent?.path ?? '';
    }
  }

  selectSuggestion(item: SuggestItem, _evt: MouseEvent | KeyboardEvent): void {
    if (!this.context) return;

    const editor = this.context.editor;
    const start = { ...this.context.start };
    const end = { ...this.context.end };

    const line = editor.getLine(end.line);
    const afterCursor = line.substring(end.ch);
    if (afterCursor.startsWith(']]')) {
      end.ch += 2;
    }

    const replacement = `${item.display}]]`;
    this.close();
    requestAnimationFrame(() => {
      editor.replaceRange(replacement, start, end);
    });
  }
}
