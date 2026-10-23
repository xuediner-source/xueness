/**
 * Xueness native entry.
 *
 * This is the Xueness-owned workbench, built on our own event protocol and data
 * layer. The web entry renders this application for every URL.
 */
import React, { lazy, Suspense } from "react";
import { XuenessWorkbenchContainer } from "./XuenessWorkbenchContainer";
import { RegionBoundary } from "./ui/primitives";

const ConversationSharePage = lazy(() => import("./plugins/sessions/ConversationSharing").then(module => ({ default: module.ConversationSharePage })));

/** Base styling for the standalone workbench. */
const BASE_STYLE = `
  html, body { margin: 0; padding: 0; height: 100%; }
  body { font-family: var(--font-sans); }
  #root { height: 100%; }
`;

export function XuenessApp() {
  const shareMatch = typeof window === 'undefined' ? null : /^\/share\/([^/]+)\/?$/u.exec(window.location.pathname);
  let shareId: string | null = null;
  if (shareMatch?.[1]) {
    try { shareId = decodeURIComponent(shareMatch[1]); } catch { shareId = null; }
  }
  return (
    <>
      <style>{BASE_STYLE}</style>
      <div className="xn-app" data-testid="xn-app">
        {/* The workbench owns the whole shell: sidebar + chat-first main area. */}
        <RegionBoundary onReload={() => window.location.reload()}>
          {shareId ? <Suspense fallback={null}><ConversationSharePage shareId={shareId} onImported={id => {
            window.location.assign(`/?session=${encodeURIComponent(id)}`);
          }} /></Suspense> : <XuenessWorkbenchContainer />}
        </RegionBoundary>
      </div>
    </>
  );
}
