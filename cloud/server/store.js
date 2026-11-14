// Tenant-scoped storage. Every function takes the business id first, which the
// routes always take from the session (req.ctx.businessId) - never from the
// request - so one business can never read or write another's rows.
//
// It mirrors the desktop server's file helpers (readAllFromDir, readJSON,
// writeJSON, deleteFile) so the ported route handlers stay close to the
// originals in server.js.
import crypto from 'crypto';
import { q, tx } from './db.js';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// ---- documents (records table) ------------------------------------------

export async function list(businessId, collection) {
  const rows = await q(
    'SELECT data FROM records WHERE business_id = ? AND collection = ? AND deleted_at IS NULL',
    [businessId, collection],
  );
  return rows.map((r) => parse(r.data)).filter((v) => v && typeof v === 'object' && !Array.isArray(v));
}

// Rows with their timestamps (the Trash list needs when a bill was trashed).
export async function listWithTimes(businessId, collection) {
  const rows = await q(
    'SELECT data, updated_at FROM records WHERE business_id = ? AND collection = ? AND deleted_at IS NULL',
    [businessId, collection],
  );
  return rows.map((r) => ({ data: parse(r.data), updatedAt: r.updated_at }));
}

export async function get(businessId, collection, id, conn = null) {
  const sql = 'SELECT data FROM records WHERE business_id = ? AND collection = ? AND id = ? AND deleted_at IS NULL';
  const rows = conn ? (await conn.query(sql, [businessId, collection, String(id)]))[0] : await q(sql, [businessId, collection, String(id)]);
  return rows.length ? parse(rows[0].data) : null;
}

export async function exists(businessId, collection, id) {
  const rows = await q(
    'SELECT 1 FROM records WHERE business_id = ? AND collection = ? AND id = ? AND deleted_at IS NULL',
    [businessId, collection, String(id)],
  );
  return rows.length > 0;
}

// Insert or replace (also brings back a tombstoned id).
export async function put(businessId, collection, obj, userId = null, conn = null) {
  if (!obj || obj.id === undefined || obj.id === null || obj.id === '') throw new Error('record without id');
  const sql = `INSERT INTO records (business_id, collection, id, data, updated_by)
               VALUES (?, ?, ?, CAST(? AS JSON), ?)
               ON DUPLICATE KEY UPDATE data = VALUES(data), deleted_at = NULL, updated_by = VALUES(updated_by)`;
  const params = [businessId, collection, String(obj.id), JSON.stringify(obj), userId];
  if (conn) await conn.query(sql, params); else await q(sql, params);
}

// Tombstone (hidden from every list; kept for a future offline sync).
export async function remove(businessId, collection, id, userId = null, conn = null) {
  const sql = `UPDATE records SET deleted_at = CURRENT_TIMESTAMP(3), updated_by = ?
               WHERE business_id = ? AND collection = ? AND id = ? AND deleted_at IS NULL`;
  const params = [userId, businessId, collection, String(id)];
  if (conn) await conn.query(sql, params); else await q(sql, params);
}

// Gone for good (used for the bills Trash's "Delete forever" and its 30-day purge).
export async function purge(businessId, collection, id) {
  await q('DELETE FROM records WHERE business_id = ? AND collection = ? AND id = ?', [businessId, collection, String(id)]);
}

// Moves a document to another collection in one transaction (bill <-> bills-trash).
export async function move(businessId, fromCollection, toCollection, id, userId = null) {
  return tx(async (conn) => {
    const [rows] = await conn.query(
      'SELECT data FROM records WHERE business_id = ? AND collection = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
      [businessId, fromCollection, String(id)],
    );
    if (!rows.length) return false;
    await conn.query('DELETE FROM records WHERE business_id = ? AND collection = ? AND id = ?', [businessId, toCollection, String(id)]);
    await conn.query(
      'UPDATE records SET collection = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE business_id = ? AND collection = ? AND id = ?',
      [toCollection, userId, businessId, fromCollection, String(id)],
    );
    return true;
  });
}

// ---- meta (business_meta table) -----------------------------------------

export async function getMeta(businessId, key, conn = null) {
  const sql = 'SELECT v FROM business_meta WHERE business_id = ? AND k = ?';
  const rows = conn ? (await conn.query(sql, [businessId, key]))[0] : await q(sql, [businessId, key]);
  return rows.length ? parse(rows[0].v) : undefined;
}

export async function setMeta(businessId, key, value, conn = null) {
  const sql = `INSERT INTO business_meta (business_id, k, v) VALUES (?, ?, CAST(? AS JSON))
               ON DUPLICATE KEY UPDATE v = VALUES(v)`;
  const params = [businessId, key, JSON.stringify(value === undefined ? null : value)];
  if (conn) await conn.query(sql, params); else await q(sql, params);
}

export async function deleteMeta(businessId, key, conn = null) {
  const sql = 'DELETE FROM business_meta WHERE business_id = ? AND k = ?';
  if (conn) await conn.query(sql, [businessId, key]); else await q(sql, [businessId, key]);
}

// All public meta keys as one object (what meta.json was). Internal "__" keys left out.
export async function allMeta(businessId) {
  const rows = await q("SELECT k, v FROM business_meta WHERE business_id = ? AND k NOT LIKE '\\_\\_%'", [businessId]);
  return Object.fromEntries(rows.map((r) => [r.k, parse(r.v)]));
}

// Makes sure a meta row exists. Run OUTSIDE the transaction (autocommit): two
// transactions inserting the same new row at once deadlock in InnoDB.
export async function ensureMeta(businessId, key) {
  await q('INSERT IGNORE INTO business_meta (business_id, k, v) VALUES (?, ?, NULL)', [businessId, key]);
}

// Locks one meta key for the rest of the transaction and returns its value.
// Call ensureMeta(businessId, key) before starting the transaction.
export async function lockMeta(conn, businessId, key) {
  const [rows] = await conn.query('SELECT v FROM business_meta WHERE business_id = ? AND k = ? FOR UPDATE', [businessId, key]);
  return rows.length ? parse(rows[0].v) : null;
}

// ---- profile (was profile.json) -----------------------------------------

export const PROFILE_KEY = '__profile';
export const DEFAULT_PROFILE = {
  businessName: '', address: '', state: '', gstin: '', pan: '',
  email: '', phone: '', bankName: '', accountNumber: '', ifsc: '',
  logo: '', signature: '', upiId: '', googleClientId: '', googleDriveFolder: 'GST Billing Invoices',
};
export async function getProfile(businessId) {
  return (await getMeta(businessId, PROFILE_KEY)) || { ...DEFAULT_PROFILE };
}

// ---- ids ----------------------------------------------------------------

export const newId = (prefix) => `${prefix}_${Date.now()}${crypto.randomBytes(3).toString('hex')}`;

// ---- audit --------------------------------------------------------------

export async function audit(ctx, action, collection = null, recordId = null, detail = null) {
  try {
    await q(
      'INSERT INTO audit_log (business_id, user_id, action, collection, record_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ctx?.businessId || null, ctx?.user?.id || null, action, collection, recordId === null ? null : String(recordId).slice(0, 191), detail ? String(detail).slice(0, 500) : null, ctx?.ip || null],
    );
  } catch (err) {
    console.warn('  [audit] could not write:', err.message);
  }
}
