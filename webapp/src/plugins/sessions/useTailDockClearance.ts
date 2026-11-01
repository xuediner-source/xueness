import { useLayoutEffect, type RefObject } from 'react';

/** Measure only the current pane. Sibling docks already consume layout space;
 * sticky docks inside the scroll root need their visible overlap cleared. */
export function useTailDockClearance(scrollerRef: RefObject<HTMLDivElement | null>, centered: boolean, hasDock: boolean): void {
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const viewport = scroller?.parentElement;
    const scope = viewport?.parentElement;
    if (!scroller || !viewport || !scope || typeof ResizeObserver === 'undefined') return;
    let docks: Element[] = [];
    let previous = 0;
    const measure = () => {
      const bounds = viewport.getBoundingClientRect();
      const overlap = docks.reduce((clearance, dock) => {
        const rect = dock.getBoundingClientRect();
        if (rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) return clearance;
        return Math.max(clearance, bounds.bottom - Math.max(bounds.top, rect.top));
      }, 0);
      viewport.dataset.dockLowering = String(overlap < previous);
      viewport.style.setProperty('--xn-tail-chip-bottom', `max(var(--space-5), calc(${Math.ceil(overlap)}px + var(--space-3)))`);
      previous = overlap;
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
