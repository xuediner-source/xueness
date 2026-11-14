/**
 * The Memory Ocean graph: which memories are connected, and which form a
 * constellation together.
 *
 * Edges come from explicit links (related, supersedes), shared tags and text
 * overlap. Candidate pairs are found through an inverted index over tags and
 * reasonably rare terms, so the work stays far below all-pairs; each memory
 * keeps only its strongest few edges. Constellations are found by weighted
 * label propagation over the stronger edges, and are named by their most
 * common tag, or else their most common kind.
 */
import { similarity, terms } from "./memory-ocean-terms.ts";
import type { OceanEvent, OceanKind, OceanMemory } from "./memory-ocean-store.ts";

export type OceanEdgeKind = "related" | "supersedes" | "tags" | "similar";
export interface OceanNode extends OceanMemory { here: boolean; cluster: number | null; origin: "ocean" | "curated" }
export interface OceanEdge { a: string; b: string; weight: number; kind: OceanEdgeKind }
export interface OceanCluster { id: number; label: string; kind: OceanKind | null; size: number }
export interface OceanView {
  nodes: OceanNode[]; edges: OceanEdge[]; clusters: OceanCluster[]; events: OceanEvent[];
  project: { key: string; label: string } | null;
  stats: { total: number; active: number; kinds: Record<string, number> };
}

const PER_NODE = 6;
const MIN_SIMILAR = 0.12;
const CLUSTER_EDGE = 0.22;

export function oceanGraph(memories: readonly OceanMemory[], events: readonly OceanEvent[], project: { key: string; label: string } | null, curated: readonly OceanMemory[] = []): OceanView {
  const all = [...memories, ...curated];
  const position = new Map(all.map((memory, index) => [memory.id, index]));
  const words = all.map((memory) => [...new Set(terms(`${memory.summary} ${memory.text}`))]);
  const pairs = new Map<string, OceanEdge>();
  const explicit = (kind: OceanEdgeKind): boolean => kind === "related" || kind === "supersedes";
  /** One edge per pair: evidence adds up, and an explicit link names the edge over a derived one. */
  const offer = (a: number, b: number, weight: number, kind: OceanEdgeKind): void => {
    if (a === b || weight <= 0) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x}:${y}`, current = pairs.get(key);
    if (!current) { pairs.set(key, { a: all[x]!.id, b: all[y]!.id, weight: Math.min(1, weight), kind }); return; }
    const stronger = explicit(kind) && !explicit(current.kind) || explicit(kind) === explicit(current.kind) && weight > current.weight;
    current.weight = Math.min(1, Math.max(current.weight, weight) + 0.25 * Math.min(current.weight, weight));
    if (stronger) current.kind = kind;
  };
  all.forEach((memory, index) => {
    for (const link of memory.links) {
      const other = position.get(link.to);
      if (other !== undefined) offer(index, other, link.kind === "supersedes" ? 0.9 : 1, link.kind);
    }
  });
  const byTag = new Map<string, number[]>();
  all.forEach((memory, index) => { for (const tag of memory.tags) byTag.set(tag, [...byTag.get(tag) ?? [], index]); });
  const shared = new Map<string, number>();
  for (const members of byTag.values()) {
    const capped = members.slice(0, 80);
    for (let i = 0; i < capped.length; i += 1) for (let j = i + 1; j < capped.length; j += 1) {
      const key = `${capped[i]}:${capped[j]}`;
      shared.set(key, (shared.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of shared) { const [a, b] = key.split(":").map(Number); offer(a!, b!, Math.min(1, 0.35 + 0.2 * (count - 1)), "tags"); }
  const byTerm = new Map<string, number[]>();
  words.forEach((list, index) => { for (const term of list) byTerm.set(term, [...byTerm.get(term) ?? [], index]); });
  const rare = Math.max(3, Math.ceil(all.length * 0.15));
  const seen = new Set<string>();
  for (const members of byTerm.values()) {
    if (members.length < 2 || members.length > rare) continue;
    for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) {
      const key = `${members[i]}:${members[j]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const overlap = similarity(words[members[i]!]!, words[members[j]!]!);
      if (overlap >= MIN_SIMILAR) offer(members[i]!, members[j]!, Math.min(0.9, overlap * 1.8), "similar");
    }
  }
  const edges = strongest([...pairs.values()]);
  const clusters = constellations(all, edges);
  const nodes: OceanNode[] = all.map((memory, index) => ({ ...memory, origin: index < memories.length ? "ocean" : "curated",
    here: memory.scope === "global" || !!project && memory.project?.key === project.key, cluster: clusters.assignment.get(memory.id) ?? null }));
  const kinds: Record<string, number> = {};
  for (const memory of memories) if (memory.status === "active") kinds[memory.kind] = (kinds[memory.kind] ?? 0) + 1;
  return { nodes, edges, clusters: clusters.list, events: events.slice(-60), project,
    stats: { total: memories.length, active: memories.filter((memory) => memory.status === "active").length, kinds } };
}

/** Each memory keeps its `PER_NODE` strongest edges; an edge survives if either end keeps it. */
function strongest(edges: OceanEdge[]): OceanEdge[] {
  const byNode = new Map<string, OceanEdge[]>();
  for (const edge of edges) for (const id of [edge.a, edge.b]) byNode.set(id, [...byNode.get(id) ?? [], edge]);
  const kept = new Set<OceanEdge>();
  for (const list of byNode.values()) for (const edge of list.sort((x, y) => y.weight - x.weight).slice(0, PER_NODE)) kept.add(edge);
  return [...kept].map((edge) => ({ ...edge, weight: Math.round(edge.weight * 1000) / 1000 }));
}

function constellations(memories: readonly OceanMemory[], edges: readonly OceanEdge[]): { assignment: Map<string, number>; list: OceanCluster[] } {
  const neighbours = new Map<string, { id: string; weight: number }[]>();
  for (const edge of edges) {
    if (edge.weight < CLUSTER_EDGE) continue;
    neighbours.set(edge.a, [...neighbours.get(edge.a) ?? [], { id: edge.b, weight: edge.weight }]);
    neighbours.set(edge.b, [...neighbours.get(edge.b) ?? [], { id: edge.a, weight: edge.weight }]);
  }
  const ids = memories.map((memory) => memory.id).sort();
  const label = new Map(ids.map((id) => [id, id]));
  for (let round = 0; round < 12; round += 1) {
    let changed = false;
    for (const id of ids) {
      const votes = new Map<string, number>();
      for (const near of neighbours.get(id) ?? []) votes.set(label.get(near.id)!, (votes.get(label.get(near.id)!) ?? 0) + near.weight);
      if (!votes.size) continue;
      const best = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
      if (best !== label.get(id)) { label.set(id, best); changed = true; }
    }
    if (!changed) break;
  }
  const groups = new Map<string, OceanMemory[]>();
  for (const memory of memories) groups.set(label.get(memory.id)!, [...groups.get(label.get(memory.id)!) ?? [], memory]);
  const assignment = new Map<string, number>();
  const list: OceanCluster[] = [];
  for (const members of [...groups.values()].filter((group) => group.length >= 2).sort((a, b) => b.length - a.length)) {
    const id = list.length;
    const tags = tally(members.flatMap((memory) => memory.tags));
    const kinds = tally(members.map((memory) => memory.kind));
    const tag = tags[0] && tags[0][1] >= 2 ? tags[0][0] : "";
    list.push({ id, label: tag, kind: (kinds[0]?.[0] as OceanKind | undefined) ?? null, size: members.length });
    for (const memory of members) assignment.set(memory.id, id);
  }
  return { assignment, list };
}

function tally(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}
