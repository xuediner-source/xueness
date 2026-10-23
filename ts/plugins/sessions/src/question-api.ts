/** Idempotent answer admission is fenced by the exact pending ask occurrence. */
import { createHash } from "node:crypto";
import { answerSession } from "@xueness/agent";
import { isDict, pyEncodeUtf8, pyLen, pyStrip } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName } from "@xueness/sessions";
import { questionIdentity } from "./question-id.ts";
import { externalRun, sessionBusy, validateWorkspace } from "./queue-http.ts";
import { answerDigestSource, formatQuestionAnswers, normalizeAnswers, pendingQuestions } from "./structured-questions.ts";
import type { SessionReply, SessionsApiOptions } from "./http-api.ts";
type Row = Record<string, any>;
export const QUESTION_ROUTES = ["GET /api/sessions/:id/question", "POST /api/sessions/:id/answer-question", "POST /api/sessions/:id/question-query"];
const feature = "sessions.answer_question_experimental";
const error = (status: number, message: string, code: string): SessionReply => [status, { error: message, errorCode: "sessions.answer_question." + code }];

type PreparedAnswer = { questionId: string; structured: boolean; answers: Row | null; normalized: string; hash: string };
type AnswerPreparation = { answer: PreparedAnswer } | { reply: SessionReply };
function prepareAnswer(data: unknown): AnswerPreparation {
  if (!isDict(data) || !["answer,questionId", "answers,questionId"].includes(Object.keys(data).sort().join(","))) {
    return { reply: error(400, "expected questionId and either answer or answers", "invalid_request") };
  }
  const questionId = data.questionId, structured = Object.hasOwn(data, "answers");
  if (typeof questionId !== "string" || !/^q-[0-9a-f]{64}$/.test(questionId)) {
    return { reply: error(400, "invalid questionId", "invalid_request") };
  }
  if (!structured && typeof data.answer !== "string") {
    return { reply: error(400, "answer must be 1..5000 characters", "invalid_answer") };
  }
  try {
    const answers = structured ? normalizeAnswers(data.answers) : null;
    const normalized = structured ? answerDigestSource(answers!) : pyStrip(data.answer as string);
    if (!structured && (pyLen(normalized) < 1 || pyLen(normalized) > 5000)) {
      return { reply: error(400, "answer must be 1..5000 characters", "invalid_answer") };
    }
    const hash = createHash("sha256").update(pyEncodeUtf8(normalized)).digest("hex");
    return { answer: { questionId, structured, answers, normalized, hash } };
  } catch (e) {
    if (pyExceptionName(e) === "UnicodeEncodeError") return { reply: error(400, "answer must be valid UTF-8", "invalid_answer") };
    if (isPyValueError(e)) return { reply: error(400, (e as Error).message, "invalid_answer") };
    throw e;
  }
}

export function createQuestionApi(o: SessionsApiOptions) {
  const structuredAllowed = () => o.enabled("sessions") && o.enabled("planning");
  const enabled = () => { const general = o.lifecycle?.settings?.().general; return o.enabled("sessions") && isDict(general) && general.sessionsAnswerQuestionEnabled === true; };

  const post = async (sid: string, data: unknown): Promise<SessionReply | null> => {
    const prepared = prepareAnswer(data);
    if ("reply" in prepared) return prepared.reply;
    const { questionId: id, structured, answers, hash } = prepared.answer;
    let normalized = prepared.answer.normalized;
    if (structured ? !structuredAllowed() : !enabled()) return [403, { error: feature + " not enabled", feature }];
    if (o.running?.has(sid)) return error(409, "session run already in progress", "session_busy");
    if (await externalRun(o, sid)) return sessionBusy();
    try {
      const lease = await o.store.lease(sid);
      try {
        if (structured ? !structuredAllowed() : !enabled()) return [403, { error: feature + " not enabled", feature }];
        const s = await o.store.load(sid), questions = pendingQuestions(s);
        try { await validateWorkspace(o, s); } catch { return error(400, "workspace root not permitted", "workspace_not_permitted"); }
        const records = Object.hasOwn(s, "question_answer_records") ? s.question_answer_records : {};
        if (!isDict(records)) return error(409, "answer history is invalid", "state_invalid");
        const previous = records[id];
        if (previous != null) {
          if (typeof previous !== "string" || !/^[0-9a-f]{64}$/.test(previous)) return error(409, "answer history is invalid", "state_invalid");
          if (previous !== hash) return error(409, "question already has a different answer", "answer_conflict");
          return [200, { id: sid, status: s.status ?? null, questionId: id, accepted: true, alreadyAnswered: true }];
        }
        const text = s.pending_question, current = s.status === "awaiting_user" && typeof text === "string" && pyStrip(text) ? questionIdentity(s, text) : null;
        if (current !== id) return error(409, "question is stale", "question_stale");
        if (structured) {
          if (!structuredAllowed()) return [403, { error: "structured questions are unavailable", feature: "sessions.structured_questions" }];
          try { normalized = formatQuestionAnswers(questions, answers!); }
          catch (e) { if (isPyValueError(e)) return error(400, (e as Error).message, "invalid_answer"); throw e; }
        } else if (!enabled()) return [403, { error: feature + " not enabled", feature }];
        records[id] = hash;
        s.question_answer_records = records;
        const result = o.lifecycle?.answerSession ? await o.lifecycle.answerSession(s, normalized) : await answerSession(s, o.store, normalized);
        return [200, { id: sid, status: result.status ?? null, questionId: id, accepted: true, alreadyAnswered: false }];
      } finally { await lease.release(); }
    } catch (e) {
      const name = pyExceptionName(e);
      if (name === "BlockingIOError") return error(409, "session is in use by another process", "session_busy");
      if (name === "FileNotFoundError") return [404, { error: "session not found" }];
      if (isPyOSError(e)) return error(503, "could not save the answer", "storage_unavailable");
      if (isPyValueError(e)) return error(409, "session state changed; refresh the question", "question_stale");
      throw e;
    }
  };

  const query = async (sid: string, data: unknown): Promise<SessionReply> => {
    const prepared = prepareAnswer(data);
    if ("reply" in prepared) return prepared.reply;
    const { questionId, hash } = prepared.answer;
    if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
    if (await externalRun(o, sid)) return sessionBusy();
    let s: Row;
    try { s = await o.store.load(sid); }
    catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
    try { await validateWorkspace(o, s); }
    catch { return error(400, "workspace root not permitted", "workspace_not_permitted"); }
    const records = Object.hasOwn(s, "question_answer_records") ? s.question_answer_records : {};
    if (!isDict(records)) return error(409, "answer history is invalid", "state_invalid");
    const previous = records[questionId];
    if (previous != null && (typeof previous !== "string" || !/^[0-9a-f]{64}$/.test(previous))) {
      return error(409, "answer history is invalid", "state_invalid");
    }
    return [200, { id: sid, status: s.status ?? null, questionId, result: previous === hash ? "accepted" : "unknown" }];
  };

  const owns = (method: string, p: readonly string[]) => p[0] === "api" && p[1] === "sessions" && p.length === 4
    && /^[0-9a-f]{32}$/.test(p[2]!) && (method === "GET" && p[3] === "question"
      || method === "POST" && ["answer-question", "question-query"].includes(p[3]!));
  return { routes: QUESTION_ROUTES, owns,
    async dispatch(method: string, p: string[], _query: Row, data: unknown): Promise<SessionReply | null> {
      if (!owns(method, p)) return null;
      if (!o.enabled("sessions")) return [403, { error: "plugin disabled or dependency unavailable: sessions", plugin: "sessions" }];
      const sid = p[2]!;
      if (method === "POST") return p[3] === "question-query" ? query(sid, data) : post(sid, data);
      if (await externalRun(o, sid)) return sessionBusy();
      let s: Row;
      try { s = await o.store.load(sid); }
      catch (e) { if (isPyOSError(e) || isPyValueError(e)) return [404, { error: "session not found" }]; throw e; }
      try { await validateWorkspace(o, s); }
      catch { return error(400, "workspace root not permitted", "workspace_not_permitted"); }
      const allowed = structuredAllowed(), questions = allowed ? pendingQuestions(s) : [], active = enabled() || allowed && questions.length > 0, text = s.pending_question;
      const question = active && s.status === "awaiting_user" && typeof text === "string" && pyStrip(text)
        ? { id: questionIdentity(s, text), text, ...(questions.length ? { questions } : {}) } : null;
      return [200, { id: sid, enabled: active, question }];
    } };
}
