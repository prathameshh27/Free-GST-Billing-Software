// Logins, sessions, roles and the per-request business ("tenant") context.
import crypto from 'crypto';
import { promisify } from 'util';
import { q } from './db.js';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);

// ---- passwords ------------------------------------------------------------
// scrypt (same family the desktop app uses for its PIN), stored as
// scrypt$N$r$p$salt$hash so the cost can be raised later.
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// 10+ characters with at least a letter and a digit. Long passphrases welcome.
export function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 10) return 'Password must be at least 10 characters.';
  if (s.length > 200) return 'Password is too long.';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'Password must contain letters and at least one digit.';
  return null;
}

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const emailProblem = (e) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail(e)) ? null : 'Enter a valid email address.');

// ---- login rate limit -----------------------------------------------------
// 5 failed tries per 15 minutes per email, and 20 per IP, then wait.
const WINDOW_MIN = 15, MAX_PER_EMAIL = 5, MAX_PER_IP = 20;

export async function loginBlocked(email, ip) {
  const [byEmail] = await q(
    `SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND ok = 0 AND at > (UTC_TIMESTAMP(3) - INTERVAL ${WINDOW_MIN} MINUTE)`, [email]);
  const [byIp] = await q(
    `SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ok = 0 AND at > (UTC_TIMESTAMP(3) - INTERVAL ${WINDOW_MIN} MINUTE)`, [ip]);
  return Number(byEmail.n) >= MAX_PER_EMAIL || Number(byIp.n) >= MAX_PER_IP;
}

export async function recordLogin(email, ip, ok) {
  await q('INSERT INTO login_attempts (email, ip, ok, at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))', [email.slice(0, 255), ip.slice(0, 64), ok ? 1 : 0]);
  if (ok) await q('DELETE FROM login_attempts WHERE email = ? AND ok = 0', [email]);
}

// ---- sessions --------------------------------------------------------------
export const COOKIE = 'gsp_session';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(userId, businessId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q(
    `INSERT INTO sessions (token_hash, user_id, business_id, expires_at, ip, user_agent)
     VALUES (?, ?, ?, UTC_TIMESTAMP(3) + INTERVAL ? DAY, ?, ?)`,
    [sha256(token), userId, businessId, config.sessionDays, clientIp(req).slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 300)],
  );
  return token;
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: config.sessionDays * 24 * 3600 * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/' });
}

export async function destroySession(token) {
  if (token) await q('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

export async function destroyUserSessions(userId, exceptToken = null) {
  if (exceptToken) await q('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, sha256(exceptToken)]);
  else await q('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

export async function setSessionBusiness(token, businessId) {
  await q('UPDATE sessions SET business_id = ? WHERE token_hash = ?', [businessId, sha256(token)]);
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

export const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || '');

// Loads the session + user + role for this request into req.ctx (or null).
// ctx = { user, token, businessId, role: 'superadmin'|'admin'|'support'|null, memberships }
export async function loadContext(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const rows = await q(
    `SELECT s.business_id, u.id, u.email, u.name, u.is_super_admin, u.status, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3)`,
    [sha256(token)],
  );
  if (!rows.length || rows[0].status !== 'active') return null;
  const r = rows[0];
  const memberships = await q(
    `SELECT m.business_id, m.role, b.name, b.status FROM memberships m JOIN businesses b ON b.id = m.business_id
      WHERE m.user_id = ? ORDER BY b.name`, [r.id]);
  const user = { id: r.id, email: r.email, name: r.name, isSuperAdmin: !!r.is_super_admin, mustChangePassword: !!r.must_change_password };

  // The session's business must still be one this user may use, and active.
  let businessId = r.business_id || null;
  let role = null;
  if (businessId) {
    if (user.isSuperAdmin) {
      const b = await q('SELECT status FROM businesses WHERE id = ?', [businessId]);
      if (b.length && b[0].status === 'active') role = 'superadmin'; else businessId = null;
    } else {
      const m = memberships.find((x) => x.business_id === businessId && x.status === 'active');
      if (m) role = m.role; else businessId = null;
    }
  }
  // Touch at most once a minute (keeps a write per request off the hot path).
  q('UPDATE sessions SET last_seen_at = UTC_TIMESTAMP(3) WHERE token_hash = ? AND last_seen_at < UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE', [sha256(token)]).catch(() => {});
  return { user, token, businessId, role, memberships, ip: clientIp(req) };
}

// ---- middleware --------------------------------------------------------------

// Writes must come from the app's own address (on top of SameSite=Strict).
export function originGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  const allowed = [config.publicOrigin, ...config.extraOrigins];
  if (origin && !allowed.includes(origin)) return res.status(403).json({ error: 'Cross-origin request refused', code: 'forbidden' });
  // No Origin header (curl, some old browsers): fall back to Referer when present.
  if (!origin && req.headers.referer && !allowed.some((o) => String(req.headers.referer).startsWith(o + '/'))) {
    return res.status(403).json({ error: 'Cross-origin request refused', code: 'forbidden' });
  }
  return next();
}

// Any logged-in user.
export function requireUser(req, res, next) {
  if (!req.ctx) return res.status(401).json({ error: 'Please log in', code: 'unauthenticated' });
  return next();
}

// A business must be chosen (data routes).
export function requireBusiness(req, res, next) {
  if (!req.ctx) return res.status(401).json({ error: 'Please log in', code: 'unauthenticated' });
  if (!req.ctx.businessId) return res.status(409).json({ error: 'Choose a business first', code: 'no-business' });
  return next();
}

// Support users are read-only: any write in a business is refused. A few
// per-user endpoints (their own settings, error reports) stay open.
const SUPPORT_WRITE_ALLOWED = new Set(['/api/local-prefs', '/api/client-errors', '/api/save-pdf', '/api/saved-pdf/cancel-mark', '/api/trash-pdf']);
export function enforceRole(req, res, next) {
  if (!req.ctx || req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.ctx.role === 'support' && !SUPPORT_WRITE_ALLOWED.has(req.path)) {
    return res.status(403).json({ error: 'Your account has read-only access', code: 'read-only' });
  }
  return next();
}

export function requireSuperAdmin(req, res, next) {
  if (!req.ctx) return res.status(401).json({ error: 'Please log in', code: 'unauthenticated' });
  if (!req.ctx.user.isSuperAdmin) return res.status(403).json({ error: 'Super admin only', code: 'forbidden' });
  return next();
}
