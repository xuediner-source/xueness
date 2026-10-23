/**
 * ZCode v3.15.1 (aac4755, Apache-2.0) model-facing input schemas, generated from
 * `apps/zcode-cli/packages/contracts/src/tools/*.ts` through its `toToolJsonSchema`
 * (zod 3.25.76 + zod-to-json-schema 3.25.2); `$schema` dropped. Do not edit by hand.
 */
import type { JsonSchema } from "@xueness/contracts";

export const READ_SCHEMA = {
 "type": "object",
 "properties": {
  "file_path": {
   "type": "string",
   "description": "The absolute path to the file to read"
  },
  "offset": {
   "type": "integer",
   "minimum": 0,
   "maximum": 9007199254740991,
   "description": "The line number to start reading from. Only provide if the file is too large to read at once"
  },
  "limit": {
   "type": "integer",
   "exclusiveMinimum": 0,
   "maximum": 9007199254740991,
   "description": "The number of lines to read. Only provide if the file is too large to read at once."
  }
 },
 "required": [
  "file_path"
 ],
 "additionalProperties": false
} as unknown as JsonSchema;

export const WRITE_SCHEMA = {
 "type": "object",
 "properties": {
  "file_path": {
   "type": "string",
   "description": "The absolute path to the file to write (must be absolute, not relative)"
  },
  "content": {
   "type": "string",
   "description": "The content to write to the file"
  }
 },
 "required": [
  "file_path",
  "content"
 ],
 "additionalProperties": false
} as unknown as JsonSchema;

export const EDIT_SCHEMA = {
 "type": "object",
 "properties": {
  "file_path": {
   "type": "string",
   "description": "The absolute path to the file to modify"
  },
  "old_string": {
   "type": "string",
   "description": "The text to replace"
  },
  "new_string": {
   "type": "string",
   "description": "The text to replace it with (must be different from old_string)"
  },
  "replace_all": {
   "type": "boolean",
   "default": false,
   "description": "Replace all occurrences of old_string (default false)"
  }
 },
 "required": [
  "file_path",
  "old_string",
  "new_string"
 ],
 "additionalProperties": false
} as unknown as JsonSchema;

export const GLOB_SCHEMA = {
 "type": "object",
 "properties": {
  "pattern": {
   "type": "string",
   "description": "The glob pattern to match files against"
  },
  "path": {
   "type": "string",
   "description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided."
  }
 },
 "required": [
  "pattern"
 ],
 "additionalProperties": false
} as unknown as JsonSchema;

export const GREP_SCHEMA = {
 "type": "object",
 "properties": {
  "pattern": {
   "type": "string",
   "description": "The regular expression pattern to search for in file contents"
  },
  "path": {
   "type": "string",
   "description": "File or directory to search in (rg PATH). Defaults to current working directory."
  },
  "glob": {
   "type": "string",
   "description": "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob"
  },
  "output_mode": {
   "type": "string",
   "enum": [
    "content",
    "files_with_matches",
    "count"
   ],
   "description": "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\"."
  },
  "-B": {
   "type": "number",
   "description": "Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise."
  },
  "-A": {
   "type": "number",
   "description": "Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise."
  },
  "-C": {
   "type": "number",
   "description": "Alias for context."
  },
  "context": {
   "type": "number",
   "description": "Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise."
  },
  "-n": {
   "type": "boolean",
   "description": "Show line numbers in output (rg -n). Requires output_mode: \"content\", ignored otherwise. Defaults to true."
  },
  "-i": {
   "type": "boolean",
   "description": "Case insensitive search (rg -i)"
  },
  "-o": {
   "type": "boolean",
   "description": "Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: \"content\", ignored otherwise. Defaults to false."
  },
  "type": {
   "type": "string",
   "description": "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types."
  },
  "head_limit": {
   "type": "number",
   "description": "Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context)."
  },
  "offset": {
   "type": "number",
   "description": "Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0."
  },
  "multiline": {
   "type": "boolean",
   "description": "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false."
  }
 },
 "required": [
  "pattern"
 ],
 "additionalProperties": false
} as unknown as JsonSchema;

/** ZCode `ReadPdfInputJsonSchema`: the Read schema plus `pages`, for models that take PDFs. */
export const READ_PDF_SCHEMA = { ...READ_SCHEMA, properties: { ...READ_SCHEMA.properties,
  pages: { type: "string", description: 'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.' } } };
