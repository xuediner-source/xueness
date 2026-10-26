/**
 * H09.06 — Tournament report artifacts (JSON + Markdown).
 */
import { canonicalJson } from "../prefix-cache.ts";
import type { Scoreboard } from "./scoring.ts";
import type { Bracket } from "./bracket.ts";

export interface TournamentReport {
  readonly label: string;
  readonly createdAt: string;
  readonly champion: string | null;
  readonly scoreboard: Scoreboard;
  readonly bracketComplete: boolean;
}

function bracketIsComplete(bracket: Bracket): boolean {
  return bracket.rounds.every((round) => round.every((match) => match.status === "played" || match.status === "bye"));
}

export function buildTournamentReport(input: {
  label: string;
  createdAt: string;
  scoreboard: Scoreboard;
  bracket: Bracket;
  champion?: string | null;
}): TournamentReport {
  return {
    label: input.label,
    createdAt: input.createdAt,
    champion: input.champion ?? null,
    scoreboard: input.scoreboard,
    bracketComplete: bracketIsComplete(input.bracket),
  };
}

export function serializeTournamentReport(report: TournamentReport): string {
  return canonicalJson(report);
}

export function parseTournamentReport(text: string): TournamentReport {
  const raw = JSON.parse(text) as TournamentReport;
  if (!raw || typeof raw !== "object" || typeof raw.label !== "string") {
    throw new Error("invalid tournament report");
  }
  return raw;
}

export function renderTournamentMarkdown(report: TournamentReport): string {
  const lines = [
    `# Tournament: ${report.label}`,
    "",
    `Created: ${report.createdAt}`,
    `Champion: ${report.champion ?? "(none)"}`,
    `Bracket complete: ${report.bracketComplete ? "yes" : "no"}`,
    "",
    "| Rank | Model | Rating | Wins | Played |",
    "| --- | --- | ---: | ---: | ---: |",
  ];
  const standings = [...report.scoreboard.standings].sort((a, b) => a.rank - b.rank);
  for (const row of standings) {
    lines.push(`| ${row.rank} | ${row.model} | ${row.rating} | ${row.wins} | ${row.played} |`);
  }
  return lines.join("\n");
}
