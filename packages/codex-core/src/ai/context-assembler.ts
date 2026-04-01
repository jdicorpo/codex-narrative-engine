import type { EntityRegistry } from '../indexer/entity-registry';
import type { Entity, EntityType } from '../types';
import type { EntitySummary, VaultContext } from './types';

export interface ContextAssemblerOptions {
  maxEntities?: number;
  recentSessionCount?: number;
  linkExpansionDepth?: number;
  includeWorldEntities?: boolean;
}

const DEFAULTS: Required<ContextAssemblerOptions> = {
  maxEntities: 60,
  recentSessionCount: 3,
  linkExpansionDepth: 1,
  includeWorldEntities: true,
};

/**
 * Assembles vault context for LLM prompts by extracting relevant entities
 * from the registry based on a user query.
 */
export class ContextAssembler {
  constructor(
    private registry: EntityRegistry,
    private options: ContextAssemblerOptions = {},
  ) {}

  /**
   * Build a VaultContext for a user query. Extracts mentioned entity names,
   * expands via link graph, and includes recent sessions + world rules.
   */
  assemble(userMessage: string): VaultContext {
    const opts = { ...DEFAULTS, ...this.options };
    const allEntities = this.registry.getAllEntities();

    const mentionedNames = this.extractMentionedNames(userMessage, allEntities);
    const directEntities = this.resolveNames(mentionedNames);

    const expanded = new Map<string, Entity>();
    for (const entity of directEntities) {
      expanded.set(entity.filePath, entity);
    }
    if (opts.linkExpansionDepth > 0) {
      this.expandLinks(expanded, directEntities, opts.linkExpansionDepth);
    }

    if (opts.includeWorldEntities) {
      for (const entity of this.registry.getByType('world')) {
        expanded.set(entity.filePath, entity);
      }
    }

    const entities = Array.from(expanded.values())
      .slice(0, opts.maxEntities)
      .map(e => this.toSummary(e));

    const recentSessions = this.getRecentSessions(opts.recentSessionCount);
    const worldRules = this.getWorldRules();

    return {
      entities,
      recentSessions,
      worldRules,
      totalEntityCount: allEntities.length,
    };
  }

  /**
   * Build a VaultContext scoped to specific @mention directives.
   */
  assembleFromMentions(mentions: string[]): VaultContext {
    const allEntities = this.registry.getAllEntities();
    const collected = new Map<string, Entity>();

    for (const mention of mentions) {
      const lower = mention.toLowerCase();

      if (lower === '@all') {
        for (const e of allEntities) collected.set(e.filePath, e);
        break;
      }
      if (lower === '@recent') {
        const sessions = this.registry.getByType('session')
          .sort((a, b) => this.sessionDate(b) - this.sessionDate(a))
          .slice(0, 3);
        for (const s of sessions) collected.set(s.filePath, s);
        continue;
      }
      if (lower === '@world') {
        for (const e of this.registry.getByType('world')) collected.set(e.filePath, e);
        continue;
      }

      const typeMatch = lower.replace('@', '');
      const byType = this.registry.getByType(typeMatch as EntityType);
      if (byType.length > 0) {
        for (const e of byType) collected.set(e.filePath, e);
        continue;
      }

      const entityName = mention.replace('@', '');
      const byName = this.registry.getByName(entityName);
      for (const e of byName) collected.set(e.filePath, e);
    }

    return {
      entities: Array.from(collected.values()).map(e => this.toSummary(e)),
      recentSessions: [],
      worldRules: this.getWorldRules(),
      totalEntityCount: allEntities.length,
    };
  }

  private extractMentionedNames(query: string, allEntities: Entity[]): string[] {
    const queryLower = query.toLowerCase();
    const found: string[] = [];

    const sorted = [...allEntities].sort((a, b) => b.name.length - a.name.length);
    for (const entity of sorted) {
      if (queryLower.includes(entity.name.toLowerCase())) {
        found.push(entity.name);
      }
    }
    return found;
  }

  private resolveNames(names: string[]): Entity[] {
    const entities: Entity[] = [];
    for (const name of names) {
      entities.push(...this.registry.getByName(name));
    }
    return entities;
  }

  private expandLinks(
    expanded: Map<string, Entity>,
    seeds: Entity[],
    depth: number,
  ): void {
    let frontier = seeds;
    for (let d = 0; d < depth; d++) {
      const next: Entity[] = [];
      for (const entity of frontier) {
        for (const link of entity.links) {
          const targets = this.registry.getByName(link.target);
          for (const t of targets) {
            if (!expanded.has(t.filePath)) {
              expanded.set(t.filePath, t);
              next.push(t);
            }
          }
        }
      }
      frontier = next;
    }
  }

  private toSummary(entity: Entity): EntitySummary {
    const summary: EntitySummary = {
      name: entity.name,
      type: entity.type,
      filePath: entity.filePath,
      frontmatter: entity.frontmatter,
      bodyPreview: entity.bodyPreview,
      linkedEntityNames: entity.links.map(l => l.target),
    };
    if (entity.statblock) {
      summary.statblockRaw = entity.statblock.raw;
    }
    return summary;
  }

  private getRecentSessions(count: number): string[] {
    return this.registry
      .getByType('session')
      .sort((a, b) => this.sessionDate(b) - this.sessionDate(a))
      .slice(0, count)
      .map(s => `## ${s.name}\n${s.bodyPreview}`);
  }

  private getWorldRules(): string[] {
    return this.registry
      .getByType('world')
      .map(w => `## ${w.name}\n${w.bodyPreview}`);
  }

  private sessionDate(entity: Entity): number {
    const d = entity.frontmatter['date'];
    if (typeof d === 'string') return new Date(d).getTime() || 0;
    return 0;
  }
}
