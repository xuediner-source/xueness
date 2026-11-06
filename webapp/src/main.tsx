/** Xueness native web entry. */
import React from "react";
import ReactDOM from "react-dom/client";

import { getLocale, loadEnglish } from "./i18n";

async function mount(): Promise<void> {
  if (getLocale() === "en") await loadEnglish();
  // Stylesheet order does not matter: precedence comes from the cascade layers
  // declared in styles/layers.css, so the appearance and lazy chunks load freely.
  const { XuenessApp } = await import("./App");
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
