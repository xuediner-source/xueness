/** Xueness native web entry. */
import React from "react";
import ReactDOM from "react-dom/client";

import { getLocale, loadEnglish } from "./i18n";

async function mount(): Promise<void> {
  if (getLocale() === "en") await loadEnglish();
  const { XuenessApp } = await import("./App");
  // App's base CSS is now loaded; keep the chosen appearance last in the cascade.
  const appearance = document.getElementById('xn-appearance');
  if (appearance) document.head.append(appearance);
  // Component chunks can add CSS later. Their base rules stay before the
  // selected appearance, including after a runtime palette switch.
  new MutationObserver(records => {
    const selected = document.getElementById('xn-appearance');
    if (!selected) return;
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof HTMLLinkElement && node.rel === 'stylesheet' && node !== selected
        && (node.compareDocumentPosition(selected) & Node.DOCUMENT_POSITION_PRECEDING)) document.head.insertBefore(node, selected);
    }
  }).observe(document.head, { childList: true });
  const rootElement = document.getElementById("root");
  if (!rootElement) return;
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <XuenessApp />
    </React.StrictMode>,
  );
}

void mount();
