import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, TFile } from 'obsidian';
import type CodexPlugin from '../main';
import type { ChatMessage } from '@codex-ide/core';
import { buildSystemPrompt } from '@codex-ide/core';
import { extractMarkdown, extractNameFromContent, extractTypeFromContent, hasFrontmatter, ENTITY_FOLDER_MAP } from '../util/ai-helpers';
import { proposeEdit } from './diff-review-modal';

export const CHAT_VIEW_TYPE = 'codex-lore-chat';

interface StoredChat {
  messages: ChatMessage[];
  timestamp: number;
}

export class LoreChatView extends ItemView {
  private plugin: CodexPlugin;
  private messages: ChatMessage[] = [];
  private inputEl!: HTMLTextAreaElement;
  private messagesEl!: HTMLElement;
  private sendBtn!: HTMLButtonElement;
  private isGenerating = false;

  constructor(leaf: WorkspaceLeaf, plugin: CodexPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Lore chat';
  }

  getIcon(): string {
    return 'message-square';
  }

  async onOpen(): Promise<void> {
    await this.loadHistory();
    this.buildUI();
    this.renderMessages();
  }

  async onClose(): Promise<void> {
    await this.saveHistory();
    this.contentEl.empty();
  }

  private buildUI(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass('codex-chat-panel');

    const header = container.createDiv({ cls: 'codex-chat-header' });
    header.createSpan({ text: 'Lore Chat', cls: 'codex-chat-title' });

    const headerActions = header.createDiv({ cls: 'codex-chat-header-actions' });

    const clearBtn = headerActions.createEl('button', {
      cls: 'codex-chat-clear-btn',
      attr: { 'aria-label': 'Clear chat' },
    });
    clearBtn.setText('Clear');
    clearBtn.addEventListener('click', () => {
      this.messages = [];
      this.renderMessages();
      void this.saveHistory();
    });

    this.messagesEl = container.createDiv({ cls: 'codex-chat-messages' });

    const inputArea = container.createDiv({ cls: 'codex-chat-input-area' });

    this.inputEl = inputArea.createEl('textarea', {
      cls: 'codex-chat-input',
      attr: {
        placeholder: 'Ask about your world...',
        rows: '3',
      },
    });

    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.handleSend();
      }
    });

    const inputFooter = inputArea.createDiv({ cls: 'codex-chat-input-footer' });

    const contextHint = inputFooter.createSpan({ cls: 'codex-chat-context-hint' });
    const entityCount = this.plugin.registry.size;
    contextHint.setText(`${entityCount} entities indexed`);

    this.sendBtn = inputFooter.createEl('button', {
      cls: 'codex-chat-send-btn',
      text: 'Send',
    });
    this.sendBtn.addEventListener('click', () => { void this.handleSend(); });
  }

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.isGenerating) return;

    const provider = this.plugin.getProvider();
    if (!provider) {
      new Notice('Codex: configure an AI provider in settings first.');
      return;
    }

    this.messages.push({ role: 'user', content: text });
    this.inputEl.value = '';
    this.renderMessages();
    this.scrollToBottom();

    this.isGenerating = true;
    this.sendBtn.disabled = true;
    this.sendBtn.setText('...');

    const thinkingEl = this.messagesEl.createDiv({ cls: 'codex-chat-message codex-chat-assistant' });
    thinkingEl.createDiv({ cls: 'codex-chat-thinking', text: 'Thinking...' });
    this.scrollToBottom();

    try {
      console.debug('Codex Chat: assembling context...');
      const context = this.plugin.contextAssembler.assemble(text);
      console.debug(`Codex Chat: context has ${context.entities.length} entities`);

      const systemPrompt = buildSystemPrompt(context, {
        ruleSystem: this.plugin.settings.aiRuleSystem,
        campaignTone: this.plugin.settings.aiCampaignTone,
      });
      console.debug(`Codex Chat: system prompt is ${systemPrompt.length} chars`);

      const msgs = this.messages.filter(m => m.role !== 'system');
      console.debug(`Codex Chat: sending ${msgs.length} messages to provider...`);

      const response = await provider.chat({
        systemPrompt,
        messages: msgs,
        context,
        temperature: this.plugin.settings.aiTemperature,
      });

      console.debug(`Codex Chat: got response (${response.content.length} chars)`);
      thinkingEl.remove();

      this.messages.push({ role: 'assistant', content: response.content });
      this.renderMessages();
      this.scrollToBottom();
      await this.saveHistory();
    } catch (err: unknown) {
      console.error('Codex Chat: error', err);
      thinkingEl.remove();
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      new Notice(`Codex AI error: ${errMsg}`);

      this.messages.push({
        role: 'assistant',
        content: `*Error: ${errMsg}*`,
      });
      this.renderMessages();
    } finally {
      this.isGenerating = false;
      this.sendBtn.disabled = false;
      this.sendBtn.setText('Send');
    }
  }

  private renderMessages(): void {
    this.messagesEl.empty();

    if (this.messages.length === 0) {
      const empty = this.messagesEl.createDiv({ cls: 'codex-chat-empty' });
      empty.createEl('div', { text: '🎲', cls: 'codex-chat-empty-icon' });
      empty.createEl('p', { text: 'Ask anything about your world.' });
      empty.createEl('p', {
        text: 'Your vault\'s entities, sessions, and lore are used as context.',
        cls: 'codex-chat-empty-hint',
      });

      const examples = empty.createDiv({ cls: 'codex-chat-examples' });
      const exampleQueries = [
        'What does my party know about the cult?',
        'Generate a shopkeeper NPC for the market district',
        'Summarize last session\'s key events',
        'What plot hooks are still unresolved?',
      ];
      for (const q of exampleQueries) {
        const ex = examples.createDiv({ cls: 'codex-chat-example', text: q });
        ex.addEventListener('click', () => {
          this.inputEl.value = q;
          this.inputEl.focus();
        });
      }
      return;
    }

    for (const msg of this.messages) {
      if (msg.role === 'system') continue;

      const msgEl = this.messagesEl.createDiv({
        cls: `codex-chat-message codex-chat-${msg.role}`,
      });

      const roleLabel = msg.role === 'user' ? 'You' : 'Codex';
      msgEl.createDiv({ cls: 'codex-chat-role', text: roleLabel });

      const contentEl = msgEl.createDiv({ cls: 'codex-chat-content' });

      if (msg.role === 'assistant') {
        void MarkdownRenderer.render(
          this.app,
          msg.content,
          contentEl,
          '',
          this,
        );
        this.addActionBar(msgEl, msg.content);
      } else {
        contentEl.setText(msg.content);
      }
    }
  }

  private addActionBar(msgEl: HTMLElement, rawContent: string): void {
    const md = extractMarkdown(rawContent);
    const hasNote = hasFrontmatter(md);
    const activeFile = this.app.workspace.getActiveFile();

    const bar = msgEl.createDiv({ cls: 'codex-chat-actions' });

    if (hasNote) {
      const name = extractNameFromContent(md);
      const saveBtn = bar.createEl('button', {
        cls: 'codex-chat-action-btn',
        text: name ? `Save "${name}"` : 'Save as Note',
        attr: { 'aria-label': 'Create a new note from this response' },
      });
      saveBtn.addEventListener('click', () => { void this.handleSaveAsNote(md); });
    }

    if (hasNote && activeFile) {
      const applyBtn = bar.createEl('button', {
        cls: 'codex-chat-action-btn',
        text: `Apply to ${activeFile.basename}`,
        attr: { 'aria-label': 'Apply changes to the currently open note' },
      });
      applyBtn.addEventListener('click', () => { void this.handleApplyToNote(md, activeFile); });
    }

    const copyBtn = bar.createEl('button', {
      cls: 'codex-chat-action-btn codex-chat-action-copy',
      text: 'Copy',
      attr: { 'aria-label': 'Copy response to clipboard' },
    });
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(rawContent).then(() => {
        copyBtn.setText('Copied!');
        setTimeout(() => copyBtn.setText('Copy'), 1500);
      });
    });
  }

  private async handleSaveAsNote(content: string): Promise<void> {
    const name = extractNameFromContent(content) ?? `New Note`;
    const safeName = name.replace(/[\\/:*?"<>|]/g, '');
    const type = extractTypeFromContent(content);
    const folder = (type && ENTITY_FOLDER_MAP[type]) || '';

    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }

    let filePath = folder ? `${folder}/${safeName}.md` : `${safeName}.md`;
    if (this.app.vault.getAbstractFileByPath(filePath)) {
      filePath = folder
        ? `${folder}/${safeName} ${Date.now()}.md`
        : `${safeName} ${Date.now()}.md`;
    }

    const newFile = await this.app.vault.create(filePath, content);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(newFile);
    new Notice(`Codex: Created ${safeName}`);

    this.plugin.registry.clear();
    await this.plugin.vaultAdapter.fullIndex();
    this.plugin.refreshWarningsView();
  }

  private async handleApplyToNote(content: string, file: TFile): Promise<void> {
    const accepted = await proposeEdit(this.plugin, file, content, 'Lore Chat');
    if (accepted) {
      this.plugin.registry.clear();
      await this.plugin.vaultAdapter.fullIndex();
      this.plugin.refreshWarningsView();
    }
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async loadHistory(): Promise<void> {
    try {
      const data = await this.plugin.loadData();
      const chat: StoredChat | undefined = data?.chatHistory;
      if (chat?.messages) {
        this.messages = chat.messages;
      }
    } catch {
      this.messages = [];
    }
  }

  private async saveHistory(): Promise<void> {
    const data = (await this.plugin.loadData()) ?? {};
    data.chatHistory = {
      messages: this.messages.slice(-50),
      timestamp: Date.now(),
    } satisfies StoredChat;
    await this.plugin.saveData(data);
  }
}
