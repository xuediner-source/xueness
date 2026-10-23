/** Question cards and explicit answers, independent of appearance or permissions. */
import { isDict, pyCasefold, pyJsonDumps, pyLen, pySortKeys, pyStrip, PyValueError, type JsonSchema } from "@xueness/contracts";
type Row = Record<string, any>;
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export const QUESTION_SCHEMA: JsonSchema = {
  type: "array", minItems: 1, maxItems: 3,
  description: "Optional question cards. Never include an Other option: the UI always allows a custom answer. No choice is preselected.",
  items: { type: "object", additionalProperties: false, required: ["id", "header", "question"], properties: {
    id: { type: "string", description: "Unique stable identifier" }, header: { type: "string", maxLength: 12 }, question: { type: "string", maxLength: 500 }, multiSelect: { type: "boolean" },
    options: { type: "array", minItems: 2, maxItems: 3, items: { type: "object", additionalProperties: false, required: ["label", "description"], properties: { label: { type: "string", maxLength: 80 }, description: { type: "string", maxLength: 300 } } } },
  } },
};
function plain(value: unknown, limit: number, empty = false): string {
  if (typeof value !== "string" || pyLen(value) > limit || /[\x00-\x08\x0b-\x1f\ud800-\udfff]/u.test(value)) throw new PyValueError("invalid question text"); const text = pyStrip(value); if (!text && !empty) throw new PyValueError("question text must not be empty"); return text;
}
export function normalizeQuestions(value: unknown): Row[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new PyValueError("questions must contain 1..3 items"); const rows: Row[] = [], ids = new Set<string>();
  for (const item of value) {
    if (!isDict(item) || Object.keys(item).some((k) => !["id", "header", "question", "options", "multiSelect"].includes(k))) throw new PyValueError("invalid question fields");
    const key = item.id; if (typeof key !== "string" || !ID.test(key) || ids.has(key)) throw new PyValueError("question ids must be unique identifiers"); ids.add(key);
    const row: Row = { id: key, header: plain(item.header, 12), question: plain(item.question, 500), multiSelect: Object.hasOwn(item, "multiSelect") ? item.multiSelect : false };
    if (typeof row.multiSelect !== "boolean") throw new PyValueError("multiSelect must be boolean"); const options = Object.hasOwn(item, "options") ? item.options : []; if (!Array.isArray(options) || options.length && (options.length < 2 || options.length > 3)) throw new PyValueError("options must contain 2..3 choices");
    const labels = new Set<string>(), choices: Row[] = [];
    for (const option of options) {
      if (!isDict(option) || Object.keys(option).sort().join(",") !== "description,label") throw new PyValueError("each option needs a label and description"); const label = plain(option.label, 80), folded = pyCasefold(label);
      if (labels.has(folded) || ["other", "其他"].includes(folded)) throw new PyValueError("option labels must be unique; custom answers are provided by the UI"); labels.add(folded); choices.push({ label, description: plain(option.description, 300, true) });
    }
    row.options = choices; rows.push(row);
  }
  return rows;
}
export function pendingQuestions(s: Row): Row[] {
  if (s.status !== "awaiting_user" || !isDict(s.results) || !Array.isArray(s.messages)) return [];
  for (const m of [...s.messages].reverse()) if (isDict(m) && Array.isArray(m.tool_calls)) for (const c of [...m.tool_calls].reverse()) {
    if (!isDict(c) || typeof c.id !== "string" || !isDict(c.function) || c.function.name !== "ask_user") continue; const r = s.results[c.id];
    if (isDict(r) && r.awaiting_user === true && r.question === s.pending_question) { try { return Object.hasOwn(r, "questions") ? normalizeQuestions(r.questions) : []; } catch { return []; } }
  }
  return [];
}
export function normalizeAnswers(value: unknown): Row {
  if (!isDict(value) || Object.keys(value).length < 1 || Object.keys(value).length > 3) throw new PyValueError("answers must contain 1..3 question entries"); const answer: Row = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ID.test(key) || !isDict(item) || Object.keys(item).some((k) => !["selected", "text"].includes(k))) throw new PyValueError("invalid answer fields"); const raw = Object.hasOwn(item, "selected") ? item.selected : []; if (!Array.isArray(raw) || raw.length > 3) throw new PyValueError("invalid selected choices");
    const selected = raw.map((label) => plain(label, 80)); if (new Set(selected).size !== selected.length) throw new PyValueError("duplicate selected choices"); const text = plain(Object.hasOwn(item, "text") ? item.text : "", 1000, true); if (!selected.length && !text) throw new PyValueError("each question requires an explicit answer"); answer[key] = { selected: pySortKeys(selected), text };
  }
  return answer;
}
export function answerDigestSource(answers: Row): string { return "structured-question-answer\0" + pyJsonDumps(answers, { sortKeys: true, ensureAscii: true, separators: [",", ":"] }); }
export function formatQuestionAnswers(questions: Row[], answers: Row): string {
  if (!questions.length || pySortKeys(Object.keys(answers)).join("\0") !== pySortKeys(questions.map((r) => r.id as string)).join("\0")) throw new PyValueError("answer each question using its current id");
  return questions.map((row) => { const answer = answers[row.id], labels = row.options.map((v: Row) => v.label), selected = answer.selected;
    if (selected.some((choice: string) => !labels.includes(choice)) || !row.multiSelect && selected.length > 1) throw new PyValueError("selected choice does not match the current question"); const pieces = labels.filter((choice: string) => selected.includes(choice)); if (answer.text) pieces.push(answer.text); return `[${row.id}] ${row.header}: ${pieces.join("；")}`;
  }).join("\n");
}
