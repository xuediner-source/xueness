/**
 * Interfaces of downloaded marketplace plugins.
 *
 * The four optional plugins are not part of this build. Their interface is
 * `frontend/optional-<id>.js` (and `.css`) inside the package the user
 * downloaded; the server serves those files from the verified install at
 * `/assets/`. A bundle is a classic script that assigns its exports to
 * `__xn_optional_<id>` and reads React and the host API from the globals set
 * here, so it shares this page's React and never carries its own.
 *
 * The plugins are built in the xueness-marketplace repository against
 * `@xueness/host` (host interface version 1, below).
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { t, tf, useLocale } from "../../i18n";
import { del, get, post } from "../../xuenessApi";
import { EmptyState } from "../../ui/primitives";

export const OPTIONAL_FRONTEND_HOST_VERSION = 1;
export type OptionalFrontendId = "magpie" | "model_monitor" | "tavern";
type HostGlobals = { __xnHostReact?: unknown; __xnHostJsx?: unknown; __xnHost?: unknown } & Record<string, unknown>;

function installHost(): HostGlobals {
  const scope = globalThis as unknown as HostGlobals;
  scope.__xnHostReact ??= React;
  scope.__xnHostJsx ??= jsxRuntime;
  scope.__xnHost ??= Object.freeze({ version: OPTIONAL_FRONTEND_HOST_VERSION, t, tf, useLocale, get, post, del, EmptyState });
  return scope;
}

const loading = new Map<OptionalFrontendId, Promise<Record<string, unknown>>>();

/** Load a plugin's interface once; a failed load is forgotten so the next attempt retries. */
export function loadOptionalFrontend(id: OptionalFrontendId): Promise<Record<string, unknown>> {
  const pending = loading.get(id);
  if (pending) return pending;
  const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const scope = installHost(), global = `__xn_optional_${id}`;
    if (scope[global] && typeof scope[global] === "object") { resolve(scope[global] as Record<string, unknown>); return; }
    if (!document.querySelector(`link[data-xn-optional="${id}"]`)) {
      // A package without styles answers 404 here; that is harmless.
      const style = document.createElement("link");
      style.rel = "stylesheet"; style.href = `/assets/optional-${id}.css`; style.dataset.xnOptional = id;
      document.head.append(style);
    }
    const script = document.createElement("script");
    script.src = `/assets/optional-${id}.js`; script.async = true; script.dataset.xnOptional = id;
    script.onload = () => {
      const exports = scope[global];
      if (exports && typeof exports === "object") resolve(exports as Record<string, unknown>);
      else reject(new Error(`The ${id} plugin package did not provide its interface`));
    };
    script.onerror = () => { script.remove(); reject(new Error(`The ${id} plugin interface is not installed`)); };
    document.head.append(script);
  });
  loading.set(id, promise);
  promise.catch(() => { loading.delete(id); });
  return promise;
}

/** A lazily loaded component exported by a downloaded plugin's interface. */
export function optionalComponent<P extends object>(id: OptionalFrontendId, name: string): LazyExoticComponent<ComponentType<P>> {
  return lazy(async () => {
    const exports = await loadOptionalFrontend(id);
    const component = exports[name];
    if (typeof component !== "function" && !(component && typeof component === "object")) throw new Error(`The ${id} plugin does not export ${name}`);
    return { default: component as ComponentType<P> };
  });
}
