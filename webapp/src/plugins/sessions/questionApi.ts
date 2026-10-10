import { get, post } from "../../xuenessApi";

export type QuestionCard = { id: string; header: string; question: string; multiSelect: boolean; options: { label: string; description: string }[] };
export type QuestionCardAnswer = { selected: string[]; text: string };
export type QuestionCardAnswers = Record<string, QuestionCardAnswer>;
export type PendingQuestionRecord = { id: string; text: string; questions?: QuestionCard[] };
export type QuestionResponse = { id: string; enabled: boolean; question: PendingQuestionRecord | null };
export type AnswerResponse = { id: string; status: string; questionId: string; accepted: true; alreadyAnswered: boolean };

export function parseQuestionResponse(value: unknown, sessionId: string): QuestionResponse {
  const raw = value as Partial<QuestionResponse> | null;
  if (!raw || raw.id !== sessionId || typeof raw.enabled !== "boolean"
    || (raw.question !== null && (!raw.question || typeof raw.question.id !== "string" || !raw.question.id
      || typeof raw.question.text !== "string" || !raw.question.text.trim()))) {
    throw new Error("Invalid pending question response");
  }
  if (raw.question?.questions !== undefined) {
    const cards = raw.question.questions;
    if (!Array.isArray(cards) || cards.length < 1 || cards.length > 3) throw new Error("Invalid question cards");
    const ids = new Set<string>();
    for (const card of cards) {
      if (!card || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(card.id) || ids.has(card.id)
        || typeof card.header !== "string" || !card.header.trim() || Array.from(card.header).length > 12
        || typeof card.question !== "string" || !card.question.trim() || Array.from(card.question).length > 500
        || typeof card.multiSelect !== "boolean" || !Array.isArray(card.options)
        || (card.options.length > 0 && (card.options.length < 2 || card.options.length > 3))) throw new Error("Invalid question card");
      ids.add(card.id);
      const labels = new Set<string>();
      for (const option of card.options) {
        if (!option || typeof option.label !== "string" || !option.label.trim() || Array.from(option.label).length > 80
          || labels.has(option.label) || typeof option.description !== "string" || Array.from(option.description).length > 300) throw new Error("Invalid question choices");
        labels.add(option.label);
      }
    }
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

export async function answerQuestionCards(sessionId: string, questionId: string, answers: QuestionCardAnswers): Promise<AnswerResponse> {
  const raw = await post<AnswerResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/answer-question`, { questionId, answers });
  if (raw.id !== sessionId || raw.questionId !== questionId || raw.accepted !== true || typeof raw.alreadyAnswered !== "boolean") throw new Error("Invalid question answer response");
  return raw;
}

export function questionCardsComplete(cards: QuestionCard[], answers: QuestionCardAnswers): boolean {
  return cards.length > 0 && cards.every(card => {
    const answer = answers[card.id];
    return answer && Array.from(answer.text.trim()).length <= 1000
      && (answer.selected.length > 0 || answer.text.trim().length > 0)
      && new Set(answer.selected).size === answer.selected.length
      && (card.multiSelect || answer.selected.length <= 1)
      && answer.selected.every(label => card.options.some(option => option.label === label));
  });
}
