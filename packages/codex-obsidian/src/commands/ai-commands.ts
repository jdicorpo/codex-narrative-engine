import { Notice, TFile, Modal, Setting } from 'obsidian';
import { buildSystemPrompt } from '@codex-ide/core';
import type { EntityType } from '@codex-ide/core';
import type CodexPlugin from '../main';
import { applySuggestedEdit } from '../ui/suggestion-decorations';
import { extractMarkdown, extractNameFromContent, ENTITY_FOLDER_MAP } from '../util/ai-helpers';

// ---------------------------------------------------------------------------
// Default entity templates — written to _codex/templates/ on first run and
// used as fallbacks when a vault template file is missing.
// ---------------------------------------------------------------------------

export const DEFAULT_TEMPLATES: Record<string, string> = {
  npc: `Frontmatter: type, name, status, location, faction, cr, tags

Sections:
- Description (physical appearance, distinguishing features, mannerisms)
- Personality (traits, ideals, bonds, flaws)
- Stat Block (if combat-relevant)
- Background (history, how they got where they are)
- Secrets (things the players don't know yet)
- Relationships (connections to other NPCs, factions, locations)
- Plot Hooks (ways the party might interact with this NPC)
`,

  creature: `Frontmatter: type, name, cr, tags

Sections:
- Description (appearance, sensory details, behavior)
- Stat Block (full combat statistics)
- Tactics (how it fights, preferred strategies, retreat conditions)
- Lore (origin, ecology, cultural significance)
- Habitat (where it lives, environmental details)
- Encounter Ideas (interesting ways to use this creature in play)
`,

  location: `Frontmatter: type, name, region, tags

Sections:
- Description (read-aloud box text for when players arrive)
- Key Features / Rooms (numbered or keyed areas with details)
- Creatures Present (inhabitants, wandering monsters)
- Treasure (loot, hidden caches, quest items)
- Secrets (hidden rooms, lore, traps)
- Plot Hooks (reasons to visit, quests connected to this place)
`,

  faction: `Frontmatter: type, name, leader, alignment, status, headquarters, tags

Sections:
- Overview (purpose, public face, reputation)
- Goals (short-term and long-term objectives)
- Resources (military strength, wealth, influence, assets)
- Key Members (named NPCs with roles and brief descriptions)
- Rivals & Enemies (opposing factions or individuals)
- Plot Hooks (ways the party might interact, join, or oppose)
`,

  item: `Frontmatter: type, name, rarity, attunement, tags

Sections:
- Description (physical appearance, sensory details, weight)
- History (origin, creator, previous owners, notable events)
- Properties / Mechanics (game statistics, abilities, charges)
- Quirks (minor personality, cosmetic effects, sentience hints)
`,

  quest: `Frontmatter: type, name, status, quest_giver, location, reward, tags

Sections:
- Overview (hook and premise in 2-3 sentences)
- Objectives (numbered steps or goals the party must complete)
- Key NPCs (quest giver, allies, antagonists with brief descriptions)
- Locations (where the quest takes place, with brief area notes)
- Complications (twists, moral dilemmas, unexpected obstacles)
- Rewards (treasure, reputation, story consequences)
`,

  adventure: `Frontmatter: type, name, level_range, status, tags

Sections:
- Synopsis (overview of the adventure arc)
- Background (what happened before the adventure starts)
- Adventure Hook (how the party gets involved)
- Key NPCs (major characters with roles)
- Locations (settings and areas involved)
- Encounters (key encounters, both combat and social)
- Conclusion (possible endings and consequences)
`,

  session: `Frontmatter: type, name, date, session_number, tags

Sections:
- Summary (what happened this session in 2-3 paragraphs)
- Key Events (bullet list of major plot beats)
- NPCs Present (who appeared and what they did)
- Outcomes & Decisions (important choices the party made)
- Open Threads (unresolved plots, cliffhangers, follow-ups)
- Loot & Rewards (items or experience gained)
`,

  event: `Frontmatter: type, name, date, location, tags

Sections:
- Overview (what happened and why it matters)
- Key Participants (who was involved)
- Consequences (immediate and long-term effects on the world)
- Related Entities (NPCs, factions, locations affected)
- Rumors & Perspectives (how different groups view this event)
`,
};

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

async function loadTemplate(plugin: CodexPlugin, type: string): Promise<string> {
  const folder = plugin.settings.templateFolder || '_codex/templates';
  const path = `${folder}/${type}.md`;
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
    try {
      const content = await plugin.app.vault.read(file);
      if (content.trim()) return content.trim();
    } catch { /* fall through to default */ }
  }
  return DEFAULT_TEMPLATES[type] ?? `Include appropriate frontmatter with type: ${type} and relevant fields.`;
}

/**
 * Load a template and extract just the section names for the revise & complete prompt.
 */
async function loadSectionGuide(plugin: CodexPlugin, type: string): Promise<string> {
  const template = await loadTemplate(plugin, type);
  const sectionNames: string[] = [];
  for (const line of template.split('\n')) {
    const match = line.match(/^-\s+(.+?)(?:\s*\(.*\))?$/);
    if (match) sectionNames.push(match[1].trim());
  }
  if (sectionNames.length > 0) return sectionNames.join(', ');
  return 'appropriate sections for the entity type';
}

export function registerAICommands(plugin: CodexPlugin): void {
  plugin.addCommand({
    id: 'ai-enhance-note',
    name: 'AI: enhance note',
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (checking) return true;
      void enhanceNote(plugin, file);
    },
  });

  plugin.addCommand({
    id: 'ai-generate-entity',
    name: 'AI: generate entity',
    callback: () => generateEntity(plugin),
  });

  plugin.addCommand({
    id: 'ai-describe-scene',
    name: 'AI: describe scene (read-aloud)',
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (checking) return true;
      void describeScene(plugin, file);
    },
  });

  plugin.addCommand({
    id: 'ai-extract-entities',
    name: 'AI: extract entities from note',
    checkCallback: (checking) => {
      const file = plugin.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (checking) return true;
      void extractEntities(plugin, file);
    },
  });
}

// ---------------------------------------------------------------------------
// Enhance Note — reconcile, reorganize, reformat, and complete in one pass
// ---------------------------------------------------------------------------

export async function enhanceNote(plugin: CodexPlugin, file: TFile): Promise<void> {
  const provider = requireProvider(plugin);
  if (!provider) return;

  const content = await plugin.app.vault.read(file);
  const hideSpinner = showSpinner('Enhancing note…');

  const entity = plugin.registry.getByPath(file.path);
  const typeHint = entity ? entity.type : 'unknown';

  const context = plugin.contextAssembler.assemble(content);
  const systemPrompt = buildSystemPrompt(context, {
    ruleSystem: plugin.settings.aiRuleSystem,
    campaignTone: plugin.settings.aiCampaignTone,
  });

  const useFantasyStatblocks = plugin.settings.aiStatblockFormat === 'fantasy-statblocks';

  const statblockRule = useFantasyStatblocks
    ? `- If a \`\`\`statblock code block exists, keep it but update values (hp, ac, cr, stats, traits, actions, etc.) if they contradict the surrounding prose. If no statblock exists and this is a creature or combat-relevant NPC, generate one in Fantasy Statblocks YAML format.`
    : '- If markdown stat block tables exist, keep them but fix inconsistencies with the prose. If none exist and this is a creature or combat-relevant NPC, generate one as a markdown table.';

  const sections = await loadSectionGuide(plugin, typeHint);

  const instruction = `Enhance this ${typeHint} note for my TTRPG campaign. Return the ENTIRE file — frontmatter, body, everything — as a single complete markdown document.

Goals (in priority order):
1. **Fix frontmatter** — ensure valid YAML with correct type, name, and all standard fields for a ${typeHint}. Add any missing fields (status, location, faction, cr, tags, etc.). Keep existing values unless they contradict the body content.
2. **Reconcile** — find contradictions between frontmatter, stat block, and prose. Resolve them in favor of the most specific or most recent information. If ambiguous, pick the version most consistent with the campaign context provided.
3. **Reorganize** — reorder sections into a logical structure for a ${typeHint}: ${sections}. Merge duplicate sections. Use ## for major sections, ### for subsections.
4. **Reformat** — fix broken markdown, standardize heading hierarchy, fix broken tables, clean up whitespace, convert plain-text entity names to [[wiki-links]] where they reference known vault entities.
5. **Complete** — fill in missing sections appropriate for a ${typeHint}. Generate plausible content consistent with existing lore.

YAML frontmatter rules:
- Keep the existing type and name fields exactly as they are
- Always quote string values that contain [[wiki-links]]: location: "[[Place Name]]"
- Always quote the name field: name: "Entity Name"
- Do NOT use YAML anchors (&) or aliases (*)
- Do NOT add "links_to" or "links" fields
- tags should be a YAML list: tags: [tag1, tag2]

${statblockRule}

Do NOT:
- Remove any lore, even minor details — relocate it to the right section instead
- Change the entity's name or type
- Invent major plot-altering facts (new betrayals, deaths, etc.) — only fill in descriptive and mechanical gaps
- NEVER put HTML comments (<!-- ... -->) inside \`\`\`statblock code blocks — YAML does not support them and it breaks the Fantasy Statblocks plugin

Return ONLY the complete file content — no explanations before or after.

Current file (${file.path}):

${content}`;

  try {
    const response = await provider.chat({
      systemPrompt,
      messages: [{ role: 'user', content: instruction }],
      temperature: 0.4,
      maxTokens: 16384,
    });
    hideSpinner();

    const newContent = extractMarkdown(response.content);
    if (!newContent || newContent.trim().length < 20) {
      new Notice('Codex: enhancement produced empty or invalid output.');
      return;
    }

    await applySuggestedEdit(plugin, file, newContent, 'Enhance Note');
  } catch (err: unknown) {
    hideSpinner();
    new Notice(`Codex: error — ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

// ---------------------------------------------------------------------------
// Revise Selection — rewrite selected text based on a user prompt
// ---------------------------------------------------------------------------

export function reviseSelection(plugin: CodexPlugin, file: TFile, selectedText: string, selFrom: number, selTo: number): void {
  new ReviseSelectionModal(plugin, file, selectedText, selFrom, selTo).open();
}

class ReviseSelectionModal extends Modal {
  private plugin: CodexPlugin;
  private file: TFile;
  private selectedText: string;
  private selFrom: number;
  private selTo: number;
  private prompt = '';

  constructor(plugin: CodexPlugin, file: TFile, selectedText: string, selFrom: number, selTo: number) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
    this.selectedText = selectedText;
    this.selFrom = selFrom;
    this.selTo = selTo;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Revise selection' });

    const preview = this.selectedText.length > 120
      ? this.selectedText.slice(0, 120) + '…'
      : this.selectedText;
    contentEl.createEl('p', {
      text: preview,
      cls: 'codex-revise-preview',
    });

    new Setting(contentEl)
      .setName('Instruction')
      .setDesc('Tell the AI how to revise this text.')
      .addTextArea(text => {
        text
          .setPlaceholder('"make it more dramatic", "add sensory details", "rewrite as bullet points"')
          .onChange(value => { this.prompt = value; });
        text.inputEl.rows = 3;
        text.inputEl.addClass('codex-modal-textarea');
        setTimeout(() => text.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText('Revise')
          .setCta()
          .onClick(() => {
            if (!this.prompt.trim()) {
              new Notice('Enter an instruction for the AI.');
              return;
            }
            this.close();
            void this.doRevise();
          }),
      )
      .addButton(btn =>
        btn
          .setButtonText('Cancel')
          .onClick(() => this.close()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async doRevise(): Promise<void> {
    const provider = this.plugin.getProvider();
    if (!provider) {
      new Notice('Codex: configure an AI provider in settings first.');
      return;
    }

    const hideSpinner = showSpinner('Revising selection…');

    const context = this.plugin.contextAssembler.assemble(this.selectedText);
    const systemPrompt = buildSystemPrompt(context, {
      ruleSystem: this.plugin.settings.aiRuleSystem,
      campaignTone: this.plugin.settings.aiCampaignTone,
    });

    try {
      const response = await provider.chat({
        systemPrompt,
        messages: [{
          role: 'user',
          content: `Revise the following text from a TTRPG note according to my instruction.

Instruction: ${this.prompt}

Rules:
- Return ONLY the revised text — no explanations, no markdown fences wrapping the whole response
- Keep the same general format (markdown headings, lists, etc.) unless the instruction says otherwise
- Preserve [[wiki-links]] and do not break them
- Do not add frontmatter
- Match the existing writing style and campaign tone

Text to revise:
${this.selectedText}`,
        }],
        temperature: 0.6,
      });
      hideSpinner();

      let revised = response.content.trim();
      const outerFence = revised.match(/^```\w*\s*\n/);
      if (outerFence) {
        const lastFence = revised.lastIndexOf('```');
        if (lastFence > outerFence[0].length) {
          revised = revised.slice(outerFence[0].length, lastFence).trim();
        }
      }

      if (!revised) {
        new Notice('Codex: revision produced empty output.');
        return;
      }

      const content = await this.plugin.app.vault.read(this.file);
      const newContent = content.slice(0, this.selFrom) + revised + content.slice(this.selTo);
      await applySuggestedEdit(this.plugin, this.file, newContent, 'Revise Selection');
    } catch (err: unknown) {
      hideSpinner();
      new Notice(`Codex: error — ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Generate Entity
// ---------------------------------------------------------------------------

interface GenerateEntityOptions {
  name?: string;
  guidance?: string;
  surroundingContext?: string;
  inferredType?: EntityType;
}

function generateEntity(plugin: CodexPlugin, opts?: GenerateEntityOptions): void {
  const provider = requireProvider(plugin);
  if (!provider) return;

  new GenerateEntityModal(plugin, opts).open();
}

export async function generateEntityFromContext(
  plugin: CodexPlugin,
  name: string,
  surroundingContext: string,
): Promise<void> {
  const provider = requireProvider(plugin);
  if (!provider) return;

  const typeList = plugin.getEntityTypes();

  // Quick heuristic: if the name itself starts with or contains a known type, use it directly
  const nameLower = name.toLowerCase();
  const nameMatch = typeList.find(t =>
    nameLower.startsWith(t + ' ') || nameLower.startsWith(t + ':') || nameLower.startsWith(t + '-'),
  );
  if (nameMatch) {
    new GenerateEntityModal(plugin, {
      name,
      surroundingContext,
      inferredType: nameMatch as EntityType,
    }).open();
    return;
  }

  const hideSpinner = showSpinner('Detecting entity type…');

  try {
    const response = await provider.chat({
      systemPrompt: `You classify TTRPG entities into exactly one type. Valid types: ${typeList.join(', ')}. Respond with ONLY the type word, nothing else.`,
      messages: [{
        role: 'user',
        content: `Entity name: "${name}"${surroundingContext ? `\nNearby text: ${surroundingContext.slice(0, 200)}` : ''}\n\nWhat type?`,
      }],
      temperature: 0.1,
      maxTokens: 10,
    });
    hideSpinner();

    const raw = response.content.trim().toLowerCase().replace(/[^a-z-]/g, '');
    const inferredType = typeList.includes(raw) ? raw as EntityType : 'npc';

    new GenerateEntityModal(plugin, {
      name,
      surroundingContext,
      inferredType,
    }).open();
  } catch (err) {
    hideSpinner();
    console.error('Codex: Entity type inference failed', err);
    new GenerateEntityModal(plugin, { name, surroundingContext }).open();
  }
}

class GenerateEntityModal extends Modal {
  private plugin: CodexPlugin;
  private type: EntityType = 'npc';
  private entityName: string;
  private guidance: string;
  private surroundingContext: string;

  constructor(plugin: CodexPlugin, opts?: GenerateEntityOptions) {
    super(plugin.app);
    this.plugin = plugin;
    this.entityName = opts?.name ?? '';
    this.guidance = opts?.guidance ?? '';
    this.surroundingContext = opts?.surroundingContext ?? '';
    if (opts?.inferredType) this.type = opts.inferredType;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Generate entity' });

    if (this.surroundingContext) {
      const preview = this.surroundingContext.length > 200
        ? this.surroundingContext.slice(0, 200) + '…'
        : this.surroundingContext;
      contentEl.createEl('p', { text: preview, cls: 'codex-revise-preview' });
    }

    new Setting(contentEl)
      .setName('Name')
      .addText(text =>
        text
          .setPlaceholder('Entity name (optional — AI will choose if blank)')
          .setValue(this.entityName)
          .onChange(value => { this.entityName = value; }),
      );

    new Setting(contentEl)
      .setName('Entity type')
      .addDropdown(dropdown => {
        for (const t of this.plugin.getEntityTypes()) {
          dropdown.addOption(t, t.charAt(0).toUpperCase() + t.slice(1));
        }
        dropdown.setValue(this.type);
        dropdown.onChange(value => { this.type = value as EntityType; });
      });

    new Setting(contentEl)
      .setName('Description / guidance')
      .setDesc('Optional hints for the AI')
      .addTextArea(text => {
        text
          .setPlaceholder('"a paranoid dwarf merchant", "a haunted swamp temple"')
          .setValue(this.guidance)
          .onChange(value => { this.guidance = value; });
        text.inputEl.rows = 3;
        text.inputEl.addClass('codex-modal-textarea');
      });

    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText('Generate')
          .setCta()
          .onClick(() => {
            this.close();
            void this.doGenerate();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async doGenerate(): Promise<void> {
    const provider = this.plugin.getProvider();
    if (!provider) return;

    const hideSpinner = showSpinner(`Generating ${this.type}…`);

    const context = this.plugin.contextAssembler.assemble(this.guidance || this.type);
    const systemPrompt = buildSystemPrompt(context, {
      ruleSystem: this.plugin.settings.aiRuleSystem,
      campaignTone: this.plugin.settings.aiCampaignTone,
    });

    const useFantasyStatblocks = this.plugin.settings.aiStatblockFormat === 'fantasy-statblocks';

    const statblockInstruction = useFantasyStatblocks
      ? `a stat block using the Fantasy Statblocks plugin format. It MUST be a fenced code block with language tag "statblock" containing valid YAML. Follow this example structure exactly:

\`\`\`statblock
name: Example Creature
size: Medium
type: humanoid
alignment: neutral evil
ac: 15 (chain shirt)
hp: 65 (10d8 + 20)
hit_dice: 10d8 + 20
speed: 30 ft.
stats: [16, 14, 14, 10, 12, 8]
saves:
  - str: 5
  - con: 4
skillsaves:
  - athletics: 5
  - perception: 3
senses: darkvision 60 ft., passive Perception 13
languages: Common, Orc
cr: 3
traits:
  - name: Aggressive
    desc: As a bonus action, the creature can move up to its speed toward a hostile creature it can see.
actions:
  - name: Multiattack
    desc: The creature makes two melee attacks.
  - name: Greatsword
    desc: "Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: 10 (2d6 + 3) slashing damage."
reactions:
  - name: Parry
    desc: The creature adds 2 to its AC against one melee attack that would hit it.
\`\`\`

Use the real stats for the generated creature — do NOT copy the example values.`
      : 'a properly formatted D&D 5e statblock with markdown tables.';

    let template = await loadTemplate(this.plugin, this.type);

    const wantsStatblock = ['creature', 'npc'].includes(this.type);
    if (wantsStatblock) {
      template += `\n\nFor the stat block, include ${statblockInstruction}`;
    }

    const guidanceParts: string[] = [];
    if (this.entityName) guidanceParts.push(`The entity's name is "${this.entityName}".`);
    if (this.guidance) guidanceParts.push(`User guidance: ${this.guidance}`);
    if (this.surroundingContext) {
      guidanceParts.push(`Context from the source note where this entity is mentioned:\n${this.surroundingContext}`);
    }
    const guidanceText = guidanceParts.length > 0 ? '\n\n' + guidanceParts.join('\n\n') : '';

    const fmRules = `
YAML frontmatter rules:
- Always quote string values that contain [[wiki-links]]: location: "[[Place Name]]"
- Always quote the name field: name: "Entity Name"
- Do NOT use YAML anchors (&) or aliases (*)
- Do NOT include a "links_to" or "links" field
- tags should be a YAML list: tags: [tag1, tag2]`;

    try {
      const response = await provider.chat({
        systemPrompt,
        messages: [{
          role: 'user',
          content: `Generate a complete ${this.type} note for my TTRPG campaign. ${template} Use [[wiki-links]] to reference existing entities where it makes sense.
${fmRules}
Return ONLY the complete markdown file content with frontmatter — no explanations.${guidanceText}`,
        }],
        temperature: 0.8,
      });

      const content = extractMarkdown(response.content);
      const name = extractNameFromContent(content) ?? `New ${this.type}`;
      const safeName = name.replace(/[\\/:*?"<>|]/g, '');

      const folder = ENTITY_FOLDER_MAP[this.type] ?? '';

      let filePath = folder ? `${folder}/${safeName}.md` : `${safeName}.md`;

      if (folder && !this.plugin.app.vault.getAbstractFileByPath(folder)) {
        await this.plugin.app.vault.createFolder(folder);
      }

      const existing = this.plugin.app.vault.getAbstractFileByPath(filePath);
      if (existing) {
        filePath = folder
          ? `${folder}/${safeName} ${Date.now()}.md`
          : `${safeName} ${Date.now()}.md`;
      }

      const newFile = await this.plugin.app.vault.create(filePath, content);
      const leaf = this.plugin.app.workspace.getLeaf(false);
      await leaf.openFile(newFile);
      hideSpinner();
      new Notice(`Codex: created ${safeName}`);
    } catch (err: unknown) {
      hideSpinner();
      new Notice(`Codex: error — ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Describe Scene (Read-Aloud)
// ---------------------------------------------------------------------------

export async function describeScene(plugin: CodexPlugin, file: TFile): Promise<void> {
  const provider = requireProvider(plugin);
  if (!provider) return;

  const content = await plugin.app.vault.read(file);
  const hideSpinner = showSpinner('Writing scene description…');

  const context = plugin.contextAssembler.assemble(content);
  const systemPrompt = buildSystemPrompt(context, {
    ruleSystem: plugin.settings.aiRuleSystem,
    campaignTone: plugin.settings.aiCampaignTone,
  });

  try {
    const response = await provider.chat({
      systemPrompt,
      messages: [{
        role: 'user',
        content: `Based on this location note, write a vivid read-aloud description that a DM can read to players when they first arrive. 2-3 paragraphs, evocative sensory details (sight, sound, smell), no game mechanics. Match the campaign tone.\n\nFile: ${file.path}\n\n${content}`,
      }],
      temperature: 0.8,
    });
    hideSpinner();

    const description = response.content.trim();
    const blockQuote = '\n\n> [!read-aloud] Scene Description\n' +
      description.split('\n').map(line => `> ${line}`).join('\n') +
      '\n';

    const updatedContent = content + blockQuote;
    await applySuggestedEdit(plugin, file, updatedContent, 'Describe Scene');
  } catch (err: unknown) {
    hideSpinner();
    new Notice(`Codex: error — ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

// ---------------------------------------------------------------------------
// Extract Entities from Note
// ---------------------------------------------------------------------------

interface ExtractedEntity {
  name: string;
  type: EntityType;
  description: string;
  alreadyExists: boolean;
}

export async function extractEntities(plugin: CodexPlugin, file: TFile): Promise<void> {
  const provider = requireProvider(plugin);
  if (!provider) return;

  const content = await plugin.app.vault.read(file);
  const hideSpinner = showSpinner('Scanning for entities…');

  const context = plugin.contextAssembler.assemble(content);
  const systemPrompt = buildSystemPrompt(context, {
    ruleSystem: plugin.settings.aiRuleSystem,
    campaignTone: plugin.settings.aiCampaignTone,
  });

  const typeList = plugin.getEntityTypes().join(', ');

  try {
    const response = await provider.chat({
      systemPrompt,
      messages: [{
        role: 'user',
        content: `Analyze this TTRPG note and extract the most important named entities (NPCs, creatures, locations, factions, items, quests, events, etc.).

For each entity, return a JSON array with objects like:
{"name": "Entity Name", "type": "npc", "description": "Brief one-line description"}

Valid types: ${typeList}

Rules:
- Only include entities that are specifically named (not generic things like "the guards")
- Focus on the most significant entities (max 30)
- Detect the most appropriate type from context clues
- Keep descriptions to ONE short sentence
- Do NOT use markdown fences — return raw JSON only

File: ${file.path}

${content}`,
      }],
      temperature: 0.2,
      maxTokens: 8192,
    });
    hideSpinner();

    let entities: ExtractedEntity[];
    try {
      const cleaned = response.content.replace(/```(?:json)?\s*\n?/g, '').replace(/```/g, '').trim();
      entities = parseEntityJSON(cleaned);
    } catch {
      new Notice('Codex: failed to parse entity list from AI response.');
      console.error('Codex: Extract entities parse error', response.content);
      return;
    }

    for (const entity of entities) {
      const existing = plugin.registry.getByName(entity.name);
      entity.alreadyExists = existing.length > 0;
    }

    if (entities.length === 0) {
      new Notice('Codex: no named entities found in this note.');
      return;
    }

    new ExtractedEntitiesModal(plugin, file, entities).open();
  } catch (err: unknown) {
    hideSpinner();
    new Notice(`Codex: error — ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

class ExtractedEntitiesModal extends Modal {
  private plugin: CodexPlugin;
  private sourceFile: TFile;
  private entities: ExtractedEntity[];
  private selected: Set<number>;

  constructor(plugin: CodexPlugin, sourceFile: TFile, entities: ExtractedEntity[]) {
    super(plugin.app);
    this.plugin = plugin;
    this.sourceFile = sourceFile;
    this.entities = entities;
    this.selected = new Set(
      entities.map((e, i) => (e.alreadyExists ? -1 : i)).filter(i => i >= 0),
    );
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('codex-extract-modal');

    contentEl.createEl('h3', {
      text: `Found ${this.entities.length} entities in ${this.sourceFile.basename}`,
    });

    const existingCount = this.entities.filter(e => e.alreadyExists).length;
    const newCount = this.entities.length - existingCount;
    contentEl.createEl('p', {
      text: `${newCount} new, ${existingCount} already in vault. Select which to create:`,
      cls: 'codex-extract-summary',
    });

    const listEl = contentEl.createDiv({ cls: 'codex-extract-list' });

    this.entities.forEach((entity, idx) => {
      const row = listEl.createDiv({ cls: 'codex-extract-row' });

      const checkbox = row.createEl('input', { type: 'checkbox' });
      checkbox.checked = this.selected.has(idx);
      checkbox.disabled = entity.alreadyExists;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selected.add(idx);
        else this.selected.delete(idx);
      });

      const info = row.createDiv({ cls: 'codex-extract-info' });
      const nameRow = info.createDiv({ cls: 'codex-extract-name' });
      nameRow.createSpan({ text: entity.name, cls: 'codex-extract-entity-name' });
      nameRow.createSpan({
        text: entity.type,
        cls: 'codex-extract-type-badge',
      });
      if (entity.alreadyExists) {
        nameRow.createSpan({ text: '(exists)', cls: 'codex-extract-exists' });
      }

      if (entity.description) {
        info.createDiv({ text: entity.description, cls: 'codex-extract-desc' });
      }
    });

    const actions = contentEl.createDiv({ cls: 'codex-extract-actions' });

    const selectAllBtn = actions.createEl('button', { text: 'Select all new' });
    selectAllBtn.addEventListener('click', () => {
      this.entities.forEach((e, i) => {
        if (!e.alreadyExists) this.selected.add(i);
      });
      this.onOpen();
    });

    const createBtn = actions.createEl('button', {
      text: `Create ${this.selected.size} files`,
      cls: 'mod-cta',
    });
    createBtn.addEventListener('click', () => {
      this.close();
      void this.createSelected();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async createSelected(): Promise<void> {
    const toCreate = this.entities.filter((_, i) => this.selected.has(i));
    if (toCreate.length === 0) return;

    let created = 0;
    const createdNames: string[] = [];
    for (const entity of toCreate) {
      const folder = ENTITY_FOLDER_MAP[entity.type] ?? '';
      const safeName = entity.name.replace(/[\\/:*?"<>|]/g, '');

      if (folder && !this.plugin.app.vault.getAbstractFileByPath(folder)) {
        await this.plugin.app.vault.createFolder(folder);
      }

      const filePath = folder ? `${folder}/${safeName}.md` : `${safeName}.md`;
      if (this.plugin.app.vault.getAbstractFileByPath(filePath)) continue;

      const frontmatter = buildEntityFrontmatter(entity);
      await this.plugin.app.vault.create(filePath, frontmatter);
      createdNames.push(entity.name);
      created++;
    }

    if (createdNames.length > 0) {
      await this.linkEntitiesInSource(createdNames);
    }

    new Notice(`Codex: created ${created} entity files and linked in source`);

    this.plugin.registry.clear();
    await this.plugin.vaultAdapter.fullIndex();
    this.plugin.refreshWarningsView();
  }

  private async linkEntitiesInSource(names: string[]): Promise<void> {
    let content = await this.plugin.app.vault.read(this.sourceFile);

    const { existingFrontmatter, body } = splitContent(content);

    let updatedBody = body;
    const sortedNames = [...names].sort((a, b) => b.length - a.length);

    for (const name of sortedNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(
        `(?<!\\[\\[)\\b(${escaped})\\b(?!\\]\\])`,
        'g',
      );
      updatedBody = updatedBody.replace(regex, `[[$1]]`);
    }

    if (updatedBody !== body) {
      const newContent = existingFrontmatter
        ? existingFrontmatter + '\n' + updatedBody
        : updatedBody;
      await this.plugin.app.vault.modify(this.sourceFile, newContent);
    }
  }
}

function buildEntityFrontmatter(entity: ExtractedEntity): string {
  const lines = ['---'];
  lines.push(`type: ${entity.type}`);
  lines.push(`name: "${entity.name}"`);

  if (['npc', 'creature'].includes(entity.type)) {
    lines.push('status: unknown');
  }
  if (['quest', 'faction', 'adventure'].includes(entity.type)) {
    lines.push('status: active');
  }
  lines.push('tags: []');
  lines.push('---');
  lines.push('');
  lines.push(`# ${entity.name}`);
  lines.push('');
  if (entity.description) {
    lines.push(entity.description);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireProvider(plugin: CodexPlugin) {
  const provider = plugin.getProvider();
  if (!provider) {
    new Notice('Codex: configure an AI provider in settings first.');
    return null;
  }
  return provider;
}

/**
 * Show a centered overlay with a spinning indicator.
 * Call the returned function to dismiss it.
 */
function showSpinner(message: string): () => void {
  const overlay = document.createElement('div');
  overlay.className = 'codex-spinner-overlay';

  const card = document.createElement('div');
  card.className = 'codex-spinner-card';

  const spinner = document.createElement('div');
  spinner.className = 'codex-spinner';
  card.appendChild(spinner);

  const text = document.createElement('div');
  text.className = 'codex-spinner-text';
  text.textContent = message;
  card.appendChild(text);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  return () => overlay.remove();
}

function parseEntityJSON(raw: string): ExtractedEntity[] {
  try {
    return JSON.parse(raw);
  } catch {
    // AI response may be truncated — try to salvage complete entries
  }

  const lastComplete = raw.lastIndexOf('}');
  if (lastComplete === -1) throw new Error('No valid JSON objects found');

  const trimmed = raw.slice(0, lastComplete + 1).trim();
  let fixable = trimmed;
  if (!fixable.endsWith(']')) fixable += ']';
  if (!fixable.startsWith('[')) fixable = '[' + fixable;

  try {
    const parsed = JSON.parse(fixable);
    console.debug(`Codex: Salvaged ${parsed.length} entities from truncated response`);
    return parsed;
  } catch {
    throw new Error('Could not parse entity JSON');
  }
}

function splitContent(content: string): { existingFrontmatter: string | null; body: string } {
  return splitFrontmatterAndBody(content);
}

function splitFrontmatterAndBody(content: string): { existingFrontmatter: string | null; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { existingFrontmatter: null, body: content };
  }

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) {
    return { existingFrontmatter: null, body: content };
  }

  const fmEnd = endIdx + 3;
  const existingFrontmatter = trimmed.slice(0, fmEnd).trim();
  const body = trimmed.slice(fmEnd).replace(/^\n+/, '');

  return { existingFrontmatter, body };
}

