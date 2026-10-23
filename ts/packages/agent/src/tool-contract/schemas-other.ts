/**
 * ZCode v3.15.1 (aac4755, Apache-2.0) model-facing input schemas, generated from
 * `apps/zcode-cli/packages/contracts/src/tools/*.ts` through its `toToolJsonSchema`
 * (zod 3.25.76 + zod-to-json-schema 3.25.2); `$schema` dropped. Do not edit by hand.
 */
import type { JsonSchema } from "@xueness/contracts";

export const BASH_SCHEMA = {
 "type": "object",
 "properties": {
  "command": {
   "type": "string",
   "description": "The command to execute"
  },
  "timeout": {
   "type": "number",
   "description": "Optional timeout in milliseconds (max 600000)"
  },
  "description": {
   "type": "string",
   "description": "Clear, concise description of what this command does in active voice. Never use words like \"complex\" or \"risk\" in the description - just describe what it does.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls → \"List files in current directory\"\n- git status → \"Show working tree status\"\n- npm install → \"Install package dependencies\"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n- find . -name \"*.tmp\" -exec rm {} \\; → \"Find and delete all .tmp files recursively\"\n- git reset --hard origin/main → \"Discard all local changes and match remote main\"\n- curl -s url | jq '.data[]' → \"Fetch JSON from URL and extract data array elements\""
  },
  "run_in_background": {
   "type": "boolean",
   "description": "Set to true to run this command in the background."
  },
  "dangerouslyDisableSandbox": {
   "type": "boolean",
   "description": "Set this to true to dangerously override sandbox mode and run commands without sandboxing."
  }
 },
 "required": [
  "command"
 ],
 "additionalProperties": false
} as unknown as JsonSchema;

export const TODOREAD_SCHEMA = {
 "type": "object",
 "properties": {},
 "additionalProperties": false
} as unknown as JsonSchema;

export const TODOWRITE_SCHEMA = {
 "type": "object",
 "properties": {
  "todos": {
   "type": "array",
   "items": {
    "type": "object",
    "properties": {
     "content": {
      "type": "string",
      "minLength": 1,
      "description": "Brief description of the task"
     },
     "status": {
      "type": "string",
      "enum": [
       "pending",
       "in_progress",
       "completed"
      ],
      "description": "Current status of the task"
     },
     "priority": {
      "type": "string",
      "enum": [
       "high",
       "medium",
       "low"
      ],
      "description": "Priority level of the task"
     }
    },
    "required": [
     "content",
     "status",
     "priority"
    ],
    "additionalProperties": false
   },
   "description": "The complete updated todo list. At most one item may be in_progress at a time."
  }
 },
 "required": [
  "todos"
 ],
 "additionalProperties": false
} as unknown as JsonSchema;

export const EXITPLANMODE_SCHEMA = {
 "type": "object",
 "properties": {
  "plan": {
   "type": "string",
   "minLength": 1,
   "maxLength": 20000,
   "description": "The implementation plan to present to the user for approval."
  },
  "allowedPrompts": {
   "type": "array",
   "items": {
    "type": "object",
    "properties": {
     "tool": {
      "type": "string",
      "enum": [
       "Bash"
      ],
      "description": "The tool this prompt applies to"
     },
     "prompt": {
      "type": "string",
      "description": "Semantic description of the action, e.g. \"run tests\", \"install dependencies\""
     }
    },
    "required": [
     "tool",
     "prompt"
    ],
    "additionalProperties": false
   },
   "description": "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands."
  }
 },
 "required": [
  "plan"
 ],
 "additionalProperties": {}
} as unknown as JsonSchema;

export const TASKOUTPUT_SCHEMA = {
 "type": "object",
 "properties": {
  "task_id": {
   "type": "string",
   "description": "The task ID to get output from"
  },
  "block": {
   "type": "boolean",
   "default": true,
   "description": "Whether to wait for completion"
  },
  "timeout": {
   "type": "number",
   "minimum": 0,
   "maximum": 600000,
   "default": 30000,
   "description": "Max wait time in ms"
  }
 },
 "required": [
  "task_id",
  "block",
  "timeout"
 ],
 "additionalProperties": false
} as unknown as JsonSchema;

export const TASKSTOP_SCHEMA = {
 "type": "object",
 "properties": {
  "task_id": {
   "type": "string",
   "description": "The ID of the background task to stop"
  },
  "shell_id": {
   "type": "string",
   "description": "Deprecated: use task_id instead"
  }
 },
 "additionalProperties": false
} as unknown as JsonSchema;

export const ASKUSERQUESTION_SCHEMA = {
 "type": "object",
 "properties": {
  "questions": {
   "type": "array",
   "items": {
    "type": "object",
    "properties": {
     "question": {
      "type": "string",
      "description": "The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: \"Which library should we use for date formatting?\" If multiSelect is true, phrase it accordingly, e.g. \"Which features do you want to enable?\""
     },
     "header": {
      "type": "string",
      "description": "Very short label displayed as a chip/tag (max 12 chars). Examples: \"Auth method\", \"Library\", \"Approach\"."
     },
     "options": {
      "type": "array",
      "items": {
       "type": "object",
       "properties": {
        "label": {
         "type": "string",
         "description": "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice."
        },
        "description": {
         "type": "string",
         "description": "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications."
        },
        "preview": {
         "type": "string",
         "description": "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format."
        }
       },
       "required": [
        "label",
        "description"
       ],
       "additionalProperties": false
      },
      "minItems": 2,
      "maxItems": 4,
      "description": "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically."
     },
     "multiSelect": {
      "type": "boolean",
      "default": false,
      "description": "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive."
     }
    },
    "required": [
     "question",
     "header",
     "options",
     "multiSelect"
    ],
    "additionalProperties": false
   },
   "minItems": 1,
   "maxItems": 4,
   "description": "Questions to ask the user (1-4 questions)"
  },
  "answers": {
   "type": "object",
   "additionalProperties": {
    "type": "string"
   },
   "description": "User answers collected by the permission component",
   "propertyNames": {
    "type": "string"
   }
  },
  "annotations": {
   "type": "object",
   "additionalProperties": {
    "type": "object",
    "properties": {
     "preview": {
      "type": "string",
      "description": "The preview content of the selected option, if the question used previews."
     },
     "notes": {
      "type": "string",
      "description": "Free-text notes the user added to their selection."
     }
    },
    "additionalProperties": false
   },
   "description": "Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.",
   "propertyNames": {
    "type": "string"
   }
  },
  "metadata": {
   "type": "object",
   "properties": {
    "source": {
     "type": "string",
     "description": "Optional identifier for the source of this question (e.g., \"remember\" for /remember command). Used for analytics tracking."
    }
   },
   "additionalProperties": false,
   "description": "Optional metadata for tracking and analytics purposes. Not displayed to user."
  }
 },
 "required": [
  "questions"
 ],
 "additionalProperties": false
} as unknown as JsonSchema;

export const ENTERPLANMODE_SCHEMA = {
 "type": "object",
 "properties": {},
 "additionalProperties": false
} as unknown as JsonSchema;
