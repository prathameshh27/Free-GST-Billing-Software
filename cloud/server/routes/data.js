// The /api/* routes the app's screens use (src/store.js), ported from the
// desktop server.js and scoped to the logged-in business. Request and
// response shapes match server.js so the frontend works unchanged.
//
// Every handler reads the business from req.ctx.businessId (set by the
// session), never from the request.
import express from 'express';
import { validateCashEntry, cleanCashEntry } from '../../../src/utils/cashBook.js';
import { validatePurchasePayments } from '../../../src/utils/purchasePayments.js';
import { nextCounterValue, numberSeriesFor, counterKeyFor, formatDocNumber, businessKeyOf, INVOICE_TYPES } from '../../../src/utils.js';
import { tx } from '../db.js';
import * as S from '../store.js';
import { generateFromTemplate, templateHasEnded, localToday } from '../recurring.js';

export const dataRouter = express.Router();

const biz = (req) => req.ctx.businessId;
const uid = (req) => req.ctx.user.id;
const bad = (res, msg = 'Invalid request', code = 'bad-request', status = 400) => res.status(status).json({ error: msg, code });
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 191;
const byName = (field) => (a, b) => String(a[field] || '').localeCompare(String(b[field] || ''));
const byDateDesc = (field) => (a, b) => new Date(b[field]) - new Date(a[field]);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Simple collections: list / save (id generated when missing) / delete.
// ---------------------------------------------------------------------------
function simpleCollection(route, collection, prefix, sort, { beforeSave, noDelete } = {}) {
  dataRouter.get(`/${route}`, async (req, res) => {
    const rows = await S.list(biz(req), collection);
    if (sort) rows.sort(sort);
    res.json(rows);
  });
  dataRouter.post(`/${route}`, async (req, res) => {
    const item = req.body;
    if (!isObj(item)) return bad(res);
    if (item.id !== undefined && item.id !== '' && !validId(item.id)) return bad(res);
    if (beforeSave) {
      const problem = beforeSave(item);
      if (problem) return bad(res, problem);
    }
    if (!item.id) item.id = S.newId(prefix);
    await S.put(biz(req), collection, item, uid(req));
    await S.audit(req.ctx, 'save', collection, item.id);
    res.json({ success: true, id: item.id });
  });
  if (!noDelete) {
    dataRouter.delete(`/${route}/:id`, async (req, res) => {
      await S.remove(biz(req), collection, req.params.id, uid(req));
      await S.audit(req.ctx, 'delete', collection, req.params.id);
      res.json({ success: true });
    });
  }
}

simpleCollection('clients', 'clients', 'cli', byName('name'));
simpleCollection('products', 'products', 'prod', byName('name'), {
  // v1.10.83 (#121) - a service has no stock, whoever saves it.
  beforeSave: (p) => { if (p.kind === 'service') delete p.stock; return null; },
});
simpleCollection('expenses', 'expenses', 'exp', byDateDesc('date'));
simpleCollection('recurring', 'recurring', 'rec', byName('clientName'));
simpleCollection('receipts', 'receipts', 'rcp', byDateDesc('date'));
simpleCollection('purchases', 'purchases', 'pur', byDateDesc('date'), {
  beforeSave: (p) => validatePurchasePayments(p),
});
simpleCollection('purchase-orders', 'purchase-orders', 'po',
  (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.poNumber || '').localeCompare(String(a.poNumber || '')),
  { noDelete: true }); // a PO is cancelled, never deleted
simpleCollection('profiles', 'profiles', 'biz', byName('businessName'));

// Terms templates: a default one is created the first time the list is empty.
const DEFAULT_TEMPLATE = {
  id: 'default',
  name: 'Standard Terms',
  content: '1. Payment is due within 15 days of invoice date unless otherwise agreed in writing.\n2. Interest @ 18% p.a. will be charged on overdue payments beyond the due date.\n3. The scope of work is limited to what is explicitly mentioned in the project proposal/agreement. Any additional requirements will be quoted and billed separately.\n4. All intellectual property and source code will be transferred to the client only upon receipt of full payment.\n5. We shall not be liable for any delays caused by incomplete or late submission of content, credentials, or approvals from the client\'s end.\n6. Any change requests after project approval may attract additional charges and revised timelines.\n7. This invoice is subject to the jurisdiction of courts at the service provider\'s registered location.\n8. E. & O.E.',
};
dataRouter.get('/templates', async (req, res) => {
  let rows = await S.list(biz(req), 'templates');
  if (rows.length === 0) {
    await S.put(biz(req), 'templates', DEFAULT_TEMPLATE, uid(req));
    rows = [DEFAULT_TEMPLATE];
  }
  rows.sort(byName('name'));
  res.json(rows);
});
dataRouter.post('/templates', async (req, res) => {
  const tpl = req.body;
  if (!isObj(tpl) || (tpl.id && !validId(tpl.id))) return bad(res);
  if (!tpl.id) tpl.id = S.newId('tpl');
  await S.put(biz(req), 'templates', tpl, uid(req));
  res.json({ success: true, id: tpl.id });
});
dataRouter.delete('/templates/:id', async (req, res) => {
  await S.remove(biz(req), 'templates', req.params.id, uid(req));
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Bills (every document type: invoices, quotations, estimates, credit notes...)
// ---------------------------------------------------------------------------
dataRouter.get('/bills', async (req, res) => {
  const bills = await S.list(biz(req), 'bills');
  bills.sort(byDateDesc('invoiceDate'));
  res.json(bills);
});

dataRouter.post('/bills', async (req, res) => {
  const bill = req.body;
  if (!isObj(bill) || !bill.id) return res.status(400).json({ error: 'Bill must have an id' });
  if (!validId(bill.id)) return bad(res);
  // The number is free text: never silently overwrite another bill (409),
  // unless the caller says it is an edit (?overwrite=1).
  const overwrite = req.query.overwrite === '1' || req.query.overwrite === 'true';
  if (!overwrite && await S.exists(biz(req), 'bills', bill.id)) {
    return res.status(409).json({ error: 'A bill with this invoice number already exists', invoiceNumber: bill.id });
  }
  await S.put(biz(req), 'bills', bill, uid(req));
  await S.audit(req.ctx, overwrite ? 'update' : 'create', 'bills', bill.id, bill.invoiceType);
  res.json({ success: true });
});

// A bill used as a client-credit source by another live bill can't be
// deleted silently (v1.10.31 Data-F9.1); ?force=1 overrides.
async function findCreditDependents(businessId, billId) {
  const dependents = [];
  for (const other of await S.list(businessId, 'bills')) {
    if (!other || other.id === billId) continue;
    const payments = other.payments || other.data?.payments || [];
    for (const p of payments) {
      if (p?.mode !== 'credit-applied') continue;
      if ((p?.creditSourceBillIds || []).includes(billId)) {
        dependents.push({ id: other.id, invoiceNumber: other.invoiceNumber, amount: p.amount });
        break;
      }
    }
  }
  return dependents;
}

dataRouter.delete('/bills/:id', async (req, res) => {
  const id = req.params.id;
  if (!await S.exists(biz(req), 'bills', id)) return res.json({ success: true });
  const force = req.query.force === '1' || req.query.force === 'true';
  if (!force) {
    const dependents = await findCreditDependents(biz(req), id);
    if (dependents.length > 0) {
      return res.status(409).json({
        error: 'client-credit-dependency',
        message: 'This bill was used as a client-credit source on another invoice. Deleting it would leave that invoice paid via credit that no longer has a real source.',
        dependents,
      });
    }
  }
  if (req.query.permanent === '1') {
    await S.purge(biz(req), 'bills', id);
    await S.audit(req.ctx, 'delete-forever', 'bills', id);
    return res.json({ success: true, permanent: true });
  }
  await S.move(biz(req), 'bills', 'bills-trash', id, uid(req));
  await S.audit(req.ctx, 'trash', 'bills', id);
  res.json({ success: true, trashed: true });
});

// Trash bin (soft-deleted bills, kept 30 days).
dataRouter.get('/trash', async (req, res) => {
  const rows = await S.listWithTimes(biz(req), 'bills-trash');
  res.json(rows.filter((r) => isObj(r.data)).map((r) => ({ ...r.data, _trashedAt: new Date(r.updatedAt).toISOString() })));
});
dataRouter.post('/trash/:id/restore', async (req, res) => {
  const id = req.params.id;
  if (!await S.exists(biz(req), 'bills-trash', id)) return res.status(404).json({ error: 'Not in trash' });
  // A new bill may have taken this number since: never replace it.
  if (await S.exists(biz(req), 'bills', id)) return res.status(409).json({ error: 'An invoice with this number exists again. Rename or delete it first.' });
  await S.move(biz(req), 'bills-trash', 'bills', id, uid(req));
  await S.audit(req.ctx, 'restore', 'bills', id);
  res.json({ success: true });
});
dataRouter.delete('/trash/:id', async (req, res) => {
  await S.purge(biz(req), 'bills-trash', req.params.id);
  await S.audit(req.ctx, 'delete-forever', 'bills', req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Production (manufacturing): the entry and the stock it moves are saved in
// ONE transaction - never half saved, and no other save runs in between.
// ---------------------------------------------------------------------------
async function applyStockMoves(conn, businessId, changes, skipMissing, userId) {
  if (!isObj(changes)) throw { status: 400, code: 'bad-request' };
  for (const [id, change] of Object.entries(changes)) {
    if (typeof change !== 'number' || !Number.isFinite(change)) throw { status: 400, code: 'bad-request' };
    const [rows] = await conn.query(
      'SELECT data FROM records WHERE business_id = ? AND collection = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
      [businessId, 'products', id]);
    const product = rows.length ? (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data) : null;
    if (!product) { if (skipMissing) continue; throw { status: 400, code: 'Product not found. Reload the page and try again.' }; }
    if (product.kind === 'service') continue; // #121 - no stock to move
    const after = { ...product, stock: Math.round(((Number(product.stock) || 0) + change) * 1000) / 1000 };
    await S.put(businessId, 'products', after, userId, conn);
  }
}

dataRouter.get('/productions', async (req, res) => {
  const rows = await S.list(biz(req), 'productions');
  rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json(rows);
});
dataRouter.post('/productions', async (req, res) => {
  const entry = req.body;
  if (!isObj(entry) || !validId(entry.id)) return bad(res);
  // Never saved twice: a second save would move the stock a second time.
  if (await S.exists(biz(req), 'productions', entry.id)) return bad(res, 'Conflict with existing resource', 'conflict', 409);
  try {
    await tx(async (conn) => {
      await applyStockMoves(conn, biz(req), entry.stockApplied, false, uid(req));
      await S.put(biz(req), 'productions', entry, uid(req), conn);
    });
  } catch (err) {
    if (err?.status) return bad(res, err.code, err.code, err.status);
    throw err;
  }
  await S.audit(req.ctx, 'create', 'productions', entry.id);
  res.json({ success: true, id: entry.id });
});
dataRouter.delete('/productions/:id', async (req, res) => {
  const entry = await S.get(biz(req), 'productions', req.params.id);
  if (!entry) return bad(res, 'Not found', 'not-found', 404);
  const back = {};
  for (const [id, change] of Object.entries(entry.stockApplied || {})) back[id] = -(Number(change) || 0);
  try {
    await tx(async (conn) => {
      await applyStockMoves(conn, biz(req), back, true, uid(req));
      await S.remove(biz(req), 'productions', req.params.id, uid(req), conn);
    });
  } catch (err) {
    if (err?.status) return bad(res, err.code, err.code, err.status);
    throw err;
  }
  await S.audit(req.ctx, 'delete', 'productions', req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Cash book: checked with the same rules as the form, only known fields kept.
// ---------------------------------------------------------------------------
dataRouter.get('/cash-book', async (req, res) => {
  const rows = await S.list(biz(req), 'cash-book');
  rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json(rows);
});
dataRouter.post('/cash-book', async (req, res) => {
  const problem = validateCashEntry(req.body);
  if (problem) return bad(res, problem);
  const entry = cleanCashEntry(req.body);
  if (!entry.id) entry.id = 'cash_' + Date.now().toString(36) + S.newId('x').slice(-6);
  else entry.updatedAt = new Date().toISOString();
  if (!validId(entry.id)) return bad(res);
  await S.put(biz(req), 'cash-book', entry, uid(req));
  await S.audit(req.ctx, 'save', 'cash-book', entry.id);
  res.json({ success: true, id: entry.id, entry });
});
dataRouter.delete('/cash-book/:id', async (req, res) => {
  await S.remove(biz(req), 'cash-book', req.params.id, uid(req));
  await S.audit(req.ctx, 'delete', 'cash-book', req.params.id);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Profile (the business's own details; was profile.json)
// ---------------------------------------------------------------------------
dataRouter.head('/profile', (req, res) => res.status(200).end());
dataRouter.get('/profile', async (req, res) => {
  res.json(await S.getProfile(biz(req)));
});
dataRouter.post('/profile', async (req, res) => {
  if (!isObj(req.body)) return bad(res);
  await S.setMeta(biz(req), S.PROFILE_KEY, req.body);
  await S.audit(req.ctx, 'save', 'profile');
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Meta: settings and number counters (was meta.json). "__" keys are internal.
// ---------------------------------------------------------------------------
const LOCK_KEY = 'appLock';
const forbiddenKey = (k) => k === LOCK_KEY || k.startsWith('__') || k.length > 191;

dataRouter.get('/meta/:key', async (req, res) => {
  if (forbiddenKey(req.params.key)) return bad(res, 'Refused', 'forbidden', 403);
  const v = await S.getMeta(biz(req), req.params.key);
  res.json({ value: v ?? null });
});
dataRouter.post('/meta/:key', async (req, res) => {
  if (forbiddenKey(req.params.key)) return bad(res, 'Refused', 'forbidden', 403);
  if (!req.body || !('value' in req.body)) return bad(res);
  await S.setMeta(biz(req), req.params.key, req.body.value);
  res.json({ success: true });
});
// A hand-typed number ahead of the counter moves the counter up (never down).
dataRouter.post('/meta/:key/raise', async (req, res) => {
  if (!/^counter_/.test(req.params.key) || forbiddenKey(req.params.key)) return bad(res);
  const value = Math.floor(Number(req.body?.value));
  if (!Number.isFinite(value) || value < 1 || value > 999999999) return bad(res);
  await S.ensureMeta(biz(req), req.params.key);
  const out = await tx(async (conn) => {
    const current = Math.max(0, Math.floor(Number(await S.lockMeta(conn, biz(req), req.params.key)) || 0));
    if (value > current) await S.setMeta(biz(req), req.params.key, value, conn);
    return Math.max(value, current);
  });
  res.json({ value: out });
});
// Atomic counter: the row is locked for the transaction, so two users saving
// at the same moment can never get the same invoice number.
dataRouter.post('/meta/:key/increment', async (req, res) => {
  if (forbiddenKey(req.params.key)) return bad(res, 'Refused', 'forbidden', 403);
  await S.ensureMeta(biz(req), req.params.key);
  const next = await tx(async (conn) => {
    const current = await S.lockMeta(conn, biz(req), req.params.key);
    const n = nextCounterValue(current, req.body?.start);
    await S.setMeta(biz(req), req.params.key, n, conn);
    return n;
  });
  res.json({ value: next });
});

// An own number series follows a business renamed or re-registered (GSTIN).
dataRouter.post('/number-series/rename', async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to || typeof from !== 'string' || typeof to !== 'string' || from === to) return bad(res);
  await S.ensureMeta(biz(req), 'invoiceNumberSeries');
  const moved = await tx(async (conn) => {
    const series = (await S.lockMeta(conn, biz(req), 'invoiceNumberSeries')) || {};
    if (!series[from] || series[to]) return false;
    series[to] = series[from];
    delete series[from];
    await S.setMeta(biz(req), 'invoiceNumberSeries', series, conn);
    const [rows] = await conn.query(
      "SELECT k, v FROM business_meta WHERE business_id = ? AND k LIKE 'counter\\_%' FOR UPDATE", [biz(req)]);
    const vals = Object.fromEntries(rows.map((r) => [r.k, typeof r.v === 'string' ? JSON.parse(r.v) : r.v]));
    for (const key of Object.keys(vals)) {
      if (key.endsWith(`@${from}`)) {
        const target = key.slice(0, -from.length) + to;
        await S.setMeta(biz(req), target, Math.max(Number(vals[target]) || 0, Number(vals[key]) || 0), conn);
        await S.deleteMeta(biz(req), key, conn);
      }
    }
    return true;
  });
  res.json({ moved });
});

// ---------------------------------------------------------------------------
// Browser settings mirror (was local-prefs.json). Kept per BUSINESS: most of
// these are the business's set-up (print layout, letterhead, signature,
// modules, region, units), which every user of the business must share.
// Support users' changes stay in their own browser only (read-only).
// { set: { key: string }, remove: [key] } - merged, never replaced wholesale.
// ---------------------------------------------------------------------------
const PREFS_KEY = '__localPrefs';
dataRouter.get('/local-prefs', async (req, res) => {
  res.json({ value: (await S.getMeta(biz(req), PREFS_KEY)) || {} });
});
dataRouter.post('/local-prefs', express.json({ limit: '25mb' }), async (req, res) => {
  const { set = {}, remove = [] } = req.body || {};
  if (!isObj(set) || !Array.isArray(remove)) return bad(res);
  if (req.ctx.role === 'support') return res.json({ success: true, saved: false });
  await S.ensureMeta(biz(req), PREFS_KEY);
  await tx(async (conn) => {
    const prefs = (await S.lockMeta(conn, biz(req), PREFS_KEY)) || {};
    for (const [k, v] of Object.entries(set)) if (typeof v === 'string') prefs[k] = v;
    for (const k of remove) delete prefs[String(k)];
    await S.setMeta(biz(req), PREFS_KEY, prefs, conn);
  });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Export / import (one business at a time)
// ---------------------------------------------------------------------------
const EXPORT_COLLECTIONS = {
  bills: 'bills', clients: 'clients', termsTemplates: 'templates', products: 'products',
  expenses: 'expenses', recurring: 'recurring', receipts: 'receipts', profiles: 'profiles',
  purchases: 'purchases', productions: 'productions', purchaseOrders: 'purchase-orders', cashBook: 'cash-book',
};

dataRouter.get('/export', async (req, res) => {
  const out = { profile: await S.getProfile(biz(req)) };
  for (const [key, coll] of Object.entries(EXPORT_COLLECTIONS)) out[key] = await S.list(biz(req), coll);
  out.meta = await S.allMeta(biz(req));
  out.exportedAt = new Date().toISOString();
  res.json(out);
});

dataRouter.post('/import', async (req, res) => {
  const data = req.body;
  if (!isObj(data)) return bad(res);
  const overwrite = req.query.overwrite === '1' || req.query.overwrite === 'true';
  const names = {
    bills: 'bill', clients: 'client', termsTemplates: 'template', products: 'product', expenses: 'expense',
    recurring: 'recurring', receipts: 'receipt', profiles: 'profile', purchases: 'purchase',
    productions: 'production', purchaseOrders: 'purchaseOrder', cashBook: 'cashBook',
  };
  const counts = {};
  for (const n of Object.values(names)) { counts[`${n}Count`] = 0; counts[`${n}Skipped`] = 0; }

  if (isObj(data.profile)) {
    const has = (await S.getMeta(biz(req), S.PROFILE_KEY)) !== undefined;
    if (overwrite || !has) await S.setMeta(biz(req), S.PROFILE_KEY, data.profile);
  }
  for (const [key, coll] of Object.entries(EXPORT_COLLECTIONS)) {
    for (let entity of Array.isArray(data[key]) ? data[key] : []) {
      if (!isObj(entity) || !validId(String(entity.id ?? ''))) continue;
      if (key === 'cashBook') {
        if (validateCashEntry(entity)) { counts.cashBookSkipped++; continue; }
        entity = cleanCashEntry(entity);
      }
      if (!overwrite && await S.exists(biz(req), coll, entity.id)) { counts[`${names[key]}Skipped`]++; continue; }
      await S.put(biz(req), coll, entity, uid(req));
      counts[`${names[key]}Count`]++;
    }
  }

  // Meta: replace on overwrite, else merge keeping the higher counters.
  if (isObj(data.meta)) {
    const incoming = Object.fromEntries(Object.entries(data.meta).filter(([k]) => !forbiddenKey(k)));
    const current = await S.allMeta(biz(req));
    if (overwrite || Object.keys(current).length === 0) {
      for (const [k, v] of Object.entries(incoming)) await S.setMeta(biz(req), k, v);
    } else {
      const series = { ...(incoming.invoiceNumberSeries || {}), ...(current.invoiceNumberSeries || {}) };
      if (Object.keys(series).length) await S.setMeta(biz(req), 'invoiceNumberSeries', series);
      if (Array.isArray(incoming.costCentres)) {
        const have = new Set((current.costCentres || []).map((c) => c?.id));
        const added = incoming.costCentres.filter((c) => c?.id && !have.has(c.id));
        if (added.length) await S.setMeta(biz(req), 'costCentres', [...(current.costCentres || []), ...added]);
      }
      for (const [k, v] of Object.entries(incoming)) {
        if (k.startsWith('counter_') && Number(v) > (Number(current[k]) || 0)) await S.setMeta(biz(req), k, Number(v));
      }
    }
  }

  // Counters never behind the numbers of the bills now stored (v1.10.31 Data-F12.2).
  try {
    const meta = await S.allMeta(biz(req));
    const maxByPrefix = {};
    const maxByKey = {};
    for (const bill of await S.list(biz(req), 'bills')) {
      const num = String(bill?.invoiceNumber || bill?.id || '');
      const m = num.match(/^([A-Z]+)[\W_].*?(\d+)\s*$/i);
      if (!m) continue;
      const prefix = m[1].toUpperCase();
      const suffix = parseInt(m[2], 10);
      if (!Number.isFinite(suffix)) continue;
      if (!maxByPrefix[prefix] || suffix > maxByPrefix[prefix]) maxByPrefix[prefix] = suffix;
      const typePrefix = INVOICE_TYPES[bill.invoiceType || bill.data?.invoiceType || 'tax-invoice']?.prefix;
      if (typePrefix) {
        const bk = businessKeyOf(bill.data?.profile || { gstin: bill.ownerGstin, businessName: bill.ownerName });
        const series = numberSeriesFor(meta.invoiceNumberSettings, meta.invoiceNumberSeries, bk);
        const head = formatDocNumber({ settings: { ...series, format: 'sequential', showFinYear: false }, typePrefix, next: 0 }).replace(/0+$/, '');
        if (num.toUpperCase().startsWith(head.toUpperCase())) {
          const key = counterKeyFor(typePrefix, series, bk);
          if (!maxByKey[key] || suffix > maxByKey[key]) maxByKey[key] = suffix;
        }
      }
    }
    const wanted = { ...Object.fromEntries(Object.entries(maxByPrefix).map(([p, n]) => [`counter_${p}`, n])), ...maxByKey };
    for (const [key, maxNum] of Object.entries(wanted)) {
      if (maxNum > (Number(meta[key]) || 0)) await S.setMeta(biz(req), key, maxNum);
    }
  } catch (err) {
    console.error('  Post-import counter reconciliation failed:', err);
  }
  await S.audit(req.ctx, 'import', null, null, JSON.stringify(counts).slice(0, 500));
  res.json({ ...counts, hasProfile: !!data.profile });
});

// ---------------------------------------------------------------------------
// Recurring: "Generate Now" (same code as the hourly auto-fire).
// ---------------------------------------------------------------------------
dataRouter.post('/recurring/:id/generate', async (req, res) => {
  const tpl = await S.get(biz(req), 'recurring', req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Recurring template not found' });
  const today = localToday();
  if (templateHasEnded(tpl, today)) {
    return res.status(409).json({ error: 'This template has reached its end date or number of invoices' });
  }
  const invoiceNumber = await generateFromTemplate(biz(req), tpl, today, uid(req));
  await S.audit(req.ctx, 'create', 'bills', invoiceNumber, 'recurring');
  res.json({ success: true, invoiceNumber });
});
