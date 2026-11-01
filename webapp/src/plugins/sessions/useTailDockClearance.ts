import { useLayoutEffect, type RefObject } from 'react';

/** Clear sticky overlap and add bounded breathing room above adjacent stacks.
 * Sibling docks already shrink the viewport: never copy their full height. */
export function useTailDockClearance(scrollerRef: RefObject<HTMLDivElement | null>, centered: boolean, hasDock: boolean): void {
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const viewport = scroller?.parentElement;
    const scope = viewport?.parentElement;
    if (!scroller || !viewport || !scope || typeof ResizeObserver === 'undefined') return;
    let docks: Element[] = [];
    let previous = -1;
    let previousMeasurement = "";
    const measure = () => {
      const bounds = viewport.getBoundingClientRect();
      const rects = docks.map(dock => ({ dock, rect: dock.getBoundingClientRect() }))
        .filter(({ rect }) => rect.height > 0 && rect.width > 0 && rect.right > bounds.left && rect.left < bounds.right);
      const overlap = rects.reduce((clearance, { rect }) => {
        if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) return clearance;
        return Math.max(clearance, bounds.bottom - Math.max(bounds.top, rect.top));
      }, 0);
      // Only a contiguous stack below this viewport counts. Nested composer
      // wrappers contribute their union, not repeated heights. Overlapping
      // docks are handled above and cannot also add sibling breathing room.
      const adjacent = rects.filter(({ dock, rect }) => !viewport.contains(dock) && rect.top >= bounds.bottom - 1)
        .sort((a, b) => a.rect.top - b.rect.top);
      let stackBottom = bounds.bottom;
      for (const { rect } of adjacent) {
        if (rect.top > stackBottom + 24) break;
        stackBottom = Math.max(stackBottom, rect.bottom);
      }
      // A normal single-line composer stays at the token floor. Queue/recovery
      // growth adds at most 32px, also bounded on short viewports.
      const breathing = Math.min(32, bounds.height * .12, Math.max(0, stackBottom - bounds.bottom - 96) / 6);
      const clearance = Math.max(overlap + 12, 20 + breathing);
      const measurement = `${Math.ceil(overlap)}:${Math.ceil(breathing)}`;
      if (measurement === previousMeasurement) return;
      previousMeasurement = measurement;
      viewport.dataset.dockLowering = String(clearance < previous);
      viewport.style.setProperty('--xn-tail-chip-bottom', `max(calc(var(--space-5) + ${Math.ceil(breathing)}px), calc(${Math.ceil(overlap)}px + var(--space-3)))`);
      previous = clearance;
    };
    const observer = new ResizeObserver(measure);
    const connect = () => {
      observer.disconnect();
      docks = Array.from(scope.querySelectorAll('.xn-session-composer-dock, .xn-queue-dock, .xn-composer-region'))
        .filter(dock => dock.closest('.xn-pane-conversation, .xn-conversation, .xn-empty-state-shell') === viewport.closest('.xn-pane-conversation, .xn-conversation, .xn-empty-state-shell'));
      observer.observe(viewport);
      observer.observe(scope);
      docks.forEach(dock => observer.observe(dock));
      measure();
    };
    connect();
    // Queue/recovery docks can mount as siblings while the viewport stays alive.
    const mutations = new MutationObserver(connect);
    mutations.observe(scope, { childList: true });
    scroller.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      scroller.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      viewport.style.removeProperty('--xn-tail-chip-bottom');
      delete viewport.dataset.dockLowering;
    };
  }, [scrollerRef, centered, hasDock]);
}
