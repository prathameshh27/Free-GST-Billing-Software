// npm run dev:cloud - the cloud server + Vite (hot reload) with VITE_CLOUD=1.
// Settings: cloud/.env.local (copy cloud/env.example).
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = path.join(root, 'cloud', '.env.local');
if (!fs.existsSync(envFile)) {
  console.error('  Missing cloud/.env.local - copy cloud/env.example and fill it in.');
  process.exit(1);
}
const env = { ...process.env, GSP_ENV_FILE: envFile, VITE_CLOUD: '1' };
const opts = { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' };

const server = spawn('node', ['--watch-path=cloud/server', 'cloud/server/index.js'], opts);
const vite = spawn('npx', ['vite'], opts);
const stop = () => { server.kill(); vite.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (c) => { if (c) console.error(`  cloud server exited (${c})`); });
vite.on('exit', stop);
