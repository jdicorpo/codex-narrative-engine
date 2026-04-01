import type { Diagnostic } from '../types';
import type { LinkResolver } from '../resolver/link-resolver';
import type { EntityRegistry } from '../indexer/entity-registry';

/**
 * Detect [[wiki-links]] that don't resolve to any known entity or file.
 */
export function detectDeadLinks(
  registry: EntityRegistry,
  resolver: LinkResolver,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const allLinks = registry.getAllLinks();

  const checked = new Set<string>();

  for (const link of allLinks) {
    const key = `${link.sourcePath}:${link.line}:${link.column}`;
    if (checked.has(key)) continue;
    checked.add(key);

    if (!resolver.isResolvable(link.target)) {
      diagnostics.push({
        filePath: link.sourcePath,
        line: link.line,
        column: link.column,
        endColumn: link.column + link.target.length + 4, // [[ + target + ]]
        severity: 'warning',
        message: `Entity "${link.target}" not found. No file matches this link.`,
        rule: 'dead-link',
        relatedEntities: [link.target],
      });
    }
  }

  return diagnostics;
}
