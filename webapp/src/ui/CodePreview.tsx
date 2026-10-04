import React, { useEffect, useState } from "react";
import { t as tr } from "../i18n";
import "./code-preview.css";

export const CODE_PREVIEW_THEME_OPTIONS = [
  { value: "github-light", label: "GitHub Light" },
  { value: "github-dark", label: "GitHub Dark" },
  { value: "vitesse-light", label: "Vitesse Light" },
  { value: "vitesse-dark", label: "Vitesse Dark" },
  { value: "min-light", label: "Minimal Light" },
  { value: "min-dark", label: "Minimal Dark" },
  { value: "github-light-high-contrast", label: "GitHub HC Light" },
  { value: "github-dark-high-contrast", label: "GitHub HC Dark" },
  { value: "catppuccin-latte", label: "Catppuccin Latte" },
  { value: "catppuccin-mocha", label: "Catppuccin Mocha" },
] as const;

export type CodePreviewTheme = (typeof CODE_PREVIEW_THEME_OPTIONS)[number]["value"];
export type CodePreviewMode = "light" | "dark";

export const DEFAULT_CODE_PREVIEW_SOURCE = `const themePreview: ThemeConfig = {
  surface: "sidebar",
  accent: "#339CFF",
  contrast: 45,
};`;

const THEME_LOADERS = {
  "github-light": () => import("shiki/dist/themes/github-light.mjs"),
  "github-dark": () => import("shiki/dist/themes/github-dark.mjs"),
  "vitesse-light": () => import("shiki/dist/themes/vitesse-light.mjs"),
  "vitesse-dark": () => import("shiki/dist/themes/vitesse-dark.mjs"),
  "min-light": () => import("shiki/dist/themes/min-light.mjs"),
  "min-dark": () => import("shiki/dist/themes/min-dark.mjs"),
  "github-light-high-contrast": () => import("shiki/dist/themes/github-light-high-contrast.mjs"),
  "github-dark-high-contrast": () => import("shiki/dist/themes/github-dark-high-contrast.mjs"),
  "catppuccin-latte": () => import("shiki/dist/themes/catppuccin-latte.mjs"),
  "catppuccin-mocha": () => import("shiki/dist/themes/catppuccin-mocha.mjs"),
} satisfies Record<CodePreviewTheme, () => Promise<{ default: unknown }>>;

type PreviewHighlighter = Awaited<ReturnType<typeof import("shiki/dist/core.mjs").createHighlighterCore>>;

let sharedHighlighterPromise: Promise<PreviewHighlighter> | null = null;
let sharedHighlighter: PreviewHighlighter | null = null;
const loadedThemesSet = new Set<string>();
const loadedLangsSet = new Set<string>();

const LANGUAGE_LOADERS = {
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  jsx: () => import("shiki/dist/langs/jsx.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  bash: () => import("shiki/dist/langs/bash.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  rust: () => import("shiki/dist/langs/rust.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  cpp: () => import("shiki/dist/langs/cpp.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
};
export type CodeLanguage = keyof typeof LANGUAGE_LOADERS;

export function getLoadedHighlighter(theme: CodePreviewTheme, language: CodeLanguage | "text"): PreviewHighlighter | null {
  if (!sharedHighlighter) return null;
  if (!loadedThemesSet.has(theme)) return null;
  if (language !== "text" && !loadedLangsSet.has(language)) return null;
  return sharedHighlighter;
}

export function loadHighlighter(themes: readonly CodePreviewTheme[], language: CodeLanguage = "typescript"): Promise<PreviewHighlighter> {
  const themeNames = [...new Set(themes)].sort();
  if (!sharedHighlighterPromise) {
    sharedHighlighterPromise = Promise.all([
      import("shiki/dist/wasm.mjs"),
      import("shiki/dist/core.mjs"),
      import("shiki/dist/engine-oniguruma.mjs"),
    ]).then(([wasm, { createHighlighterCore }, { createOnigurumaEngine }]) =>
      createHighlighterCore({
        themes: [],
        langs: [],
        engine: createOnigurumaEngine(wasm.default),
        warnings: false,
      })
    ).then((hl) => {
      sharedHighlighter = hl;
      return hl;
    }).catch((err) => {
      sharedHighlighterPromise = null;
      sharedHighlighter = null;
      throw err;
    });
  }

  return sharedHighlighterPromise.then(async (hl) => {
    const missingThemes = themeNames.filter((t) => !loadedThemesSet.has(t));
    const missingLang = !loadedLangsSet.has(language) ? language : null;

    if (missingThemes.length > 0) {
      const loaded = await Promise.all(missingThemes.map((t) => THEME_LOADERS[t]()));
      for (let i = 0; i < missingThemes.length; i++) {
        await hl.loadTheme((loaded[i] as { default: any }).default);
        loadedThemesSet.add(missingThemes[i]);
      }
    }

    if (missingLang) {
      const langMod = await LANGUAGE_LOADERS[missingLang]();
      await hl.loadLanguage((langMod as { default: any }).default);
      loadedLangsSet.add(missingLang);
    }

    return hl;
  });
}

export function isCodePreviewTheme(value: unknown): value is CodePreviewTheme {
  return typeof value === "string" && CODE_PREVIEW_THEME_OPTIONS.some((theme) => theme.value === value);
}

export function CodePreview({
  mode,
  theme,
  themeName,
  active,
  showLineNumbers,
  wrapLongLines,
  fontSizePx,
}: {
  mode: CodePreviewMode;
  theme: CodePreviewTheme;
  themeName: string;
  active: boolean;
  showLineNumbers: boolean;
  wrapLongLines: boolean;
  fontSizePx: number;
}): React.JSX.Element {
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setHtml("");
    setError("");
    void loadHighlighter([theme]).then((highlighter) => {
      const next = highlighter.codeToHtml(DEFAULT_CODE_PREVIEW_SOURCE, {
        lang: "typescript",
        theme,
      });
      if (!cancelled) setHtml(next);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [theme]);

  return (
    <article className="xn-code-preview-card" data-testid={`code-preview-${mode}`} data-mode={mode}>
      <header className="xn-code-preview-card__header">
        <div className="xn-code-preview-card__title">
          <h3>{mode === "light" ? tr("浅色预览") : tr("深色预览")}</h3>
          <span>{themeName}</span>
        </div>
        <span className={`xn-code-preview-card__badge${active ? " is-active" : ""}`}>
          {active ? tr("当前生效") : mode === "light" ? tr("浅色") : tr("深色")}
        </span>
      </header>
      <div className="xn-code-preview-card__body">
        {error ? (
          <p className="xn-code-preview-card__error" role="alert">{error}</p>
        ) : html ? (
          <div
            className={`xn-code-preview-card__code${showLineNumbers ? " has-line-numbers" : ""}${wrapLongLines ? " wraps-lines" : ""}`}
            style={{ fontSize: `${Math.min(20, Math.max(10, fontSizePx))}px` }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="xn-code-preview-card__loading" role="status">{tr("加载代码预览…")}</div>
        )}
      </div>
    </article>
  );
}
