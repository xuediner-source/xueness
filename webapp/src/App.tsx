/**
 * Xueness native entry.
 *
 * This is the Xueness-owned workbench, built on our own event protocol and data
 * layer. The web entry renders this application for every URL.
 */
import React from "react";
import { XuenessWorkbenchContainer } from "./XuenessWorkbenchContainer";
import { RegionBoundary } from "./ui/primitives";

/** Base styling for the standalone workbench. */
const BASE_STYLE = `
  html, body { margin: 0; padding: 0; height: 100%; }
  body { font-family: var(--font-sans); }
  #root { height: 100%; }
`;

export function XuenessApp() {
  return (
    <>
      <style>{BASE_STYLE}</style>
      <div className="xn-app" data-testid="xn-app">
        {/* The workbench owns the whole shell: sidebar + chat-first main area. */}
        <RegionBoundary onReload={() => window.location.reload()}>
          <XuenessWorkbenchContainer />
        </RegionBoundary>
      </div>
    </>
  );
}
