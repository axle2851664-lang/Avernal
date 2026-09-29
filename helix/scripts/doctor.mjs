/**
 * Reports why the server will not start, in one pass.
 *
 * Written against Node builtins only and never imports the app, so it still
 * runs when dependencies are missing or the build is broken -- which is
 * precisely when it is needed.
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3000);
const problems = [];

const pass = (m) => console.log(`  ok    ${m}`);
const fail = (m, fix) => {
  console.log(`  FAIL  ${m}`);
  problems.push({ m, fix });
};

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

console.log('\nHelix doctor\n');

// 1. Node version. package.json asks for >=20; older versions fail obscurely.
const major = Number(process.versions.node.split('.')[0]);
major >= 20
  ? pass(`Node ${process.versions.node}`)
  : fail(`Node ${process.versions.node} is too old`, 'Install Node 20 or newer.');

// 2. Right directory.
existsSync(join(root, 'package.json'))
  ? pass('running inside the helix package')
  : fail('no package.json here', 'cd into the helix directory first.');

// 3. Up to date. Running an old checkout is the likeliest reason a fix seems
//    absent, so it is worth saying out loud rather than leaving to be inferred.
const localHead = sh('git rev-parse --short HEAD');
if (localHead === null) {
  pass('not a git checkout, skipping version check');
} else {
  sh('git fetch --quiet origin');
  const behind = sh('git rev-list --count HEAD..@{u}');
  if (behind === null) pass(`on ${localHead} (no upstream to compare)`);
  else if (Number(behind) > 0)
    fail(
      `${behind} commit(s) behind the branch -- this checkout is missing fixes`,
      'git pull'
    );
  else pass(`up to date with the branch (${localHead})`);
}

// 4. Dependencies.
existsSync(join(root, 'node_modules'))
  ? pass('node_modules installed')
  : fail('node_modules missing', 'npm ci --legacy-peer-deps');

// 5. Port. A server already holding it is invisible until you look.
const portFree = await new Promise((resolve) => {
  const probe = createServer()
    .once('error', () => resolve(false))
    .once('listening', () => probe.close(() => resolve(true)))
    .listen(PORT, '127.0.0.1');
});
if (portFree) pass(`port ${PORT} is free`);
else {
  // Something answering here may be an older copy of this very server.
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).catch(() => null);
  if (health?.ok) {
    fail(
      `port ${PORT} already has a Helix server on it`,
      'A server is ALREADY RUNNING and reachable. Open http://localhost:' +
        PORT +
        ' -- or stop it and start again if you want the newest code.'
    );
  } else {
    fail(`port ${PORT} is taken by something else`, `Stop it, or use: PORT=3001 npm run server`);
  }
}

// 6. Python. Only the generator needs it; notes work without it.
const py = sh('python3 --version') ?? sh('python --version');
if (py === null) fail('no python3 (image and video generation only)', 'Install Python 3.11+.');
else {
  pass(py);
  sh('python3 -c "import torch"') === null
    ? fail('torch not installed (image and video generation only)', 'pip install -r requirements.txt')
    : pass('torch importable');
}

// 7. The build, which is where a type error would surface.
console.log('  ...    compiling');
const built = await new Promise((resolve) => {
  const p = spawn('npx', ['tsc'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stdout.on('data', (d) => (err += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => resolve({ code, err }));
  p.on('error', () => resolve({ code: 1, err: 'could not run tsc' }));
});
built.code === 0
  ? pass('compiles')
  : fail('compile failed:\n' + built.err.trim().split('\n').slice(0, 5).join('\n'), 'Fix the errors above.');

console.log();
if (problems.length === 0) {
  console.log('Nothing wrong. Start it with:  npm run server');
  console.log(`Then open:  http://localhost:${PORT}\n`);
} else {
  console.log(`${problems.length} problem(s):\n`);
  for (const { m, fix } of problems) console.log(`  - ${m.split('\n')[0]}\n    -> ${fix}\n`);
}
