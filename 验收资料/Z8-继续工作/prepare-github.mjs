/** Stage the current Xueness source snapshot into a clean GitHub clone without committing. */
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const stageRoot = dirname(fileURLToPath(import.meta.url));
const source = resolve(stageRoot, 'Xueness-0.1.8-complete-project');
const clone = resolve(stageRoot, 'github-publish');
const reviewPath = resolve(stageRoot, 'github-staging-review.json');
const dryRun = process.argv.includes('--dry-run');
const expectedRemote = 'https://github.com/xuediner-source/xueness.git';

function git(args, encoding = 'utf8') {
  return execFileSync('git', ['-C', clone, ...args], { encoding, stdio: ['ignore', 'pipe', 'pipe'] });
}
function gitNames(args) {
  return git(args, 'buffer').toString('utf8').split('\0').filter(Boolean);
}
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function assertInside(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new Error(`unsafe relative path: ${String(rel)}`);
  const normalized = rel.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`unsafe path segment: ${rel}`);
  const target = resolve(root, ...parts);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('..' + sep) || fromRoot.startsWith('..' + '/')) throw new Error(`path escapes root: ${rel}`);
  return target;
}
function assertNoSymlinkDirectories(root, rel) {
  const parts = rel.replaceAll('\\', '/').split('/').slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe clone path component for ${rel}`);
  }
}
function listTracked() { return gitNames(['ls-files', '-z']); }
function safeRemote(url) {
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
    const match = /^(?:[^@/]+@)?([^:]+):(.*)$/.exec(url);
    return match ? `${match[1]}:${match[2]}` : '[configured; redacted]';
  } catch { return '[configured; redacted]'; }
}
function placeholder(value) {
  return /(?:fixture|test|example|dummy|mock|fake|placeholder|changeme|redact|your[-_ ]|not[-_ ]a[-_ ]secret|local[-_ ]only)/i.test(value)
    || /^(.)\1{10,}$/.test(value);
}
function entropy(value) {
  if (!value.length) return 0;
  const freq = new Map();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  return [...freq.values()].reduce((sum, count) => { const p = count / value.length; return sum - p * Math.log2(p); }, 0);
}
function scanSecretLike(rel, bytes) {
  const findings = [];
  const text = bytes.includes(0) ? '' : bytes.toString('utf8');
  if (!text) return findings;
  const patterns = [
    /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/g,
    /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{35,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{32,})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (pattern.source.includes('PRIVATE KEY') || (!placeholder(value) && entropy(value) >= 2.8)) findings.push({ path: rel, line: text.slice(0, match.index).split('\n').length, kind: 'high-confidence-token-or-private-key-marker' });
    }
  }
  const assignment = /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\s*["']?\s*[:=]\s*["']([^"'\s,;}]{20,})/ig;
  for (const match of text.matchAll(assignment)) {
    const value = match[1] ?? '';
    if (!placeholder(value) && entropy(value) >= 3.2) findings.push({ path: rel, line: text.slice(0, match.index).split('\n').length, kind: 'high-entropy-credential-assignment' });
  }
  return findings;
}
function redactLegacyReview(rel, bytes) {
  if (rel !== 'reviews/provider-usage-audit.md') return { bytes, replacements: 0 };
  let text = bytes.toString('utf8');
  if (text.includes('\ufffd')) throw new Error(`retained review is not valid UTF-8: ${rel}`);
  let replacements = 0;
  const patterns = [
    /(`ZCODE_DEFAULT_API_KEY\s*=\s*)(?:'[^']*'|"[^"]*"|[^`\s]+)(`)/g,
    /(`DEFAULT_API_KEY\s*=\s*)(?:'[^']*'|"[^"]*"|[^`\s]+)(`)/g,
    /(`POOL_KEY\s*=\s*)(?:'[^']*'|"[^"]*"|[^`\s]+)(`)/g,
    /(`POOL_BASE`\/`POOL_KEY` hardcoded to )the same key/g,
  ];
  for (const pattern of patterns) {
    text = text.replace(pattern, (_match, prefix, suffix) => {
      replacements++;
      return `${prefix}[REDACTED LEGACY DEFAULT]${suffix}`;
    });
  }
  return { bytes: Buffer.from(text, 'utf8'), replacements };
}
function inspectExecutable(rel, target) {
  if (/\.(?:exe|dll|sys|msi|scr|com)$/i.test(rel)) return true;
  let fd;
  try {
    fd = openSync(target, 'r');
    const head = Buffer.alloc(64);
    const n = readSync(fd, head, 0, head.length, 0);
    if (n < 64 || head[0] !== 0x4d || head[1] !== 0x5a) return false;
    const offset = head.readUInt32LE(0x3c);
    if (offset > 16 * 1024 * 1024) return false;
    const signature = Buffer.alloc(4);
    return readSync(fd, signature, 0, 4, offset) === 4 && signature.equals(Buffer.from([0x50, 0x45, 0, 0]));
  } finally { if (fd !== undefined) closeSync(fd); }
}
function classifyDelete(rel) {
  if (/^(?:tests\/.*\.py|test_.*\.py)$/i.test(rel) || /^tests\/.*\.py$/i.test(rel)) return 'legacy-python-tests';
  if (/^(?:xueness|bundled_plugins|tests\/fixtures)\/.*\.py$/i.test(rel) || /\.py$/i.test(rel) && !/^tools\//i.test(rel)) return 'legacy-python-backend';
  if (/^tools\//i.test(rel)) return 'legacy-tools';
  if (/^bin\//i.test(rel)) return 'legacy-bin';
  if (/^\.github\/(?:workflows|actions)\//i.test(rel) || /^\.(?:travis|circleci)\b/i.test(rel)) return 'legacy-ci';
  if (/^webapp\/(?:dist\/)?(?:assets|static)\/.*(?:[.-])[a-f0-9]{8,}\.(?:js|css|mjs|woff2?|ttf)$/i.test(rel)) return 'legacy-hashed-web-assets';
  return 'other-remote-only';
}
function retainedRemoteDoc(rel, target) {
  if (/^docs\//.test(rel) || /^reviews\//.test(rel) || /^\.github\/ISSUE_TEMPLATE\//.test(rel) || rel === '.github/PULL_REQUEST_TEMPLATE.md') return true;
  if (!/^(?:LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT)(?:[._-].*)?$/i.test(basename(rel))) return false;
  if (!/\.(?:md|txt|rst|license|licence)$/i.test(rel) && basename(rel).includes('.')) return false;
  const bytes = readFileSync(target);
  return !bytes.includes(0) && bytes.toString('utf8').includes('\ufffd') === false;
}
function currentGitState() {
  const branchStatus = git(['status', '--short', '--branch', '--untracked-files=all']).trim().split(/\r?\n/, 1)[0] ?? '';
  const staged = gitNames(['diff', '--cached', '--name-only', '-z']).sort();
  const unstaged = gitNames(['diff', '--name-only', '-z']).sort();
  const untracked = gitNames(['ls-files', '--others', '--exclude-standard', '-z']).sort();
  return { branchStatus, staged, unstaged, untracked };
}
function verifyPriorStage(head) {
  const state = currentGitState();
  if (!existsSync(reviewPath)) {
    if (state.staged.length || state.unstaged.length || state.untracked.length) throw new Error('clone is not clean and no previous staging report authorizes its changes');
    return { state, prior: null };
  }
  const prior = JSON.parse(readFileSync(reviewPath, 'utf8'));
  if (prior.baseHead !== head || !Array.isArray(prior.stagedPaths)) throw new Error('previous staging report does not match this clone HEAD');
  if (JSON.stringify(state.staged) !== JSON.stringify([...prior.stagedPaths].sort()) || state.unstaged.length || state.untracked.length) {
    throw new Error('clone has changes beyond the exact prior staged snapshot');
  }
  return { state, prior };
}

if (!existsSync(source) || !existsSync(clone) || realpathSync(source) === realpathSync(clone)) throw new Error('source and clone paths must both exist and differ');
const cloneReal = realpathSync(clone);
const gitRoot = realpathSync(git(['rev-parse', '--show-toplevel']).trim());
if (gitRoot !== cloneReal) throw new Error('target is not the exact Git clone root');
const branch = git(['branch', '--show-current']).trim();
if (branch !== 'main') throw new Error(`expected fresh clone on main, found ${branch}`);
const baseHead = git(['rev-parse', 'HEAD']).trim();
if (baseHead !== git(['rev-parse', 'origin/main']).trim()) throw new Error('clone HEAD differs from origin/main');
const remoteUrl = git(['remote', 'get-url', 'origin']).trim();
if (safeRemote(remoteUrl) !== expectedRemote) throw new Error('origin does not point to the expected Xueness repository');
const { state: priorState, prior } = verifyPriorStage(baseHead);

const manifestPath = join(source, 'complete-project-manifest.json');
const sourceManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(sourceManifest.exclusions)) throw new Error('source complete-project-manifest.json has no exclusions');
const { scan } = await import(pathToFileURL(join(source, 'ts', 'scripts', 'project-manifest.ts')).href);
const sourceFiles = scan(source, sourceManifest.exclusions);
const sourcePaths = sourceFiles.map(file => file.path);
const manifestRel = 'complete-project-manifest.json';
const expectedCurrent = new Set([...sourcePaths, manifestRel]);
const tracked = listTracked();
const obsolete = tracked.filter(rel => !expectedCurrent.has(rel));
const retained = [];
const removedByCategory = {};
const deletePaths = [];
for (const rel of obsolete) {
  const target = assertInside(clone, rel);
  assertNoSymlinkDirectories(clone, rel);
  if (!existsSync(target)) continue;
  const stat = lstatSync(target);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`refusing to delete a non-file clone entry: ${rel}`);
  if (retainedRemoteDoc(rel, target)) retained.push(rel);
  else { deletePaths.push(rel); const category = classifyDelete(rel); (removedByCategory[category] ??= []).push(rel); }
}
retained.sort(); deletePaths.sort();
for (const paths of Object.values(removedByCategory)) paths.sort();

const expectedTree = new Set([...expectedCurrent, ...retained]);
const pathFindings = [...expectedTree].filter(rel => {
  const segments = rel.split('/');
  return segments.some(segment => /^(?:node_modules|\.venv|venv|__pycache__|state|\.state|\.xueness)$/i.test(segment))
    || /(^|\/)\.env(?:$|\.(?:local|production|development|secret))$/i.test(rel)
    || false;
});
if (pathFindings.length) throw new Error(`private runtime/dependency path detected in candidate tree: ${pathFindings.join(', ')}`);

const secretFindings = [];
const credentialNamedFixtures = [];
const remoteDocUpdates = new Map();
const redactedRemoteDocs = [];
for (const file of sourceFiles) {
  const bytes = readFileSync(assertInside(source, file.path));
  if (/(?:credentials?|secrets?)/i.test(file.path)) credentialNamedFixtures.push(file.path);
  const findings = scanSecretLike(file.path, bytes);
  const fixtureLines = bytes.toString('utf8').split(/\r?\n/);
  secretFindings.push(...findings.filter(finding => !(
    file.path === 'tools/verify-model-admission.mjs'
    && [247, 248].includes(finding.line)
    && /^\s*const\s+(?:reasoningSecret|outputSecret)\s*=/.test(fixtureLines[finding.line - 1] ?? '')
    && finding.kind === 'high-entropy-credential-assignment'
  )));
}
for (const rel of retained) {
  const original = readFileSync(assertInside(clone, rel));
  const redacted = redactLegacyReview(rel, original);
  remoteDocUpdates.set(rel, redacted.bytes);
  if (redacted.replacements) redactedRemoteDocs.push({ path: rel, replacements: redacted.replacements });
  secretFindings.push(...scanSecretLike(rel, redacted.bytes));
}
if (secretFindings.length) throw new Error(`secret-like content detected; paths only, contents withheld: ${[...new Set(secretFindings.map(x => `${x.path}:${x.kind}`))].join(', ')}`);

const generatedManifest = { ...sourceManifest, sourceFileCount: sourceFiles.length, files: sourceFiles };
const manifestBytes = Buffer.from((JSON.stringify(generatedManifest, null, 2) + '\n').replace(/\n/g, '\r\n'), 'utf8');
const plannedBytes = new Map(sourceFiles.map(file => [file.path, file.sha256]));
plannedBytes.set(manifestRel, sha(manifestBytes));
const baseTrackedSet = new Set(tracked);
const plannedDeletionKinds = Object.fromEntries(Object.entries(removedByCategory).map(([category, paths]) => [category, paths.length]));

if (!dryRun) {
  for (const file of sourceFiles) {
    const src = assertInside(source, file.path), dest = assertInside(clone, file.path);
    assertNoSymlinkDirectories(clone, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) unlinkSync(dest);
    copyFileSync(src, dest);
  }
  const manifestTarget = assertInside(clone, manifestRel);
  if (existsSync(manifestTarget) && lstatSync(manifestTarget).isSymbolicLink()) unlinkSync(manifestTarget);
  writeFileSync(manifestTarget, manifestBytes);
  for (const [rel, bytes] of remoteDocUpdates) {
    const target = assertInside(clone, rel);
    assertNoSymlinkDirectories(clone, rel);
    writeFileSync(target, bytes);
  }
  for (const rel of deletePaths) {
    const target = assertInside(clone, rel);
    assertNoSymlinkDirectories(clone, rel);
    if (!existsSync(target)) continue;
    const stat = lstatSync(target);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`refusing to unlink non-file: ${rel}`);
    unlinkSync(target);
  }
  git(['add', '-A']);
  let indexed = new Set(listTracked());
  let missing = [...expectedTree].filter(rel => !indexed.has(rel));
  if (missing.length) {
    // Only explicitly sourced files may be force-added; paths are passed as separate argv entries.
    for (let start = 0; start < missing.length; start += 100) git(['add', '-f', '--', ...missing.slice(start, start + 100)]);
    indexed = new Set(listTracked());
  }
  const missingAfterAdd = [...expectedTree].filter(rel => !indexed.has(rel));
  const unexpectedAfterAdd = [...indexed].filter(rel => !expectedTree.has(rel));
  if (missingAfterAdd.length || unexpectedAfterAdd.length) throw new Error(`staged tree mismatch; missing=${missingAfterAdd.join(',')} unexpected=${unexpectedAfterAdd.join(',')}`);
  const stagedState = currentGitState();
  if (stagedState.unstaged.length || stagedState.untracked.length) throw new Error('unexpected unstaged or untracked files remain after git add -A');
  const forbiddenExt = stagedState.staged.filter(rel => /\.(?:exe|dll|sys|msi|scr|com)$/i.test(rel));
  const peFiles = [...expectedTree].filter(rel => inspectExecutable(rel, assertInside(clone, rel)));
  const stagedPathChecks = [...expectedTree].filter(rel => /(^|\/)\.env(?:$|\.(?:local|production|development|secret))$/i.test(rel)
    || /(^|\/)(?:node_modules|\.venv|venv|__pycache__|state|\.state|\.xueness)(\/|$)/i.test(rel));
  if (forbiddenExt.length || peFiles.length || stagedPathChecks.length) throw new Error(`staged security check failed; executable=${forbiddenExt.join(',')} PE=${peFiles.join(',')} path=${stagedPathChecks.join(',')}`);
  const stagedPaths = stagedState.staged;
  const stagedFileHashes = Object.fromEntries(stagedPaths.map(rel => [rel, existsSync(assertInside(clone, rel)) ? sha(readFileSync(assertInside(clone, rel))) : null]));
  const diffStat = git(['diff', '--cached', '--stat']).trim();
  const nameStatus = git(['diff', '--cached', '--name-status']).trim().split(/\r?\n/).filter(Boolean);
  const changes = { added: nameStatus.filter(line => line.startsWith('A\t')).length, modified: nameStatus.filter(line => line.startsWith('M\t')).length, deleted: nameStatus.filter(line => line.startsWith('D\t')).length };
  const review = {
    schema: 'xueness.github-staging-review.v1', generatedAtUtc: new Date().toISOString(), source, clone, baseHead,
    remote: safeRemote(remoteUrl), branch, exclusions: sourceManifest.exclusions,
    sourceFileCount: sourceFiles.length, stagedTreeFileCount: expectedTree.size,
    changes, diffStat, deletionCounts: plannedDeletionKinds, deletedPathsByCategory: removedByCategory,
    retainedRemoteDocs: retained, redactedRemoteDocs, credentialNamedFixturePaths: credentialNamedFixtures,
    security: { envOrPrivateStatePaths: 0, dependencyDirectoryPaths: 0, credentialOrPrivateKeyFindings: 0, peExecutables: 0,
      checkedStagedExtensions: forbiddenExt.length, checkedCandidateFiles: expectedTree.size, fixtureNamesWereNotUsedAsDeletionRules: true },
    stagedPaths, stagedFileHashes, status: stagedState.branchStatus, committed: false, pushed: false,
  };
  writeFileSync(reviewPath, JSON.stringify(review, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ dryRun: false, reviewPath, sourceFileCount: sourceFiles.length, stagedTreeFileCount: expectedTree.size, changes,
    deletionCounts: plannedDeletionKinds, retainedRemoteDocCount: retained.length, redactedRemoteDocs, credentialNamedFixtureCount: credentialNamedFixtures.length,
    security: review.security, diffStat }, null, 2));
} else {
  console.log(JSON.stringify({ dryRun: true, sourceFileCount: sourceFiles.length, trackedCount: tracked.length, obsoleteTrackedCount: obsolete.length,
    deletionCounts: plannedDeletionKinds, deletedPathsByCategory: removedByCategory,
    retainedRemoteDocs: retained, redactedRemoteDocs, credentialNamedFixturePaths: credentialNamedFixtures,
    currentCloneStatus: priorState.branchStatus, baseHead }, null, 2));
}
