import { get, post } from "../../xuenessApi";

export type PendingQuestionRecord = { id: string; text: string };
export type QuestionResponse = { id: string; enabled: boolean; question: PendingQuestionRecord | null };
export type AnswerResponse = { id: string; status: string; questionId: string; accepted: true; alreadyAnswered: boolean };

export function parseQuestionResponse(value: unknown, sessionId: string): QuestionResponse {
  const raw = value as Partial<QuestionResponse> | null;
  if (!raw || raw.id !== sessionId || typeof raw.enabled !== "boolean"
    || (raw.question !== null && (!raw.question || typeof raw.question.id !== "string" || !raw.question.id
      || typeof raw.question.text !== "string" || !raw.question.text.trim()))) {
    throw new Error("Invalid pending question response");
  }
  return raw as QuestionResponse;
}

export async function loadQuestion(sessionId: string, signal?: AbortSignal): Promise<QuestionResponse> {
  return parseQuestionResponse(await get<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/question`, signal), sessionId);
}

export async function answerQuestion(sessionId: string, questionId: string, answer: string): Promise<AnswerResponse> {
  const raw = await post<AnswerResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/answer-question`, { questionId, answer });
  if (raw.id !== sessionId || raw.questionId !== questionId || raw.accepted !== true || typeof raw.alreadyAnswered !== "boolean") {
    throw new Error("Invalid question answer response");
  }
  return raw;
}
