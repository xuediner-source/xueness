/** Trusted owners are constructed after authorizing the workspace and journal. */
import { isAbsolute } from "node:path";
import { pyJsonDumps, pyLen, PyValueError } from "@xueness/contracts";
import { realish } from "@xueness/sessions";
export const OWNER_KINDS = new Set(["draft", "admission", "queue", "steering", "message", "fork", "provider_pin"]);
export class Owner {
  readonly kind: string;
  readonly key: string;
  readonly root: string;
  readonly sessionId: string | null;
  constructor(kind: string, key: string, root: string, sessionId: string | null = null) {
    if (!OWNER_KINDS.has(kind)) throw new PyValueError("invalid media owner kind");
    for (const value of [key, root]) if (typeof value !== "string" || !value || pyLen(value) > 4096 || value.includes("\0")) throw new PyValueError("invalid media owner scope");
    if (sessionId !== null && (typeof sessionId !== "string" || !sessionId || pyLen(sessionId) > 256)) throw new PyValueError("invalid media session");
    if (!isAbsolute(root)) throw new PyValueError("media owner root must be absolute");
    this.kind = kind; this.key = key; this.root = realish(root); this.sessionId = sessionId;
    Object.freeze(this);
  }
  token(): string { return pyJsonDumps([this.kind, this.key, this.root, this.sessionId], { ensureAscii: true, separators: [",", ":"] }); }
}
