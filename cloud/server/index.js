// GST Portal - hosted, multi-business server. Start: node cloud/server/index.js
// (settings from environment / GSP_ENV_FILE, see config.js and cloud/README.md).
import { config } from './config.js';
import { migrate, q, closePool } from './db.js';
import { createApp } from './app.js';
import { processDueRecurring } from './recurring.js';

if (!config.db.password) {
  console.error('  GSP_DB_PASSWORD is not set. See cloud/README.md.');
  process.exit(1);
}

await migrate();
const app = createApp();
const server = app.listen(config.port, config.host, () => {
  console.log(`  GST Portal listening on http://${config.host}:${config.port}  (public: ${config.publicOrigin}, db: ${config.db.database})`);
});

// Housekeeping: recurring invoices hourly; trash older than 30 days and old
// login attempts / sessions daily.
async function housekeeping() {
  try {
    await q("DELETE FROM records WHERE collection = 'bills-trash' AND updated_at < UTC_TIMESTAMP(3) - INTERVAL 30 DAY");
    await q('DELETE FROM login_attempts WHERE at < UTC_TIMESTAMP(3) - INTERVAL 30 DAY');
    await q('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP(3)');
  } catch (err) { console.error('  [housekeeping]', err.message); }
}
const timers = [];
if (config.runRecurring) {
  timers.push(setTimeout(() => processDueRecurring().catch((e) => console.error('  [recurring]', e.message)), 5000));
  timers.push(setInterval(() => processDueRecurring().catch((e) => console.error('  [recurring]', e.message)), 60 * 60 * 1000));
}
timers.push(setTimeout(housekeeping, 15000));
timers.push(setInterval(housekeeping, 24 * 60 * 60 * 1000));

function shutdown(signal) {
  console.log(`  ${signal}: closing`);
  timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
  server.close(async () => { await closePool(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('  [unhandledRejection]', err));
