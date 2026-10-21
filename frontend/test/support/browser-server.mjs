import { startApp } from './app.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
let ash;
let app;
let output = '';
const close = async () => {
  await app?.close();
  if (ash && ash.exitCode === null) { ash.kill('SIGTERM'); await once(ash, 'exit'); }
};
try {
  if (process.env.BRIDGE_BROWSER_BACKEND === 'ash') {
    ash = spawn('mix', ['run', '--no-halt', 'scripts/browser_backend.exs'], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      env: { ...process.env, MIX_ENV: 'test', BRIDGE_BROWSER_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    ash.stdout.on('data', data => output += data);
    ash.stderr.on('data', data => output += data);
    ash.on('error', error => output += error.message);
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (ash.exitCode !== null) throw new Error('Ash test backend exited: ' + output);
      try { if ((await fetch('http://127.0.0.1:4174/healthz')).ok) { ready = true; break; } } catch {}
      await delay(50);
    }
    if (!ready) throw new Error('Ash test backend not ready: ' + output);
    app = await startApp({ externalBackendOrigin: 'http://127.0.0.1:4174' });
  } else {
    app = await startApp({ backendPort: 4174 });
  }
  console.log('Browser test servers ready');
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await close(); process.exit(0); });
} catch (error) { await close(); throw new Error(error.message + (output ? '\nAsh fixture output:\n' + output : ''), { cause: error }); }
