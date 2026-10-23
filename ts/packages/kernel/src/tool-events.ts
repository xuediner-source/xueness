/**
 * Tool events: the seams around every tool call, after Python's tool event
 * pipeline (plugin_runtime.py). Plugins subscribe through their context; the
 * tool bridge dispatches.
 *
 *   before_tool_execution     every subscriber observes; a declared one may deny
 *   after_tool_authorization  declared plugins only; observes the allowed call
 *   before_tool_effect        declared plugins only; a strict, fail-closed policy
 *   after_tool_execution      every subscriber observes; a declared one may rewrite
 *
 * "Declared" means the manifest lists the event in `toolEvents`; subscribing
 * to a declared-only event without that throws. Dispatch order: a plugin
 * after the plugins it depends on, then higher manifest priority, then
 * subscription order.
 */
import { TOOL_EVENT_NAMES } from "@xueness/contracts";
import type { Scope } from "./scope.ts";

export type ToolEventName = (typeof TOOL_EVENT_NAMES)[number];
export type ToolEventHandler = (payload: Readonly<Record<string, unknown>>) => unknown;

/** Who subscribes: the plugin, whether its manifest declares the event, its priority and its dependencies (transitive). */
export interface ToolEventOwner {
  readonly plugin: string;
  readonly declared: boolean;
  readonly priority: number;
  readonly dependencies: readonly string[];
}

export interface ToolEventParticipant {
  readonly plugin: string;
  readonly event: ToolEventName;
  readonly declared: boolean;
  readonly priority: number;
  readonly handler: ToolEventHandler;
}

export class UndeclaredToolEventError extends Error {
  override name = "UndeclaredToolEventError";
  readonly code = "undeclared_tool_event";
}

export const DECLARED_ONLY_TOOL_EVENTS: ReadonlySet<string> = new Set(["after_tool_authorization", "before_tool_effect"]);

interface Entry {
  readonly owner: ToolEventOwner;
  readonly event: ToolEventName;
  readonly handler: ToolEventHandler;
  readonly seq: number;
}

export class ToolEventRegistry {
  readonly #entries = new Set<Entry>();
  #seq = 0;

  add(event: string, handler: ToolEventHandler, owner: ToolEventOwner, scope: Scope): () => Promise<void> {
    if (!(TOOL_EVENT_NAMES as readonly string[]).includes(event)) {
      throw new TypeError(`unknown tool event ${JSON.stringify(event)}; expected one of ${TOOL_EVENT_NAMES.join(", ")}`);
    }
    if (typeof handler !== "function") throw new TypeError("a tool event handler must be a function");
    if (DECLARED_ONLY_TOOL_EVENTS.has(event) && !owner.declared) {
      throw new UndeclaredToolEventError(`${owner.plugin} does not declare ${event} in its manifest's toolEvents`);
    }
    const entry: Entry = { owner, event: event as ToolEventName, handler, seq: this.#seq++ };
    // The disposer goes first: an ended scope throws before anything is subscribed.
    const release = scope.add(() => void this.#entries.delete(entry));
    this.#entries.add(entry);
    return release;
  }

  /** Subscribers of one event in dispatch order. */
  participants(event: ToolEventName): ToolEventParticipant[] {
    const groups = new Map<string, Entry[]>();
    for (const entry of this.#entries) {
      if (entry.event !== event) continue;
      const group = groups.get(entry.owner.plugin);
      if (group) group.push(entry);
      else groups.set(entry.owner.plugin, [entry]);
    }
    const first = (plugin: string): Entry => (groups.get(plugin) as Entry[])[0] as Entry;
    const rank = (a: string, b: string): number => first(b).owner.priority - first(a).owner.priority || first(a).seq - first(b).seq;
    const remaining = new Set(groups.keys());
    const order: string[] = [];
    while (remaining.size) {
      const ready = [...remaining].filter((plugin) => first(plugin).owner.dependencies.every((dependency) => !remaining.has(dependency)));
      // A cycle cannot pass catalog validation; should one appear, fall back to priority order instead of looping.
      const next = (ready.length ? ready : [...remaining]).sort(rank)[0] as string;
      remaining.delete(next);
      order.push(next);
    }
    return order.flatMap((plugin) => (groups.get(plugin) as Entry[]).map(({ owner, handler }) => Object.freeze({
      plugin: owner.plugin, event, declared: owner.declared, priority: owner.priority, handler,
    })));
  }

  get size(): number {
    return this.#entries.size;
  }
}
