// Settings for the cloud server, all from environment variables.
// On the VM they come from /etc/gst-portal/env (see cloud/deploy/); locally
// from cloud/.env.local (git-ignored), loaded by `npm run dev:cloud`.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

// Tiny .env loader (no dependency): KEY=value lines, # comments.
export function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnvFile(process.env.GSP_ENV_FILE);

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

export const config = {
  port: Number(env('GSP_PORT', 3000)),
  host: env('GSP_HOST', '127.0.0.1'),
  // The address people use, e.g. https://130-210-127-108.sslip.io. Writes from
  // any other Origin are refused (CSRF guard on top of SameSite cookies).
  publicOrigin: env('GSP_PUBLIC_ORIGIN', 'http://localhost:5173'),
  extraOrigins: env('GSP_EXTRA_ORIGINS', '').split(',').map((s) => s.trim()).filter(Boolean),
  cookieSecure: env('GSP_COOKIE_SECURE', '1') === '1',
  sessionDays: Number(env('GSP_SESSION_DAYS', 7)),
  db: {
    host: env('GSP_DB_HOST', '127.0.0.1'),
    port: Number(env('GSP_DB_PORT', 3306)),
    user: env('GSP_DB_USER', 'gst_app'),
    password: env('GSP_DB_PASSWORD', ''),
    database: env('GSP_DB_NAME', 'gst_portal'),
    ssl: env('GSP_DB_SSL', '1') === '1',
  },
  distDir: path.resolve(ROOT, env('GSP_DIST_DIR', 'dist')),
  trustProxy: env('GSP_TRUST_PROXY', '1') === '1',
  runRecurring: env('GSP_RUN_RECURRING', '1') === '1',
};
