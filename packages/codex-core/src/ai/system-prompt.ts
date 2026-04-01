import type { VaultContext } from './types';

export interface SystemPromptOptions {
  ruleSystem: string;
  campaignTone: string;
}

const DEFAULT_OPTIONS: SystemPromptOptions = {
  ruleSystem: 'D&D 5e',
  campaignTone: '',
};

/**
 * Builds the system prompt for LLM interactions, injecting vault context
 * so responses are grounded in the user's actual lore.
 */
export function buildSystemPrompt(
  context: VaultContext,
  options: Partial<SystemPromptOptions> = {},
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const sections: string[] = [
    BASE_PROMPT,
    buildCampaignMeta(opts, context),
  ];

  if (context.entities.length > 0) {
    sections.push(buildEntityContext(context));
  }

  if (context.worldRules.length > 0) {
    sections.push(buildWorldRules(context));
  }

  if (context.recentSessions.length > 0) {
    sections.push(buildRecentSessions(context));
  }

  sections.push(GENERATION_RULES);

  return sections.join('\n\n');
}

const BASE_PROMPT = `You are a creative assistant for a tabletop RPG campaign. You have deep knowledge of the campaign's lore and must stay consistent with established facts.

Your role:
- Answer questions about the campaign world using ONLY the provided context
- Generate new content that fits seamlessly into the existing lore
- Flag potential contradictions if you notice them
- Be creative but never contradict established facts`;

function buildCampaignMeta(opts: SystemPromptOptions, context: VaultContext): string {
  const lines = ['CAMPAIGN INFO:'];
  if (opts.ruleSystem) lines.push(`- Rule System: ${opts.ruleSystem}`);
  if (opts.campaignTone) lines.push(`- Tone: ${opts.campaignTone}`);
  lines.push(`- Total indexed entities: ${context.totalEntityCount}`);
  lines.push(`- Entities in current context: ${context.entities.length}`);
  return lines.join('\n');
}

function buildEntityContext(context: VaultContext): string {
  const lines = ['KNOWN ENTITIES:'];
  for (const entity of context.entities) {
    lines.push(`\n### ${entity.name} (${entity.type})`);

    const fmEntries = Object.entries(entity.frontmatter)
      .filter(([k]) => k !== 'type' && k !== 'name')
      .map(([k, v]) => `  ${k}: ${formatValue(v)}`);
    if (fmEntries.length > 0) {
      lines.push(fmEntries.join('\n'));
    }

    if (entity.bodyPreview) {
      lines.push(entity.bodyPreview);
    }

    if (entity.statblockRaw) {
      lines.push('  Statblock:');
      for (const sbLine of entity.statblockRaw.split('\n').slice(0, 20)) {
        lines.push(`    ${sbLine}`);
      }
    }

    if (entity.linkedEntityNames.length > 0) {
      const unique = [...new Set(entity.linkedEntityNames)];
      lines.push(`  Links to: ${unique.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function buildWorldRules(context: VaultContext): string {
  return 'WORLD RULES & LORE:\n' + context.worldRules.join('\n\n');
}

function buildRecentSessions(context: VaultContext): string {
  return 'RECENT SESSIONS:\n' + context.recentSessions.join('\n\n');
}

const GENERATION_RULES = `RESPONSE RULES:
- Use [[Entity Name]] wiki-link syntax when referencing existing campaign entities
- When generating new entities, include valid YAML frontmatter with the appropriate type field
- Maintain consistency with all established relationships, timelines, and character states
- If asked to create content that would contradict existing lore, explain the contradiction and suggest alternatives
- Keep the tone consistent with the campaign setting`;

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
