import { t } from '../../i18n';

const JSON_PROTOCOL_ERROR = 'The local model could not follow the configured JSON tool protocol within the configured response limit.';

export type CompletionPresentationInput = {
  verified: boolean;
  summary: string;
  status?: "verified" | "unverified" | "not_applicable";
  toolExecutionStatus?: "succeeded" | "failed" | "incomplete" | "not_applicable";
  deliveryStatus?: "passed" | "failed" | "not_assessed";
  turnId?: string;
};

export type ProtocolAnswerEnvelope = { answer: string; evidence: unknown[] };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function protocolAnswerEnvelope(value: unknown): ProtocolAnswerEnvelope | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Array.isArray(value.evidence)) return undefined;
  if (typeof value.summary === 'string' && Object.hasOwn(value, 'summary')) return { answer: value.summary, evidence: value.evidence };
  if (typeof value.answer === 'string' && Object.hasOwn(value, 'answer')) return { answer: value.answer, evidence: value.evidence };
  return undefined;
}

/**
 * Safely decodes string escape sequences from a JSON string fragment.
 * Correctly preserves Windows paths (e.g. C:\models or C:\\models or C:\\notes).
 * Single pass: an escaped backslash '\\' will not cause subsequent characters (like 'n') to be re-interpreted.
 * Non-standard escapes like '\m' in 'C:\models' are preserved as '\m' rather than breaking or erroring.
 */
export function decodeJsonStringFragment(raw: string): string {
  let output = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === '"') {
        output += '"';
        i += 2;
      } else if (next === '\\') {
        output += '\\';
        i += 2;
      } else if (next === '/') {
        output += '/';
        i += 2;
      } else if (next === 'b') {
        output += '\b';
        i += 2;
      } else if (next === 'f') {
        output += '\f';
        i += 2;
      } else if (next === 'n') {
        output += '\n';
        i += 2;
      } else if (next === 'r') {
        output += '\r';
        i += 2;
      } else if (next === 't') {
        output += '\t';
        i += 2;
      } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
        output += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
        i += 6;
      } else {
        // Non-standard escape, e.g. raw Windows path like C:\models or \p
        output += '\\' + next;
        i += 2;
      }
    } else if (raw[i] === '\\') {
      // Trailing dangling backslash
      output += '\\';
      i += 1;
    } else {
      output += raw[i];
      i += 1;
    }
  }
  // Trim dangling high surrogate if incomplete at the end
  if (output.length > 0) {
    const last = output.charCodeAt(output.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      output = output.slice(0, -1);
    }
  }
  return output;
}

export type JsonTopLevelField = {
  key: string;
  rawVal: string;
  type: 'string' | 'array' | 'object' | 'primitive';
  closed: boolean;
};

export function parseTopLevelFields(source: string): { fields: JsonTopLevelField[]; isObject: boolean; hasTrailingCommaOrContent: boolean } | null {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith('{')) return null;

  const fields: JsonTopLevelField[] = [];
  let index = 1;
  let hasTrailingComma = false;

  const skipWhitespace = () => {
    while (index < trimmed.length && /\s/u.test(trimmed[index])) index += 1;
  };

  while (index < trimmed.length) {
    skipWhitespace();
    if (index >= trimmed.length) break;
    if (trimmed[index] === '}') {
      index += 1;
      skipWhitespace();
      break;
    }
    if (trimmed[index] === ',') {
      index += 1;
      hasTrailingComma = true;
      continue;
    }
    hasTrailingComma = false;

    // Expecting key: string
    if (trimmed[index] !== '"') {
      return { fields, isObject: true, hasTrailingCommaOrContent: true };
    }
    index += 1; // skip opening quote
    let key = '';
    let keyClosed = false;
    while (index < trimmed.length) {
      const c = trimmed[index];
      if (c === '"') {
        keyClosed = true;
        index += 1;
        break;
      }
      if (c === '\\' && index + 1 < trimmed.length) {
        key += decodeJsonStringFragment(trimmed.slice(index, index + 2));
        index += 2;
      } else {
        key += c;
        index += 1;
      }
    }
    if (!keyClosed) {
      return { fields, isObject: true, hasTrailingCommaOrContent: true };
    }

    skipWhitespace();
    if (index >= trimmed.length || trimmed[index] !== ':') {
      fields.push({ key, rawVal: '', type: 'primitive', closed: false });
      return { fields, isObject: true, hasTrailingCommaOrContent: false };
    }
    index += 1; // skip ':'
    skipWhitespace();

    if (index >= trimmed.length) {
      fields.push({ key, rawVal: '', type: 'primitive', closed: false });
      return { fields, isObject: true, hasTrailingCommaOrContent: false };
    }

    const firstChar = trimmed[index];
    if (firstChar === '"') {
      index += 1; // skip opening quote
      let rawVal = '';
      let valClosed = false;
      while (index < trimmed.length) {
        const c = trimmed[index];
        if (c === '"') {
          valClosed = true;
          index += 1;
          break;
        }
        if (c === '\\' && index + 1 < trimmed.length) {
          rawVal += trimmed.slice(index, index + 2);
          index += 2;
        } else {
          rawVal += c;
          index += 1;
        }
      }
      fields.push({ key, rawVal, type: 'string', closed: valClosed });
    } else if (firstChar === '[') {
      const start = index;
      let depth = 0;
      let inStr = false;
      let valClosed = false;
      while (index < trimmed.length) {
        const c = trimmed[index];
        if (inStr) {
          if (c === '\\' && index + 1 < trimmed.length) index += 2;
          else {
            if (c === '"') inStr = false;
            index += 1;
          }
        } else {
          if (c === '"') {
            inStr = true;
            index += 1;
          } else if (c === '[') {
            depth += 1;
            index += 1;
          } else if (c === ']') {
            depth -= 1;
            index += 1;
            if (depth === 0) {
              valClosed = true;
              break;
            }
          } else {
            index += 1;
          }
        }
      }
      fields.push({ key, rawVal: trimmed.slice(start, index), type: 'array', closed: valClosed });
    } else if (firstChar === '{') {
      const start = index;
      let depth = 0;
      let inStr = false;
      let valClosed = false;
      while (index < trimmed.length) {
        const c = trimmed[index];
        if (inStr) {
          if (c === '\\' && index + 1 < trimmed.length) index += 2;
          else {
            if (c === '"') inStr = false;
            index += 1;
          }
        } else {
          if (c === '"') {
            inStr = true;
            index += 1;
          } else if (c === '{') {
            depth += 1;
            index += 1;
          } else if (c === '}') {
            depth -= 1;
            index += 1;
            if (depth === 0) {
              valClosed = true;
              break;
            }
          } else {
            index += 1;
          }
        }
      }
      fields.push({ key, rawVal: trimmed.slice(start, index), type: 'object', closed: valClosed });
    } else {
      const start = index;
      while (index < trimmed.length && trimmed[index] !== ',' && trimmed[index] !== '}' && !/\s/u.test(trimmed[index])) {
        index += 1;
      }
      fields.push({ key, rawVal: trimmed.slice(start, index), type: 'primitive', closed: true });
    }
  }

  return { fields, isObject: true, hasTrailingCommaOrContent: hasTrailingComma || index < trimmed.length };
}

/** Unwrap an internal JSON protocol envelope (full or truncated prefix) to natural text. */
export function unwrapProtocolEnvelopeText(text: string, jsonToolProtocol = false): string {
  if (!text) return '';
  const trimmed = text.trim();
  if (!trimmed) return text;
  let body = trimmed;
  if (body.startsWith('```json')) {
    body = body.slice(7).replace(/^\r?\n/u, '').replace(/\r?\n```\s*$/u, '').trim();
  }
  if (body.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(body);
      const envelope = protocolAnswerEnvelope(parsed);
      if (envelope) return envelope.answer;
      // Complete valid JSON that does not match protocolAnswerEnvelope is ordinary JSON: never unwrap.
      return text;
    } catch {
      // Incomplete or truncated JSON.
      // Must NOT unwrap ordinary JSON by simple prefix matching.
      // Only extract when in protocol mode or conforming strictly to protocol envelope features.
      if (!jsonToolProtocol) return text;

      const parsedFields = parseTopLevelFields(body);
      if (!parsedFields) return text;
      const { fields, hasTrailingCommaOrContent } = parsedFields;

      // Check if any field key is outside {'answer', 'summary', 'evidence'}
      const hasForeignKeys = fields.some(f => f.key !== 'answer' && f.key !== 'summary' && f.key !== 'evidence');
      if (hasForeignKeys) {
        // Contains other fields (e.g. reasoning, confidence, affected_files, next_task, etc.)
        // Never discard these fields or strip the envelope!
        return text;
      }

      // An unfinished extra key is still user content, even after only one parsed field.
      if (fields.length > 2 || hasTrailingCommaOrContent) {
        return text;
      }

      const answerField = fields.find(f => f.key === 'answer' || f.key === 'summary');
      const evidenceField = fields.find(f => f.key === 'evidence');

      if (evidenceField) {
        // In a protocol envelope, evidence must be an array (starts with '[')
        if (evidenceField.type !== 'array') return text;
        // If evidence is present and answer is present, and no foreign fields:
        // This is a truncated protocol envelope.
        if (answerField && answerField.type === 'string') {
          return decodeJsonStringFragment(answerField.rawVal);
        }
      } else {
        // In explicit JSON tool protocol mode, an in-progress answer before evidence
        // has started being generated is validly unwrapped for display.
        if (fields.length === 1 && answerField && answerField.type === 'string') {
          return decodeJsonStringFragment(answerField.rawVal);
        }
      }
    }
  }
  return text;
}

/** A terminal record describes the run outcome; the assistant row owns the answer. */
export function completionPresentation(completion: CompletionPresentationInput, jsonToolProtocol = false) {
  if (completion.summary === JSON_PROTOCOL_ERROR) return {
    title: t('运行结束 · 模型工具协议失败'),
    status: 'error',
    label: t('工具协议错误'),
    summary: t('本地模型未能在响应限制内生成符合 JSON 工具协议的输出，本轮已停止。'),
    detailsOpen: true,
  };

  const rawSummary = completion.summary || '';
  const cleanSummary = unwrapProtocolEnvelopeText(rawSummary, jsonToolProtocol);

  if (completion.deliveryStatus === 'failed') return {
    title: t('交付检查未通过'),
    status: 'review',
    label: t('未通过验证'),
    summary: cleanSummary || t('无完成总结'),
    detailsOpen: true,
  };

  const hasToolFailure = completion.toolExecutionStatus === 'failed' || completion.toolExecutionStatus === 'incomplete';
  const doesNotNeedToolVerification = completion.status === 'not_applicable'
    || (completion.status === undefined && completion.toolExecutionStatus === 'not_applicable');
  if (doesNotNeedToolVerification && !hasToolFailure) return {
    title: t('运行结束'),
    status: 'ok',
    label: t('已完成'),
    summary: cleanSummary,
    detailsOpen: false,
  };

  const verified = completion.status !== undefined ? completion.status === 'verified' && !hasToolFailure : completion.verified && !hasToolFailure;
  return {
    title: t(verified ? '运行结束 · 工具成功证据通过' : '运行结束 · 工具证据未通过验证'),
    status: verified ? 'ok' : 'review',
    label: t(verified ? '已结束' : '未通过验证'),
    summary: cleanSummary || t('无完成总结'),
    detailsOpen: !verified,
  };
}

function extractPotentialAnswer(text: string, jsonToolProtocol = false): string | null {
  if (!jsonToolProtocol) return null;
  const parsedFields = parseTopLevelFields(text);
  if (!parsedFields) return null;
  const { fields, hasTrailingCommaOrContent } = parsedFields;
  const hasForeign = fields.some(f => f.key !== 'answer' && f.key !== 'summary' && f.key !== 'evidence');
  if (hasForeign) return null;
  if (fields.length > 2 || (fields.length === 2 && hasTrailingCommaOrContent)) return null;
  const answerField = fields.find(f => f.key === 'answer' || f.key === 'summary');
  const evidenceField = fields.find(f => f.key === 'evidence');
  if (!evidenceField || evidenceField.type !== 'array') return null;
  if (answerField && answerField.type === 'string') {
    return decodeJsonStringFragment(answerField.rawVal);
  }
  return null;
}

/** Suppress exact and truncated completion echoes while retaining an independent diagnostic. */
export function isDuplicateCompletionAnswer(summary: string, answer?: string, jsonToolProtocol = false): boolean {
  if (!summary.trim() || !answer?.trim()) return false;
  let sClean = unwrapProtocolEnvelopeText(summary, jsonToolProtocol);
  let aClean = unwrapProtocolEnvelopeText(answer, jsonToolProtocol);
  const comparable = (value: string) => value.trim().replace(/\s+/gu, ' ');
  let s = comparable(sClean).replace(/[.…]+$/u, '').trim();
  let a = comparable(aClean).replace(/[.…]+$/u, '').trim();
  if (!s || !a || (s !== a && !a.startsWith(s))) {
    // If one of them is wrapped in an unconfirmed protocol envelope echo of the other, check if extracting it matches
    const sExtracted = extractPotentialAnswer(summary, jsonToolProtocol);
    if (sExtracted) {
      const sCandidate = comparable(sExtracted).replace(/[.…]+$/u, '').trim();
      if (sCandidate === a || a.startsWith(sCandidate)) {
        s = sCandidate;
      }
    }
    const aExtracted = extractPotentialAnswer(answer, jsonToolProtocol);
    if (aExtracted) {
      const aCandidate = comparable(aExtracted).replace(/[.…]+$/u, '').trim();
      if (s === aCandidate || aCandidate.startsWith(s)) {
        a = aCandidate;
      }
    }
  }
  if (!s || !a) return false;
  if (s === a) return true;
  // Summary is a truncated prefix of answer (e.g. truncated at 120/200/500 chars or with ellipsis)
  if (a.startsWith(s) && (s.length >= 15 || s.length / a.length >= 0.2)) return true;
  return false;
}
