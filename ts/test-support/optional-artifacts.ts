/** Offline fixtures use distributable bytes, never the developer's plugin tree. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { optionalArtifact, type OptionalArtifact } from "@xueness/kernel";
import { storeOfficialArtifact } from "../plugins/extensions/src/official-install.ts";
import { installAll } from "../plugins/extensions/src/sdk.ts";

export function artifactBytes(artifact: OptionalArtifact): Buffer {
  return readFileSync(join(resolve(import.meta.dirname, "../.."), "marketplace/packages", new URL(artifact.url).pathname.split("/").at(-1)!));
}
export function installOptionalFixture(stateDir: string, id: string): void {
  const artifact = optionalArtifact(id);
  if (!artifact) throw new Error(`Missing optional artifact ${id}; build the webapp first`);
  storeOfficialArtifact(stateDir, artifact, artifactBytes(artifact));
  const result = installAll(stateDir, [{ id: artifact.packageId, version: artifact.version, apiVersion: 1, builtin: id, capabilities: [], enabled: false }]);
  if (!result.ok) throw new Error(result.errors.join("; "));
}
