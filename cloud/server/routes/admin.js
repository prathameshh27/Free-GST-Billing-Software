// /api/admin/* - businesses (super admin) and users (super admin anywhere,
// business admin inside their own business only).
import express from 'express';
import crypto from 'crypto';
import { q, tx } from '../db.js';
import * as S from '../store.js';
import { hashPassword, passwordProblem, normEmail, emailProblem, destroyUserSessions, requireSuperAdmin } from '../auth.js';

export const adminRouter = express.Router();

const newId = (p) => `${p}_${crypto.randomBytes(9).toString('base64url')}`;
const bad = (res, error, status = 400, code = 'bad-request') => res.status(status).json({ error, code });
const ROLES = ['admin', 'support'];

// Super admin, or an admin of the session's current business.
function requireAdmin(req, res, next) {
  if (!req.ctx) return bad(res, 'Please log in', 401, 'unauthenticated');
  if (req.ctx.user.isSuperAdmin || req.ctx.role === 'admin') return next();
  return bad(res, 'Admins only', 403, 'forbidden');
}

// Which business an admin action is about: a super admin may name any
// business (body/query businessId, else the current one); a business admin
// is always held to their current business.
function targetBusiness(req) {
  if (req.ctx.user.isSuperAdmin) return String(req.body?.businessId || req.query.businessId || req.ctx.businessId || '');
  return req.ctx.businessId;
}

async function adminCount(businessId) {
  const [r] = await q("SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.business_id = ? AND m.role = 'admin' AND u.status = 'active'", [businessId]);
  return Number(r.n);
}

// ---------------------------------------------------------------------------
// Businesses (super admin)
// ---------------------------------------------------------------------------
adminRouter.get('/businesses', requireSuperAdmin, async (req, res) => {
  const rows = await q(`
    SELECT b.id, b.name, b.gstin, b.status, b.created_at,
      (SELECT COUNT(*) FROM memberships m WHERE m.business_id = b.id) AS users,
      (SELECT COUNT(*) FROM records r WHERE r.business_id = b.id AND r.collection = 'bills' AND r.deleted_at IS NULL) AS documents
    FROM businesses b ORDER BY b.name`);
  res.json(rows.map((b) => ({ ...b, users: Number(b.users), documents: Number(b.documents) })));
});

// { name, gstin?, admin?: { email, name, password } } - the first admin is
// created (or an existing user is added) in the same step.
adminRouter.post('/businesses', requireSuperAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const gstin = String(req.body?.gstin || '').trim().toUpperCase() || null;
  if (!name || name.length > 200) return bad(res, 'Enter the business name.');
  if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) return bad(res, 'GSTIN must be 15 letters/digits.');
  const admin = req.body?.admin;
  let adminEmail = null;
  if (admin && admin.email) {
    adminEmail = normEmail(admin.email);
    if (emailProblem(adminEmail)) return bad(res, emailProblem(adminEmail));
  }
  const existing = adminEmail ? (await q('SELECT id FROM users WHERE email = ?', [adminEmail]))[0] : null;
  if (adminEmail && !existing) {
    const problem = passwordProblem(admin.password);
    if (problem) return bad(res, problem);
  }
  const id = newId('biz');
  const passwordHash = adminEmail && !existing ? await hashPassword(admin.password) : null;
  await tx(async (conn) => {
    await conn.query('INSERT INTO businesses (id, name, gstin) VALUES (?, ?, ?)', [id, name, gstin]);
    await S.setMeta(id, S.PROFILE_KEY, { ...S.DEFAULT_PROFILE, businessName: name, gstin: gstin || '' }, conn);
    if (adminEmail) {
      let userId = existing?.id;
      if (!userId) {
        userId = newId('usr');
        await conn.query('INSERT INTO users (id, email, name, password_hash, must_change_password) VALUES (?, ?, ?, ?, 1)',
          [userId, adminEmail, String(admin.name || '').slice(0, 200), passwordHash]);
      }
      await conn.query("INSERT INTO memberships (user_id, business_id, role) VALUES (?, ?, 'admin')", [userId, id]);
    }
  });
  await S.audit({ ...req.ctx, businessId: id }, 'create-business', null, null, name);
  res.json({ ok: true, id });
});

// { name?, gstin?, status? }
adminRouter.patch('/businesses/:id', requireSuperAdmin, async (req, res) => {
  const b = (await q('SELECT id FROM businesses WHERE id = ?', [req.params.id]))[0];
  if (!b) return bad(res, 'Not found', 404, 'not-found');
  const { name, gstin, status } = req.body || {};
  if (name !== undefined) {
    if (!String(name).trim()) return bad(res, 'Enter the business name.');
    await q('UPDATE businesses SET name = ? WHERE id = ?', [String(name).trim().slice(0, 200), b.id]);
  }
  if (gstin !== undefined) {
    const g = String(gstin || '').trim().toUpperCase();
    if (g && !/^[0-9A-Z]{15}$/.test(g)) return bad(res, 'GSTIN must be 15 letters/digits.');
    await q('UPDATE businesses SET gstin = ? WHERE id = ?', [g || null, b.id]);
  }
  if (status !== undefined) {
    if (!['active', 'disabled'].includes(status)) return bad(res, 'Invalid status');
    await q('UPDATE businesses SET status = ? WHERE id = ?', [status, b.id]);
  }
  await S.audit({ ...req.ctx, businessId: b.id }, 'update-business', null, null, JSON.stringify(req.body || {}).slice(0, 300));
  res.json({ ok: true });
});

// Per-business totals for the super admin's overview.
adminRouter.get('/overview', requireSuperAdmin, async (req, res) => {
  const rows = await q(`
    SELECT b.id, b.name, b.status,
      SUM(r.collection = 'bills' AND JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.invoiceType')) = 'quotation') AS quotations,
      SUM(r.collection = 'bills' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.invoiceType')), 'tax-invoice') = 'tax-invoice') AS invoices,
      SUM(CASE WHEN r.collection = 'bills' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.data, '$.invoiceType')), 'tax-invoice') = 'tax-invoice'
               THEN CAST(COALESCE(JSON_EXTRACT(r.data, '$.totalAmount'), 0) AS DECIMAL(18,2)) ELSE 0 END) AS invoiced,
      SUM(r.collection = 'clients') AS clients,
      MAX(r.updated_at) AS last_activity
    FROM businesses b
    LEFT JOIN records r ON r.business_id = b.id AND r.deleted_at IS NULL
    GROUP BY b.id, b.name, b.status ORDER BY b.name`);
  res.json(rows.map((r) => ({
    id: r.id, name: r.name, status: r.status,
    quotations: Number(r.quotations || 0), invoices: Number(r.invoices || 0),
    invoiced: Number(r.invoiced || 0), clients: Number(r.clients || 0), lastActivity: r.last_activity,
  })));
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
// Super admin: every user (or one business's with ?businessId=).
// Business admin: the users of their business.
adminRouter.get('/users', requireAdmin, async (req, res) => {
  const scope = req.ctx.user.isSuperAdmin ? (req.query.businessId ? String(req.query.businessId) : null) : req.ctx.businessId;
  const users = scope
    ? await q(`SELECT u.id, u.email, u.name, u.status, u.is_super_admin, u.last_login_at, u.created_at
                 FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? ORDER BY u.email`, [scope])
    : await q('SELECT id, email, name, status, is_super_admin, last_login_at, created_at FROM users ORDER BY email');
  const ids = users.map((u) => u.id);
  const mems = ids.length
    ? await q(`SELECT m.user_id, m.business_id, m.role, b.name FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id IN (?)`, [ids])
    : [];
  res.json(users.map((u) => ({
    id: u.id, email: u.email, name: u.name, status: u.status, isSuperAdmin: !!u.is_super_admin,
    lastLoginAt: u.last_login_at, createdAt: u.created_at,
    // A business admin only sees their own business's membership.
    memberships: mems.filter((m) => m.user_id === u.id && (req.ctx.user.isSuperAdmin || m.business_id === scope))
      .map((m) => ({ businessId: m.business_id, businessName: m.name, role: m.role })),
  })));
});

// { email, name, password, role, businessId? } - creates the user, or adds an
// existing user (by email) to the business with that role.
adminRouter.post('/users', requireAdmin, async (req, res) => {
  const businessId = targetBusiness(req);
  if (!businessId) return bad(res, 'Choose a business first.', 409, 'no-business');
  if (!(await q('SELECT 1 FROM businesses WHERE id = ?', [businessId])).length) return bad(res, 'Business not found', 404, 'not-found');
  const email = normEmail(req.body?.email);
  const role = String(req.body?.role || '');
  if (emailProblem(email)) return bad(res, emailProblem(email));
  if (!ROLES.includes(role)) return bad(res, 'Role must be admin or support.');
  const existing = (await q('SELECT id FROM users WHERE email = ?', [email]))[0];
  if (existing) {
    if ((await q('SELECT 1 FROM memberships WHERE user_id = ? AND business_id = ?', [existing.id, businessId])).length) {
      return bad(res, 'This user is already in this business.', 409, 'conflict');
    }
    await q('INSERT INTO memberships (user_id, business_id, role) VALUES (?, ?, ?)', [existing.id, businessId, role]);
    await S.audit({ ...req.ctx, businessId }, 'add-user', 'users', existing.id, role);
    return res.json({ ok: true, id: existing.id, existing: true });
  }
  const problem = passwordProblem(req.body?.password);
  if (problem) return bad(res, problem);
  const id = newId('usr');
  const hash = await hashPassword(req.body.password);
  await tx(async (conn) => {
    await conn.query('INSERT INTO users (id, email, name, password_hash, must_change_password) VALUES (?, ?, ?, ?, 1)',
      [id, email, String(req.body?.name || '').slice(0, 200), hash]);
    await conn.query('INSERT INTO memberships (user_id, business_id, role) VALUES (?, ?, ?)', [id, businessId, role]);
  });
  await S.audit({ ...req.ctx, businessId }, 'create-user', 'users', id, role);
  res.json({ ok: true, id });
});

// Change a user's role in a business. { role, businessId? }
adminRouter.put('/users/:id/membership', requireAdmin, async (req, res) => {
  const businessId = targetBusiness(req);
  const role = String(req.body?.role || '');
  if (!ROLES.includes(role)) return bad(res, 'Role must be admin or support.');
  const m = (await q('SELECT role FROM memberships WHERE user_id = ? AND business_id = ?', [req.params.id, businessId]))[0];
  if (!m) return bad(res, 'This user is not in this business.', 404, 'not-found');
  if (m.role === 'admin' && role !== 'admin' && await adminCount(businessId) <= 1) {
    return bad(res, 'A business needs at least one admin.', 409, 'last-admin');
  }
  await q('UPDATE memberships SET role = ? WHERE user_id = ? AND business_id = ?', [role, req.params.id, businessId]);
  await S.audit({ ...req.ctx, businessId }, 'set-role', 'users', req.params.id, role);
  res.json({ ok: true });
});

// Remove a user from a business (the login itself stays for other businesses).
adminRouter.delete('/users/:id/membership', requireAdmin, async (req, res) => {
  const businessId = targetBusiness(req);
  const m = (await q('SELECT role FROM memberships WHERE user_id = ? AND business_id = ?', [req.params.id, businessId]))[0];
  if (!m) return res.json({ ok: true });
  if (m.role === 'admin' && await adminCount(businessId) <= 1) return bad(res, 'A business needs at least one admin.', 409, 'last-admin');
  await q('DELETE FROM memberships WHERE user_id = ? AND business_id = ?', [req.params.id, businessId]);
  await q('UPDATE sessions SET business_id = NULL WHERE user_id = ? AND business_id = ?', [req.params.id, businessId]);
  await S.audit({ ...req.ctx, businessId }, 'remove-user', 'users', req.params.id);
  res.json({ ok: true });
});

// Set a new password for a user. A business admin may only do this for users
// who belong to their business alone (never a super admin, never someone who
// also works for another business).
adminRouter.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
  const user = (await q('SELECT id, is_super_admin FROM users WHERE id = ?', [req.params.id]))[0];
  if (!user) return bad(res, 'Not found', 404, 'not-found');
  if (!req.ctx.user.isSuperAdmin) {
    const mems = await q('SELECT business_id FROM memberships WHERE user_id = ?', [user.id]);
    const onlyHere = mems.length > 0 && mems.every((m) => m.business_id === req.ctx.businessId);
    if (user.is_super_admin || !onlyHere) return bad(res, 'Only the super admin can reset this user\'s password.', 403, 'forbidden');
  }
  const problem = passwordProblem(req.body?.password);
  if (problem) return bad(res, problem);
  await q('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [await hashPassword(req.body.password), user.id]);
  await destroyUserSessions(user.id);
  await S.audit(req.ctx, 'reset-password', 'users', user.id);
  res.json({ ok: true });
});

// Super admin: rename, enable/disable a login everywhere.
adminRouter.patch('/users/:id', requireSuperAdmin, async (req, res) => {
  const { name, status } = req.body || {};
  if (req.params.id === req.ctx.user.id && status === 'disabled') return bad(res, 'You cannot disable your own login.');
  if (name !== undefined) await q('UPDATE users SET name = ? WHERE id = ?', [String(name).slice(0, 200), req.params.id]);
  if (status !== undefined) {
    if (!['active', 'disabled'].includes(status)) return bad(res, 'Invalid status');
    await q('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id]);
    if (status === 'disabled') await destroyUserSessions(req.params.id);
  }
  await S.audit(req.ctx, 'update-user', 'users', req.params.id, JSON.stringify(req.body || {}).slice(0, 300));
  res.json({ ok: true });
});

// Activity log: a business admin sees their business's; the super admin any.
adminRouter.get('/audit', requireAdmin, async (req, res) => {
  const businessId = targetBusiness(req);
  const rows = await q(`SELECT a.at, a.action, a.collection, a.record_id, a.detail, u.email
                          FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                         WHERE a.business_id = ? ORDER BY a.id DESC LIMIT 200`, [businessId]);
  res.json(rows);
});
