import type CodexPlugin from '../main';
import { renderEntityTooltip } from './hover-tooltip';

const TOOLTIP_CLS = 'codex-global-hover-tooltip';

const LINK_SELECTOR = [
  'a.internal-link',
  '.internal-link',
  '.cm-hmd-internal-link',
  '.is-unresolved',
  '.codex-editor-resolved',
  '[data-href]',
].join(', ');

/**
 * Global DOM-based hover handler that shows Codex entity cards when hovering
 * over internal links anywhere in Obsidian — Reading mode, Live Preview
 * rendered widgets, and Source mode raw links.
 */
export function installGlobalHover(plugin: CodexPlugin): () => void {
  let activeTooltip: HTMLElement | null = null;
  let activeLinkText: string | null = null;

  function getLinkText(el: Element): string | null {
    const href = el.getAttribute('data-href');
    if (href) return href.trim();
    const text = el.textContent?.trim()?.replace(/^\[\[|\]\]$/g, '');
    return text || null;
  }

  function findLink(target: HTMLElement): Element | null {
    return target.closest?.(LINK_SELECTOR) ?? null;
  }

  function removeTooltip(): void {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
    activeLinkText = null;
  }

  function showTooltip(link: Element, linkText: string, event: Event): void {
    const resolver = plugin.diagnosticEngine.getResolver();
    const resolved = resolver.resolve(linkText);
    if (resolved.length === 0) return;

    const entity = resolved[0];
    if (entity.type === 'custom' && !entity.frontmatter.type) return;

    // Only suppress Obsidian's native hover when we actually show our tooltip
    event.stopPropagation();

    removeTooltip();
    activeLinkText = linkText;

    const refPaths = new Set(
      plugin.registry.findReferences(entity.name).map(r => r.sourcePath),
    );
    for (const alias of entity.aliases) {
      for (const ref of plugin.registry.findReferences(alias)) {
        refPaths.add(ref.sourcePath);
      }
    }

    const tooltipEl = renderEntityTooltip(entity, refPaths.size);
    tooltipEl.classList.add(TOOLTIP_CLS);
    document.body.appendChild(tooltipEl);
    activeTooltip = tooltipEl;

    const rect = link.getBoundingClientRect();
    tooltipEl.style.setProperty('left', `${rect.left}px`);
    tooltipEl.style.setProperty('top', `${rect.top - tooltipEl.offsetHeight - 6}px`);

    if (tooltipEl.getBoundingClientRect().top < 0) {
      tooltipEl.style.setProperty('top', `${rect.bottom + 6}px`);
    }
  }

  function onMouseOver(e: Event): void {
    const target = e.target as HTMLElement;
    const link = findLink(target);

    if (!link) return;

    const linkText = getLinkText(link);
    if (!linkText) return;

    // Already showing tooltip for this link — don't recreate
    if (linkText === activeLinkText) {
      e.stopPropagation();
      return;
    }

    showTooltip(link, linkText, e);
  }

  function onMouseMove(e: MouseEvent): void {
    if (!activeLinkText) return;

    const target = e.target as HTMLElement;
    const link = findLink(target);

    if (link) {
      const linkText = getLinkText(link);
      if (linkText === activeLinkText) return;
    }

    // Mouse has moved off the active link
    removeTooltip();
  }

  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mousemove', onMouseMove);

  return () => {
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mousemove', onMouseMove);
    removeTooltip();
  };
}
