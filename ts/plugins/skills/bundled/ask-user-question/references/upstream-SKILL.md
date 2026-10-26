---
name: ask-user-question
description: "Use whenever a task needs a human confirmation, a choice among alternatives, or a missing fact before continuing. Prefer the host's structured question tool (ask_user_question or equivalent) instead of guessing, chatting options as plain text, or blocking on permission UI. Cadence: about one question card per user turn. Applies to every model and every agent that has a question tool."
license: MIT
compatibility: "Any agent that can load SKILL.md and either call ask_user_question (or equivalent) or ask one labeled question per user turn."
metadata:
  author: xuediner-source
  version: "1.1.0"
---

# Ask the user

When the next step needs confirmation, a choice, or a missing fact, ask with a structured question tool. Do not guess. Do not bury options in ordinary chat if the host can show a choice card.

Common tool name: `ask_user_question`. Other agents may expose the same idea under another name. Use whatever structured question tool the host provides. If none exists, ask **one** clearly labeled question in the reply, still one per user turn.

Cadence: **one user message, one question**. Not zero questions for a whole task.

## Cadence (default)

- Each **user turn**, if there is a confirmation, a choice, a missing fact, or a next step, ask **exactly 1 question**. Ask the one that most affects what you do next.
- A good engineering default is not a reason to skip the question. Put that default first and mark it `(Recommended)`.
- If there is no big fork, still ask the next step (continue, verify, publish). Do not write "reply 1/2/3" in chat when a question tool exists.
- At most one question card per user turn. Put 2–4 questions in the same batch only when they are independent and all blocking.
- Stop asking for this turn and the following execution if the user says "don't ask", "do the recommended one", or "just do it".

## When you must ask

Ask first, then act, if any of these is missing:

1. **Confirmation**: whether to change it now, restart, publish.
2. **Fork**: two or more reasonable paths with different outcomes (overwrite, library, public vs private).
3. **Missing fact**: path, environment, account, scope, deadline — not in context and not discoverable by tools.
4. **Irreversible / expensive**: delete data, change production, push remote, spend quota, change user-visible wording.
5. **Preference**: tone, theme, drive-by refactors — do not invent a preference.
6. **Plan review**: when a plan needs approval, use the same question channel.
7. **Next step**: after the turn's work, if the user did not say what to do next, ask one closing question.

## When not to ask

- The user already locked the constraint (path, scope, "do the recommended one", "don't ask", "just do it").
- A tool can find the fact (git status, config, whether an API exists). Do not ask the user to confirm discovered facts.
- Progress updates belong in the reply, not in a choice card.
- Permission prompts (may this command run / may this path be written) belong to the host permission system, not this skill.
- This user turn already asked one question.
- Do not split one decision into five rounds to look careful.
- Do not invent fake forks. Every option must be a path you can actually take.

## Steps

1. **Stop**: do not write, commit, or deploy anything that depends on the answer.
2. **One question**: default to 1 question per turn. One thing per question. Stable short kebab-case ids (`target-env`, `overwrite-policy`). Do not rename an id inside one task.
3. **Write options, not an essay**:
   - `question`: one sentence naming the choice.
   - `header`: very short title for the card.
   - `options[]`: short `label`; one-line `description` of the consequence.
   - If there is a recommended option: **put it first** and append ` (Recommended)` to the label.
   - Exclusive choice = single select (default). Combinable = `multi_select: true`.
4. Call the host question tool (parameter names follow that host's schema; the shape below is the common one).
5. **Read the answer, then continue**:
   - Single select: `selected` is the chosen label array; if `custom` is present it **overrides** options (`selected` may be empty).
   - Multi select: `selected` is multiple labels; `custom` is extra, not an override.
   - A skipped item may be `{ id, selected: [] }`. Empty selected and no custom = skipped. Do not treat that as the recommended option.
6. Match the **exact label text**, not an index. Recommended options must match the full label including ` (Recommended)`.

## Call shape

```json
{
  "questions": [
    {
      "id": "deploy-target",
      "header": "Deploy target",
      "question": "Where should this change go?",
      "options": [
        {
          "label": "Local only (Recommended)",
          "description": "No remote push, no production change; stop on this machine."
        },
        {
          "label": "Push to GitHub",
          "description": "Commit and push; still no production deploy."
        },
        {
          "label": "Production",
          "description": "Remote and production; hard to undo."
        }
      ]
    }
  ]
}
```

Successful result (compact JSON; `custom` may be omitted):

```json
{ "answers": [{ "id": "deploy-target", "selected": ["Local only (Recommended)"] }] }
```

Custom single-select example: `{ "id": "deploy-target", "selected": [], "custom": "tag first, then decide" }`.

Write `question` / `label` in the user's language. Keep labels short. Keep the ` (Recommended)` suffix in English so hosts can recognize it.

## Several questions in one batch

Default: do not. Only batch 2–4 when they are independent and all block the next step.

- Later questions must not assume earlier answers (the user may skip one).
- If question B depends on A, ask A first, then B.

## Sub-agents

- The runtime root agent may ask.
- If the host rejects delegated callers, a sub-agent must put unresolved questions in its final result and let the parent ask.
- After session resume, a new runtime root may ask.

## Pitfalls

- **Blocking**: the call waits until the user answers or the turn is cancelled. Do not expect other tools in the same call to run during the wait.
- **No question provider**: if the structured tool fails because the host has none, fall back to one labeled question in the reply. Do not retry the missing tool in a loop.
- **Do not fake a card in chat** when the structured tool exists: other agents and automation cannot parse "please reply 1/2/3".
- **Do not turn permissions into questions**: dangerous commands go through the host permission prompt.
- **Options must be executable**: each label is a path you will take next. Do not offer "whatever" as the only option. Free-form answers use `custom`.
- **Stable ids**: reuse the same id across retries and plan revisions.

## vs other "please click" mechanisms

| Mechanism | Who starts it | Use |
|---|---|---|
| Structured question tool | model | confirm, choose, missing fact, next step, plan approval |
| Permission prompt | host | whether a tool/path may run |
| A question in ordinary prose | model text | last resort only; other agents cannot parse it |

## Checklist

Before calling:

- [ ] This user turn has not asked yet, and there is a confirmation / choice / missing fact / next step?
- [ ] Each question has a stable `id`, one-sentence `question`, and executable `options`?
- [ ] Recommended option is first and the label contains ` (Recommended)`?
- [ ] Not a permission, progress update, or a fact a tool can fetch?
- [ ] If a sub-agent cannot ask, the question is in its final result?

After the answer:

- [ ] Matched by `id`, then exact label (including Recommended) or `custom`?
- [ ] `selected: []` and no `custom` treated as skip, not as the recommended option?

## Machine-checkable contract

If you vendor this skill and want to lint question payloads, use `lib/validate.js`:

```js
import { validateBatch, matchAnswer } from "./lib/validate.js";
validateBatch(payload); // [] means ok
```

Rules the helper enforces:

- `id` is kebab-case (`^[a-z][a-z0-9-]{0,47}$`)
- at least 2 options; recommended option is **first** and ends with ` (Recommended)`
- at most 4 questions per turn
- empty `selected` and no `custom` = skip, never the recommended option

Worked examples live in `examples/`.
