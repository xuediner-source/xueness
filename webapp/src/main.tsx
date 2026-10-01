/** Xueness native web entry. */
import React from "react";
import ReactDOM from "react-dom/client";

// The native app owns its styling now: one design-system stylesheet, no ZCode CSS.
import "./styles.css";
import { XuenessApp } from "./App";
import "./styles/workbench-refresh.css";
import "./styles/conversation-refresh.css";
import "./styles/composer-workspace.css";
import "./styles/composer-toolbar.css";
import "./styles/parity-final.css";

function mount(): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) return;
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <XuenessApp />
    </React.StrictMode>,
  );
}

mount();
