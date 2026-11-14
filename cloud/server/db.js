// MySQL connection pool + schema migrations.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { config } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let pool = null;

export function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    // HeatWave requires TLS for gst_app (REQUIRE SSL). Its certificate is
    // signed by Oracle's private CA, so the link is encrypted but the
    // certificate is not checked against a public CA.
    ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 8,
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    multipleStatements: false,
  });
  return pool;
}

export const q = async (sql, params = []) => (await getPool().query(sql, params))[0];

// Runs fn(conn) in a transaction; commits on success, rolls back on throw.
export async function tx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection gone */ }
    throw err;
  } finally {
    conn.release();
  }
}

// Applies migrations/NNN_*.sql in order, once each.
export async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) NOT NULL PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))`);
  const done = new Set((await q('SELECT version FROM schema_migrations')).map((r) => r.version));
  const dir = path.join(here, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // Split on ; at line end (the schema files contain no ; inside strings).
    const statements = sql.split(/;\s*$/m).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    for (const s of statements) await q(s);
    await q('INSERT INTO schema_migrations (version) VALUES (?)', [f]);
    console.log(`  [db] applied ${f}`);
  }
}

export async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}
