/** Private, plugin-owned WorkBuddy credentials under `<stateDir>/workbuddy/auths`. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "./layout.ts";
type Dict = Record<string, unknown>;

export interface WorkbuddyAccountMetadata {
  id: string;
  uid: string;
  nickname: string;
}

interface WorkbuddyCredentials {
  account: { uid: string; nickname: string; enterpriseId: string };
  auth: { accessToken: string; refreshToken: string; domain: string; expiresAt: number };
}

interface StoredAccount extends WorkbuddyAccountMetadata {
  fileName: string;
  credentials: WorkbuddyCredentials;
}

export class WorkbuddyCredentialError extends Error {
  override name = "WorkbuddyCredentialError";
  constructor() { super("invalid WorkBuddy credentials"); }
}

export class WorkbuddyAccountNotFoundError extends Error {
  override name = "WorkbuddyAccountNotFoundError";
  constructor() { super("WorkBuddy account not found"); }
}

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Copy only the gateway's documented fields; never persist arbitrary input fields. */
function normalizeCredentials(value: unknown): WorkbuddyCredentials {
  if (!isDict(value) || !isDict(value.account) || !isDict(value.auth)) throw new WorkbuddyCredentialError();
  const account = value.account, auth = value.auth;
  if (!requiredText(account.uid) || !requiredText(auth.accessToken) || !requiredText(auth.refreshToken)) throw new WorkbuddyCredentialError();
  return {
    account: { uid: account.uid.trim(), nickname: typeof account.nickname === "string" ? account.nickname : "", enterpriseId: typeof account.enterpriseId === "string" ? account.enterpriseId : "" },
    auth: { accessToken: auth.accessToken, refreshToken: auth.refreshToken, domain: typeof auth.domain === "string" ? auth.domain : "", expiresAt: typeof auth.expiresAt === "number" && Number.isFinite(auth.expiresAt) ? auth.expiresAt : 0 },
  };
}

function opaqueId(fileName: string): string {
  return createHash("sha256").update(fileName, "utf8").digest("hex").slice(0, 24);
}

function privateDirectory(path: string, create: boolean): boolean {
  if (!existsSync(path)) {
    if (!create) return false;
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("WorkBuddy account directory is not a private directory");
  return true;
}

/** Safe local metadata plus private file operations for the WorkBuddy account panel. */
export class WorkbuddyAccountStore {
  readonly directory: string;

  constructor(layout: Layout) { this.directory = layout.auths; }

  #stored(): StoredAccount[] {
    if (!privateDirectory(this.directory, false)) return [];
    const result: StoredAccount[] = [];
    for (const fileName of readdirSync(this.directory).filter((name) => name.endsWith(".json")).sort()) {
      const path = join(this.directory, fileName);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(path, "utf8")); }
      catch (error) {
        if (error instanceof SyntaxError) continue;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let credentials: WorkbuddyCredentials;
      try { credentials = normalizeCredentials(parsed); }
      catch (error) {
        if (error instanceof WorkbuddyCredentialError) continue;
        throw error;
      }
      result.push({
        id: opaqueId(fileName), uid: credentials.account.uid, nickname: credentials.account.nickname,
        fileName, credentials,
      });
    }
    return result;
  }

  list(): WorkbuddyAccountMetadata[] {
    return this.#stored().map(({ id, uid, nickname }) => ({ id, uid, nickname }));
  }

  save(value: unknown): WorkbuddyAccountMetadata {
    const credentials = normalizeCredentials(value);
    privateDirectory(this.directory, true);
    const existing = this.#stored().find((item) => item.uid === credentials.account.uid);
    const fileName = existing?.fileName ?? `${randomUUID()}.json`;
    const target = join(this.directory, fileName);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, target);
    } finally {
      try { unlinkSync(temporary); } catch { /* already renamed or absent */ }
    }
    return { id: opaqueId(fileName), uid: credentials.account.uid, nickname: credentials.account.nickname };
  }

  delete(id: string): void {
    if (!/^[a-f0-9]{24}$/u.test(id)) throw new WorkbuddyAccountNotFoundError();
    const account = this.#stored().find((item) => item.id === id);
    if (!account) throw new WorkbuddyAccountNotFoundError();
    unlinkSync(join(this.directory, account.fileName));
  }

  /** Remove credential values and JSON payloads from gateway-provided error text. */
  safeStatusText(uid: string, value: unknown): string | null {
    if (typeof value !== "string") return null;
    let text = value.trim();
    if (!text || /[{}\[\]]/u.test(text) || /"?(?:accessToken|refreshToken|authorization|token)"?\s*:/iu.test(text)) return null;
    const account = this.#stored().find((item) => item.uid === uid);
    for (const secret of [account?.credentials.auth.accessToken, account?.credentials.auth.refreshToken]) {
      if (secret) text = text.split(secret).join("[redacted]");
    }
    text = text.replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]").replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]");
    return text.slice(0, 500) || null;
  }
}
