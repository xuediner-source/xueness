import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bashQuote, windowsPathToBashPath } from "./shell-snapshot.ts";

export interface MaterializedStartupScript {
  path: string;
  shellPath: string;
}

export class StartupScriptManager {
  private readonly managerId = randomBytes(8).toString("hex");
  private readonly cache = new Map<string, MaterializedStartupScript>();
  private readonly files = new Set<string>();
  private readonly directories = new Set<string>();

  async materialize(rootDir: string, content: string): Promise<MaterializedStartupScript> {
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 20);
    const cached = this.cache.get(`${rootDir}:${hash}`);
    if (cached) return cached;

    const directory = join(rootDir, "shell", `startup-${this.managerId}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.directories.add(directory);
    const path = join(directory, `${hash}.sh`);
    this.files.add(path);
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600).catch(() => {});
    const result = { path, shellPath: process.platform === "win32" ? windowsPathToBashPath(path) : path };
    this.cache.set(`${rootDir}:${hash}`, result);
    return result;
  }

  async cleanup(): Promise<void> {
    for (const path of this.files) {
      try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.files.clear();
    for (const path of this.directories) {
      try { await rmdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }
    }
    this.directories.clear();
  }
}

export function buildBashCommand(command: string, sources: readonly MaterializedStartupScript[]): string {
  return [
    "shopt -s expand_aliases",
    ...sources.map((source) => `. ${bashQuote(source.shellPath)}`),
    `eval ${bashQuote(command)}`,
  ].join("\n");
}
