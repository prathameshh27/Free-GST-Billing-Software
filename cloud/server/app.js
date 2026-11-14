// Builds the Express app (separate from index.js so tests can start it).
import fs from 'fs';
import path from 'path';
import express from 'express';
import { config, ROOT } from './config.js';
import { q } from './db.js';
import { loadContext, originGuard, requireUser, requireBusiness, enforceRole } from './auth.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { dataRouter } from './routes/data.js';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 'loopback'); // Caddy on the same host

  // Security headers for every response.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // Body limits as in server.js: 5mb normally, more for a full-backup import.
  const jsonBody = express.json({ limit: '5mb' });
  const importBody = express.json({ limit: '200mb' });
  app.use('/api', (req, res, next) => {
    if (req.path === '/local-prefs') return next(); // parses its own (25mb, images)
    if (req.path === '/save-pdf') return next();
    return (req.path === '/import' ? importBody : jsonBody)(req, res, next);
  });

  app.use('/api', originGuard);
  app.use('/api', async (req, res, next) => {
    try { req.ctx = await loadContext(req); next(); } catch (err) { next(err); }
  });
  // API answers are never cached by the browser or the offline worker.
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // ---- open without login ----
  app.use('/api/auth', authRouter);
  app.get('/api/version', (req, res) => res.json({ current: pkg.version, cloud: true }));
  app.get('/api/health', async (req, res) => {
    try { await q('SELECT 1'); res.json({ ok: true, version: pkg.version, uptimeSec: Math.round(process.uptime()), hasRecentErrors: false, errorsTail: '' }); }
    catch { res.status(503).json({ ok: false, error: 'database unavailable' }); }
  });

  // ---- logged in ----
  app.use('/api/admin', adminRouter);

  // Desktop-only features answered harmlessly in the hosted app (the screens
  // that use them are hidden in the cloud build; these keep stray calls safe).
  app.get('/api/lock', requireUser, (req, res) => res.json({ enabled: false, length: 0 }));
  app.post('/api/lock/verify', requireUser, (req, res) => res.json({ ok: true }));
  app.post('/api/lock/set', requireUser, (req, res) => res.status(403).json({ error: 'The PIN lock is not used in the online app: everyone logs in.', code: 'not-available' }));
  app.get('/api/check-update', requireUser, (req, res) => res.json({ current: pkg.version, updateAvailable: false, cloud: true }));
  app.get('/api/changelog', requireUser, (req, res) => {
    fs.readFile(path.join(ROOT, 'CHANGELOG.md'), 'utf8', (err, text) => res.json({ text: err ? '' : text.slice(0, 400000) }));
  });
  app.get('/api/errors-log', requireUser, (req, res) => res.json({ lines: [] }));
  app.get('/api/backups', requireUser, (req, res) => res.json([]));
  app.post('/api/backups/now', requireUser, (req, res) => res.json({ success: false, error: 'Backups of the online app are made automatically on the server every night.' }));
  app.all('/api/backups/{*rest}', requireUser, (req, res) => res.status(403).json({ error: 'Backups are managed on the server.', code: 'not-available' }));
  app.get('/api/backup-folder', requireUser, (req, res) => res.json({ path: '' }));
  app.post('/api/backup-folder', requireUser, (req, res) => res.status(403).json({ error: 'Not available in the online app.', code: 'not-available' }));
  app.all('/api/control-panel/{*rest}', requireUser, (req, res) => res.status(404).json({ error: 'Not available in the online app.', code: 'not-available' }));
  // PDFs are downloaded by the browser; nothing is kept on the server's disk.
  app.post('/api/save-pdf', requireUser, (req, res) => { req.resume(); res.json({ saved: false, cloud: true }); });
  app.post('/api/saved-pdf/cancel-mark', requireUser, (req, res) => res.json({ updated: 0, failed: 0 }));
  app.post('/api/trash-pdf', requireUser, (req, res) => res.json({ trashed: false }));
  // Browser error reports: written to the service log (journalctl), rate-limited.
  const errTimes = [];
  app.post('/api/client-errors', requireUser, (req, res) => {
    const now = Date.now();
    while (errTimes.length && now - errTimes[0] > 60_000) errTimes.shift();
    if (errTimes.length >= 30) return res.status(429).json({ error: 'Too many reports', code: 'rate-limited' });
    errTimes.push(now);
    const b = req.body || {};
    console.warn(`  [client-error] user=${req.ctx.user.email} ${String(b.kind || '')} ${String(b.message || '').slice(0, 300)}`);
    res.json({ ok: true });
  });

  // ---- data of the current business ----
  app.use('/api', requireBusiness, enforceRole, dataRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'No such endpoint' }));

  // ---- the app itself (built frontend) ----
  const indexPath = path.join(config.distDir, 'index.html');
  app.use(express.static(config.distDir, {
    index: false,
    setHeaders: (res, file) => {
      // Hashed asset files never change; the page and service worker must be re-checked.
      if (/[\\/]assets[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('{*path}', (req, res) => {
    if (req.path.startsWith('/assets/') || /\.(m?js|css|map|wasm|json|png|svg|ico|woff2?)$/i.test(req.path)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    if (!fs.existsSync(indexPath)) return res.status(503).type('text/plain').send('The app is not built yet (npm run build:cloud).');
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(indexPath);
  });

  // Errors: logged in full on the server, a stable short answer to the browser.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = Number(err?.status || err?.statusCode) || 500;
    if (status >= 500) console.error(`  [error] ${req.method} ${req.path}:`, err?.stack || err);
    const code = status === 413 ? 'payload-too-large' : status === 400 ? 'bad-request' : status === 404 ? 'not-found' : 'server-error';
    const messages = { 'payload-too-large': 'Request body too large', 'bad-request': 'Invalid request', 'not-found': 'Not found', 'server-error': 'Internal server error' };
    res.status(status).json({ error: messages[code], code });
  });

  return app;
}
