/**
 * Validate a structured question batch against the skill contract.
 * Pure helpers — no host APIs.
 */

const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const RECOMMENDED = " (Recommended)";

export function isKebabId(id) {
	return typeof id === "string" && ID_RE.test(id);
}

export function hasRecommendedSuffix(label) {
	return typeof label === "string" && label.endsWith(RECOMMENDED);
}

export function recommendedFirst(options) {
	if (!Array.isArray(options) || options.length === 0) return false;
	return hasRecommendedSuffix(options[0].label);
}

export function validateQuestion(question, { requireRecommended = true } = {}) {
	const errors = [];
	if (!question || typeof question !== "object") return ["question must be an object"];
	if (!isKebabId(question.id)) errors.push("id must be kebab-case");
	if (typeof question.question !== "string" || !question.question.trim()) errors.push("question text is required");
	if (typeof question.header !== "string" || !question.header.trim()) errors.push("header is required");
	if (!Array.isArray(question.options) || question.options.length < 2) errors.push("at least 2 options are required");
	else {
		const labels = new Set();
		for (const opt of question.options) {
			if (!opt || typeof opt.label !== "string" || !opt.label.trim()) errors.push("option label is required");
			else if (labels.has(opt.label)) errors.push("duplicate option label: " + opt.label);
			else labels.add(opt.label);
			if (!opt || typeof opt.description !== "string" || !opt.description.trim()) errors.push("option description is required");
		}
		if (requireRecommended && !recommendedFirst(question.options)) {
			errors.push("recommended option must be first and end with ' (Recommended)'");
		}
	}
	if (question.multi_select != null && typeof question.multi_select !== "boolean") {
		errors.push("multi_select must be boolean when set");
	}
	return errors;
}

export function validateBatch(payload) {
	const errors = [];
	if (!payload || typeof payload !== "object") return ["payload must be an object"];
	if (!Array.isArray(payload.questions) || payload.questions.length === 0) {
		return ["questions must be a non-empty array"];
	}
	if (payload.questions.length > 4) errors.push("at most 4 questions per turn");
	const ids = new Set();
	for (const q of payload.questions) {
		if (q && ids.has(q.id)) errors.push("duplicate question id: " + q.id);
		if (q && q.id) ids.add(q.id);
		errors.push(...validateQuestion(q).map((e) => (q && q.id ? q.id + ": " + e : e)));
	}
	return errors;
}

export function matchAnswer(question, answer) {
	if (!question || !answer) return { skipped: true };
	if (answer.id !== question.id) return { error: "id mismatch" };
	const custom = typeof answer.custom === "string" ? answer.custom.trim() : "";
	const selected = Array.isArray(answer.selected) ? answer.selected : [];
	if (selected.length === 0 && !custom) return { skipped: true };
	if (!question.multi_select && custom) return { custom, selected: [] };
	const labels = new Set((question.options || []).map((o) => o.label));
	for (const label of selected) {
		if (!labels.has(label)) return { error: "unknown label: " + label };
	}
	return { selected, custom: custom || undefined, skipped: false };
}
