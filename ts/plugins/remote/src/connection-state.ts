/** In-process connection phases. No SSH, no journal, no cross-process lock. */
import { resolve } from "node:path";
import { pyLen } from "@xueness/contracts";

const CONNECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const STATES = new Set(["pending", "reconnecting", "connected", "disconnected"]);
export const MAX_CONNECTIONS = 64;
export const MAX_DIRECTORIES = 8;

type Phase = "pending" | "reconnecting" | "connected" | "disconnected";
const records = new Map<string, Map<string, [string, Phase]>>();

const probes = new Map<string, (pluginId: string) => boolean>();

/**
 * The host registers its `plugin_runtime.is_enabled` for one state directory
 * (plugins may not import the extensions plugin). Unregistered: disabled.
 */
export function registerEnabled(stateDir: string, enabled: (pluginId: string) => boolean): () => void {
  const key = resolve(stateDir);
  probes.set(key, enabled);
  return () => { if (probes.get(key) === enabled) probes.delete(key); };
}

/** `plugin_runtime.is_enabled`: the host's effective catalog entry, read on each call; errors fail closed. */
export function pluginEnabled(stateDir: string, pluginId: string): boolean {
  const probe = typeof stateDir === "string" && stateDir ? probes.get(resolve(stateDir)) : undefined;
  try { return probe?.(pluginId) === true; } catch { return false; }
}

function stateKey(stateDir: unknown): string | null {
  if (stateDir == null) return null;
  let text: unknown = stateDir;
  if (typeof stateDir !== "string") {
    const fspath = (stateDir as { __fspath__?: () => unknown }).__fspath__;
    if (typeof fspath !== "function") return null;
    try { text = fspath.call(stateDir); } catch { return null; }
  }
  if (typeof text !== "string" || text.length === 0 || pyLen(text) > 4096 || text.includes("\0")) return null;
  return text;
}

function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
}

/** Record one phase. Invalid input and a disabled remote plugin store nothing. */
export function observe(stateDir: unknown, connectionId: string, digest: string, state: string): boolean {
  const key = stateKey(stateDir);
  if (key == null || !CONNECTION_ID.test(connectionId) || !DIGEST.test(digest) || !STATES.has(state)) return false;
  if (!pluginEnabled(key, "remote")) {
    forget_dir(key);
    return false;
  }
  let bucket = records.get(key);
  if (bucket == null) {
    bucket = new Map();
    records.set(key, bucket);
  } else touch(records, key, bucket);
  touch(bucket, connectionId, [digest, state as Phase]);
  while (bucket.size > MAX_CONNECTIONS) bucket.delete(bucket.keys().next().value as string);
  while (records.size > MAX_DIRECTORIES) records.delete(records.keys().next().value as string);
  return true;
}

/** Phase for this exact id and digest, or null. */
export function lookup(stateDir: unknown, connectionId: string, digest: string): string | null {
  const key = stateKey(stateDir);
  if (key == null || typeof connectionId !== "string" || typeof digest !== "string") return null;
  const row = records.get(key)?.get(connectionId);
  if (row == null || row[0] !== digest) return null;
  return row[1];
}

/** Copy of id to phase. Digests are not included. Oldest remaining id is first. */
export function recorded(stateDir: unknown): Record<string, string> {
  const key = stateKey(stateDir);
  const bucket = key == null ? undefined : records.get(key);
  if (!bucket) return {};
  return Object.fromEntries([...bucket].map(([id, row]) => [id, row[1]]));
}

export function forget(stateDir: unknown, connectionId: string): void {
  const key = stateKey(stateDir);
  if (key == null || typeof connectionId !== "string") return;
  records.get(key)?.delete(connectionId);
}

/** Drop every phase for one state directory. */
export function forget_dir(stateDir: unknown): void {
  const key = stateKey(stateDir);
  if (key != null) records.delete(key);
}

/** Test isolation. This is not a reconnect. */
export function reset(): void {
  records.clear();
}
