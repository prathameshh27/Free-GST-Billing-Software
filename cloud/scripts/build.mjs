// npm run build:cloud - the frontend built for the hosted app (VITE_CLOUD=1).
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const r = spawnSync('npx', ['vite', 'build'], {
  cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
  env: { ...process.env, VITE_CLOUD: '1' },
});
process.exit(r.status ?? 1);
