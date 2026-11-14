// /api/auth/* - log in, log out, who am I, switch business, change password.
import express from 'express';
import { q } from '../db.js';
import { audit } from '../store.js';
import {
  verifyPassword, hashPassword, passwordProblem, normEmail, loginBlocked, recordLogin,
  createSession, setSessionCookie, clearSessionCookie, destroySession, destroyUserSessions,
  setSessionBusiness, clientIp, requireUser, readCookie, COOKIE,
} from '../auth.js';

export const authRouter = express.Router();

// Same answer and similar time for "no such user" and "wrong password".
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

// The businesses a user may open: all active ones for a super admin.
async function businessesFor(ctx) {
  if (ctx.user.isSuperAdmin) {
    const rows = await q("SELECT id, name FROM businesses WHERE status = 'active' ORDER BY name");
    return rows.map((b) => ({ id: b.id, name: b.name, role: 'superadmin' }));
  }
  return ctx.memberships.filter((m) => m.status === 'active').map((m) => ({ id: m.business_id, name: m.name, role: m.role }));
}

export async function meResponse(ctx) {
  const businesses = await businessesFor(ctx);
  const current = businesses.find((b) => b.id === ctx.businessId) || null;
  return {
    user: { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, isSuperAdmin: ctx.user.isSuperAdmin, mustChangePassword: ctx.user.mustChangePassword },
    business: current ? { id: current.id, name: current.name } : null,
    role: ctx.role,
    readOnly: ctx.role === 'support',
    businesses,
  };
}

authRouter.post('/login', async (req, res) => {
  const email = normEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const ip = clientIp(req);
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password', code: 'bad-request' });
  if (await loginBlocked(email, ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Wait 15 minutes and try again.', code: 'rate-limited' });
  }
  const rows = await q('SELECT id, password_hash, status, is_super_admin FROM users WHERE email = ?', [email]);
  const user = rows[0];
  const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || user.status !== 'active') {
    await recordLogin(email, ip, false);
    return res.status(401).json({ error: 'Wrong email or password', code: 'bad-login' });
  }
  await recordLogin(email, ip, true);
  await q('UPDATE users SET last_login_at = UTC_TIMESTAMP(3) WHERE id = ?', [user.id]);

  // Open the business used last time if still allowed, else the first one.
  let businessId = null;
  if (user.is_super_admin) {
    const b = await q("SELECT id FROM businesses WHERE status = 'active' ORDER BY name LIMIT 1");
    businessId = b[0]?.id || null;
  } else {
    const m = await q(
      `SELECT m.business_id FROM memberships m JOIN businesses b ON b.id = m.business_id
        WHERE m.user_id = ? AND b.status = 'active' ORDER BY b.name LIMIT 1`, [user.id]);
    businessId = m[0]?.business_id || null;
  }
  const last = await q('SELECT business_id FROM sessions WHERE user_id = ? AND business_id IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1', [user.id]);
  if (last[0]?.business_id) {
    const allowed = user.is_super_admin
      ? (await q("SELECT 1 FROM businesses WHERE id = ? AND status = 'active'", [last[0].business_id])).length
      : (await q(`SELECT 1 FROM memberships m JOIN businesses b ON b.id = m.business_id
                   WHERE m.user_id = ? AND m.business_id = ? AND b.status = 'active'`, [user.id, last[0].business_id])).length;
    if (allowed) businessId = last[0].business_id;
  }

  const token = await createSession(user.id, businessId, req);
  setSessionCookie(res, token);
  await audit({ user: { id: user.id }, businessId, ip }, 'login');
  // Old expired sessions are cleaned up opportunistically.
  q('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP(3)').catch(() => {});
  return res.json({ ok: true });
});

authRouter.post('/logout', async (req, res) => {
  await destroySession(readCookie(req, COOKIE));
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/me', requireUser, async (req, res) => {
  res.json(await meResponse(req.ctx));
});

authRouter.post('/switch-business', requireUser, async (req, res) => {
  const id = String(req.body?.businessId || '');
  const allowed = (await businessesFor(req.ctx)).find((b) => b.id === id);
  if (!allowed) return res.status(403).json({ error: 'You do not have access to that business', code: 'forbidden' });
  await setSessionBusiness(req.ctx.token, id);
  await audit({ ...req.ctx, businessId: id }, 'switch-business');
  res.json({ ok: true });
});

authRouter.post('/change-password', requireUser, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const rows = await q('SELECT password_hash FROM users WHERE id = ?', [req.ctx.user.id]);
  if (!rows.length || !(await verifyPassword(String(currentPassword || ''), rows[0].password_hash))) {
    return res.status(400).json({ error: 'Current password is wrong', code: 'bad-password' });
  }
  const problem = passwordProblem(newPassword);
  if (problem) return res.status(400).json({ error: problem, code: 'weak-password' });
  await q('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [await hashPassword(newPassword), req.ctx.user.id]);
  await destroyUserSessions(req.ctx.user.id, req.ctx.token); // log out other devices
  await audit(req.ctx, 'change-password');
  res.json({ ok: true });
});
