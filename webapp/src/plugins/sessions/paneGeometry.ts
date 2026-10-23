import { clampPaneRatio, type PaneNode } from './paneTree';

/** Unit rectangles keep leaf React ownership flat while split ancestry changes. */
export type PaneRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type PaneLeafGeometry = PaneRect & { readonly paneId: string };
export type PaneSplitGeometry = PaneRect & { readonly splitId: string; readonly direction: 'row' | 'column'; readonly ratio: number };
export type PaneGeometry = { readonly leaves: readonly PaneLeafGeometry[]; readonly splits: readonly PaneSplitGeometry[] };
export function paneTreeGeometry(root: PaneNode): PaneGeometry {
  const leaves: PaneLeafGeometry[] = [], splits: PaneSplitGeometry[] = [];
  const visit = (node: PaneNode, rect: PaneRect): void => {
    if (node.type === 'leaf') { leaves.push({ paneId: node.paneId, ...rect }); return; }
    const ratio = clampPaneRatio(node.ratio);
    splits.push({ splitId: node.splitId, direction: node.direction, ratio, ...rect });
    if (node.direction === 'row') {
      visit(node.first, { ...rect, width: rect.width * ratio });
      visit(node.second, { ...rect, x: rect.x + rect.width * ratio, width: rect.width * (1 - ratio) });
    } else {
      visit(node.first, { ...rect, height: rect.height * ratio });
      visit(node.second, { ...rect, y: rect.y + rect.height * ratio, height: rect.height * (1 - ratio) });
    }
  };
  visit(root, { x: 0, y: 0, width: 1, height: 1 });
  return { leaves, splits };
}
