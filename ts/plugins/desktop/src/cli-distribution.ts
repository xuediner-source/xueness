/** Data-only release contract for the desktop-owned standalone CLI installer. */
export const CLI_INSTALL_URL = "https://raw.githubusercontent.com/xuediner-source/xueness/main/install.ps1";
export interface CliArtifact { version: string; sourceCommit: string; file: string; sha256: string; bytes: number; nodeVersion: string }
export function cliReleaseManifest(artifact: CliArtifact) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(artifact.version) || !/^[a-f0-9]{40}$/.test(artifact.sourceCommit)
    || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !/^xueness-cli-[0-9A-Za-z.-]+-windows-x64\.zip$/.test(artifact.file)) throw new Error("Invalid CLI release artifact");
  return { schemaVersion: 1, version: artifact.version, sourceCommit: artifact.sourceCommit, nodeVersion: artifact.nodeVersion,
    platforms: { "windows-x64": { url: `https://github.com/xuediner-source/xueness/releases/download/cli-v${artifact.version}/${artifact.file}`, sha256: artifact.sha256, bytes: artifact.bytes } } };
}
