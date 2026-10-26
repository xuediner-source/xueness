---
name: ask-user-question
description: Ask concise structured questions when a task needs a human decision, confirmation or missing fact. Use Xueness question cards, respect answers and prior authorization, and avoid asking the same question again.
license: MIT
---

# Ask the user

Use Xueness's structured question tool for a missing fact, a choice among alternatives, or a confirmation that belongs to the user. Write the question and choices in the user's language.

## Xueness tools

- The standard model interface calls the tool `AskUserQuestion`.
- The lightweight interface calls it `ask_user`.
- Use the schema actually advertised in this conversation. Never invent `ask_user_question` if it is not listed.
- Keep the `planning` plugin enabled. Structured cards also require `sessions`. If the question tool is unavailable, ask one clearly labeled question in ordinary text.

## Cadence

One user message, one question card when a confirmation, choice, missing fact or unspecified next step needs an answer. Ask the decision that most affects the next action. Batch only independent blocking questions; Xueness accepts at most three cards and two or three options per card.

Do not ask again when the user already authorized the next step, said to continue, selected the recommended path, or asked you not to ask. Find facts available in the workspace with tools. Progress updates belong in the conversation. Do not invent forks or treat tool permission prompts as user questions.

## Ask, then follow the answer

1. Make the decision concrete and reviewable. Finish already authorized, reversible preparation first.
2. Ask one sentence. Keep the header at most 12 characters and labels short. Add a one-sentence consequence for each option.
3. Put the recommended option first, with the suffix ` (Recommended)`. Single-select is the default; use `multiSelect: true` only when answers can be combined.
4. Do not include an Other option; Xueness already provides custom text.
5. Stop work that depends on the answer. Continue independent work when useful.
6. Match the selected label exactly. Custom text takes precedence. No selection is not approval.

## Standard tool example

Call `AskUserQuestion` with the following shape (without a top-level `question`, explicit question ids or `multi_select`):

```json
{
  "questions": [{
    "header": "交付范围",
    "question": "这次交付包含哪个目标？",
    "options": [
      {"label": "本机验证 (Recommended)", "description": "完成本机修改与验证，保留可检查的结果。"},
      {"label": "推送仓库", "description": "验证完成后提交并推送已授权的仓库。"}
    ],
    "multiSelect": false
  }]
}
```

## Lightweight tool example

Call `ask_user` with a short `question` and optional structured `questions`. Each card needs a stable `id`, for example `delivery-scope`; use `multiSelect` rather than `multi_select`:

```json
{
  "question": "这次交付包含哪个目标？",
  "questions": [{
    "id": "delivery-scope",
    "header": "交付范围",
    "question": "这次交付包含哪个目标？",
    "options": [
      {"label": "本机验证 (Recommended)", "description": "完成本机修改与验证。"},
      {"label": "推送仓库", "description": "验证完成后推送已授权仓库。"}
    ],
    "multiSelect": false
  }]
}
```

The original portable skill is preserved in `references/upstream-SKILL.md`. Its generic examples and `lib/validate.js` helper describe a different host contract; use the Xueness schemas above for live calls. The skill does not execute helper scripts or make permission decisions itself.
