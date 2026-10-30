// Standalone CLI entry owned by desktop.cli_distribution.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

function cliArguments(args, env = process.env, home = os.homedir()) {
  const result = args.length ? [...args] : ['chat', '--tui'];
  if (!result.some(arg => arg === '--state' || arg.startsWith('--state='))) {
    result.unshift('--state', env.XUENESS_STATE_DIR || path.join(home, '.xueness', 'state'));
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--version', '-V'].includes(args[0])) {
    const release = JSON.parse(fs.readFileSync(path.join(__dirname, 'cli-release.json'), 'utf8'));
    console.log(`Xueness CLI ${release.version} (${release.platform}; ${release.sourceCommit.slice(0, 7)})`);
    return;
  }
  const entry = path.join(__dirname, 'backend-ts', 'apps', 'server', 'src', 'cli', 'main.js');
  const child = spawn(process.execPath, [entry, ...cliArguments(args)], { stdio: 'inherit', windowsHide: false });
  // The interactive child owns Ctrl+C, including clearing an unfinished draft.
  process.on('SIGINT', () => {});
  child.on('error', error => { console.error(`Xueness CLI: ${error.message}`); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
}

module.exports = { cliArguments };
if (require.main === module) main();
