// API tests for the cloud server. They run against a real MySQL database
// (gst_portal_dev, never the live one) and wipe it first.
//   npm run test:cloud      (reads cloud/.env.local)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.GSP_COOKIE_SECURE = '0';
process.env.GSP_PUBLIC_ORIGIN = 'http://test.local';
process.env.GSP_RUN_RECURRING = '0';
if (!/_dev$|_test$/.test(process.env.GSP_DB_NAME || '')) {
  throw new Error('Refusing to run: GSP_DB_NAME must end in _dev or _test (the tests wipe it).');
}

const { migrate, q, closePool } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { hashPassword } = await import('../server/auth.js');

let server, base;
const PW = 'Correct-horse-42';

// A tiny client that keeps its own session cookie.
function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: 'http://test.local', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
  return {
    get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), del: (p) => call('DELETE', p),
    put: (p, b = {}) => call('PUT', p, b), patch: (p, b = {}) => call('PATCH', p, b),
    login: (email, password = PW) => call('POST', '/api/auth/login', { email, password }),
  };
}

async function seedUser(id, email, superAdmin = false) {
  await q('INSERT INTO users (id, email, name, password_hash, is_super_admin) VALUES (?, ?, ?, ?, ?)', [id, email, email, await hashPassword(PW), superAdmin ? 1 : 0]);
}

before(async () => {
  await migrate();
  for (const t of ['audit_log', 'login_attempts', 'sessions', 'user_prefs', 'business_meta', 'records', 'memberships', 'users', 'businesses']) {
    await q(`DELETE FROM ${t}`);
  }
  await q("INSERT INTO businesses (id, name) VALUES ('biz_a', 'Alpha Traders'), ('biz_b', 'Beta Works')");
  await seedUser('usr_super', 'super@test.local', true);
  await seedUser('usr_a_admin', 'a-admin@test.local');
  await seedUser('usr_a_support', 'a-support@test.local');
  await seedUser('usr_b_admin', 'b-admin@test.local');
  await q(`INSERT INTO memberships (user_id, business_id, role) VALUES
    ('usr_a_admin','biz_a','admin'), ('usr_a_support','biz_a','support'), ('usr_b_admin','biz_b','admin')`);
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await closePool();
});

test('data routes need a login', async () => {
  const c = client();
  assert.equal((await c.get('/api/bills')).status, 401);
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('wrong password is refused, right one logs in', async () => {
  const c = client();
  assert.equal((await c.login('a-admin@test.local', 'nope-nope-1')).status, 401);
  assert.equal((await c.login('nobody@test.local')).status, 401);
  assert.equal((await c.login('a-admin@test.local')).status, 200);
  const me = await c.get('/api/auth/me');
  assert.equal(me.body.business.id, 'biz_a');
  assert.equal(me.body.role, 'admin');
});

test('login is rate-limited after 5 failures', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) await c.login('ratelimit@test.local', 'wrong-pass-1');
  assert.equal((await c.login('ratelimit@test.local', 'wrong-pass-1')).status, 429);
});

test('writes from another site are refused', async () => {
  const c = client();
  await c.login('a-admin@test.local');
  const res = await fetch(base + '/api/clients', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('businesses are isolated from each other', async () => {
  const a = client(); await a.login('a-admin@test.local');
  const b = client(); await b.login('b-admin@test.local');
  assert.equal((await a.post('/api/bills', { id: 'QUO/0001', invoiceNumber: 'QUO/0001', invoiceType: 'quotation', invoiceDate: '2026-11-14', totalAmount: 118 })).status, 200);
  assert.equal((await a.post('/api/clients', { name: 'Hammer Industries' })).status, 200);
  // B sees none of it, even asking for A's ids directly.
  assert.deepEqual((await b.get('/api/bills')).body, []);
  assert.deepEqual((await b.get('/api/clients')).body, []);
  assert.equal((await b.del('/api/bills/QUO%2F0001')).status, 200); // no-op for B
  assert.equal((await a.get('/api/bills')).body.length, 1, "B's delete must not touch A's bill");
  // The same number may exist in both businesses.
  assert.equal((await b.post('/api/bills', { id: 'QUO/0001', invoiceNumber: 'QUO/0001', invoiceDate: '2026-11-14' })).status, 200);
  // B cannot switch into A.
  assert.equal((await b.post('/api/auth/switch-business', { businessId: 'biz_a' })).status, 403);
});

test('duplicate invoice number is refused unless overwrite', async () => {
  const a = client(); await a.login('a-admin@test.local');
  const bill = { id: 'INV/0007', invoiceNumber: 'INV/0007', invoiceDate: '2026-11-14' };
  assert.equal((await a.post('/api/bills', bill)).status, 200);
  assert.equal((await a.post('/api/bills', bill)).status, 409);
  assert.equal((await a.post('/api/bills?overwrite=1', { ...bill, status: 'paid' })).status, 200);
});

test('support is read-only', async () => {
  const s = client(); await s.login('a-support@test.local');
  const me = await s.get('/api/auth/me');
  assert.equal(me.body.role, 'support');
  assert.equal(me.body.readOnly, true);
  assert.ok((await s.get('/api/bills')).body.length >= 1, 'support can read');
  for (const [m, p] of [['post', '/api/bills'], ['post', '/api/clients'], ['del', '/api/bills/INV%2F0007'], ['post', '/api/profile'], ['post', '/api/meta/x'], ['post', '/api/meta/counter_INV/increment'], ['post', '/api/import']]) {
    const r = await s[m](p, { id: 'x', value: 1 });
    assert.equal(r.status, 403, `${m} ${p} should be refused`);
  }
  // The settings mirror answers OK but does not change the business's settings.
  const pr = await s.post('/api/local-prefs', { set: { gst_printSettings: '{"hacked":true}' } });
  assert.equal(pr.status, 200);
  assert.equal(pr.body.saved, false);
  assert.ok(!((await s.get('/api/local-prefs')).body.value.gst_printSettings || '').includes('hacked'));
  // And cannot manage users.
  assert.equal((await s.get('/api/admin/users')).status, 403);
});

test('counter increments never repeat under concurrency', async () => {
  const a = client(); await a.login('a-admin@test.local');
  const results = await Promise.all(Array.from({ length: 20 }, () => a.post('/api/meta/counter_TEST/increment', { start: 1 })));
  const values = results.map((r) => r.body.value).sort((x, y) => x - y);
  assert.deepEqual(values, Array.from({ length: 20 }, (_, i) => i + 1));
});

test('soft delete goes to trash and can be restored', async () => {
  const a = client(); await a.login('a-admin@test.local');
  await a.post('/api/bills', { id: 'INV/0100', invoiceNumber: 'INV/0100', invoiceDate: '2026-11-01' });
  assert.equal((await a.del('/api/bills/INV%2F0100')).body.trashed, true);
  assert.ok(!(await a.get('/api/bills')).body.some((b) => b.id === 'INV/0100'));
  assert.ok((await a.get('/api/trash')).body.some((b) => b.id === 'INV/0100' && b._trashedAt));
  assert.equal((await a.post('/api/trash/INV%2F0100/restore')).status, 200);
  assert.ok((await a.get('/api/bills')).body.some((b) => b.id === 'INV/0100'));
});

test('meta keys: internal ones are hidden', async () => {
  const a = client(); await a.login('a-admin@test.local');
  assert.equal((await a.get('/api/meta/__profile')).status, 403);
  assert.equal((await a.get('/api/meta/appLock')).status, 403);
  await a.post('/api/profile', { businessName: 'Alpha Traders', gstin: '27AAAAA0000A1Z5' });
  assert.equal((await a.get('/api/profile')).body.businessName, 'Alpha Traders');
});

test('business admin manages only their own business users', async () => {
  const a = client(); await a.login('a-admin@test.local');
  const created = await a.post('/api/admin/users', { email: 'new-support@test.local', name: 'New', password: PW, role: 'support' });
  assert.equal(created.status, 200);
  const list = (await a.get('/api/admin/users')).body;
  assert.ok(list.every((u) => u.memberships.every((m) => m.businessId === 'biz_a')));
  assert.ok(!list.some((u) => u.email === 'b-admin@test.local'));
  // Trying to target business B is ignored: it is added to A instead.
  await a.post('/api/admin/users', { email: 'sneaky@test.local', password: PW, role: 'admin', businessId: 'biz_b' });
  const inB = await q("SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'sneaky@test.local' AND m.business_id = 'biz_b'");
  assert.equal(inB.length, 0);
  // Cannot reset the password of B's admin or create businesses.
  assert.equal((await a.post('/api/admin/users/usr_b_admin/reset-password', { password: PW })).status, 403);
  assert.equal((await a.post('/api/admin/businesses', { name: 'X' })).status, 403);
  // The last admin cannot be demoted.
  await q("DELETE FROM memberships WHERE business_id = 'biz_a' AND role = 'admin' AND user_id <> 'usr_a_admin'");
  assert.equal((await a.put('/api/admin/users/usr_a_admin/membership', { role: 'support' })).status, 409);
});

test('super admin sees everything and can switch business', async () => {
  const s = client(); await s.login('super@test.local');
  const me = (await s.get('/api/auth/me')).body;
  assert.equal(me.user.isSuperAdmin, true);
  assert.ok(me.businesses.length >= 2);
  const created = await s.post('/api/admin/businesses', { name: 'Gamma Exports', admin: { email: 'g-admin@test.local', name: 'G', password: PW } });
  assert.equal(created.status, 200);
  assert.equal((await s.post('/api/auth/switch-business', { businessId: 'biz_b' })).status, 200);
  assert.ok((await s.get('/api/bills')).body.some((b) => b.id === 'QUO/0001'));
  const overview = (await s.get('/api/admin/overview')).body;
  assert.ok(overview.find((b) => b.id === 'biz_a').quotations >= 1);
  // New business admin can log in and lands in their business.
  const g = client(); await g.login('g-admin@test.local');
  assert.equal((await g.get('/api/auth/me')).body.business.name, 'Gamma Exports');
});

test('a disabled business is closed to its users', async () => {
  const s = client(); await s.login('super@test.local');
  await s.patch('/api/admin/businesses/biz_b', { status: 'disabled' });
  const b = client(); await b.login('b-admin@test.local');
  assert.equal((await b.get('/api/bills')).status, 409);
  await s.patch('/api/admin/businesses/biz_b', { status: 'active' });
});

test('logout ends the session', async () => {
  const a = client(); await a.login('a-admin@test.local');
  assert.equal((await a.get('/api/bills')).status, 200);
  await a.post('/api/auth/logout');
  // The client still sends the old cookie value: the server must reject it.
  assert.equal((await a.get('/api/bills')).status, 401);
});
