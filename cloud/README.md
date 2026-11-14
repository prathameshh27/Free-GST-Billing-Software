# GST Portal: the hosted, multi-business version

This fork adds a hosted web version of Free GST Billing Software: one app on
a server, used in the browser by several businesses, each with its own data
and users, behind a login, with the data in MySQL.

Live: **https://130-210-127-108.sslip.io** (Oracle Cloud Always Free VM `free-vm`, database `free-mysql`).

The original desktop app (`server.js`, file storage, PIN lock) is unchanged and
still builds as before. Everything cloud-specific lives in `cloud/` and
`src/cloud/`, plus a few small hooks marked `[cloud]`.

## Roles

| Role | Who | Can |
|---|---|---|
| **Super admin** | the operator | every business: open any, create / rename / disable businesses, manage all users, overview of all businesses |
| **Admin** | per business | everything in their business: documents, clients, products, settings, and that business's users |
| **Support** | per business | **read-only**: view and print; every change is refused by the server |

One login can belong to several businesses with a different role in each; the
sidebar's business menu switches between them.

## How it works

```
browser ──HTTPS──> Caddy :443 ──> node cloud/server :3000 ──TLS──> MySQL HeatWave (gst_portal)
                   (Let's Encrypt)   serves dist/ + /api/*
```

- `cloud/server/` answers the same `/api/*` requests the screens already make
  (`src/store.js`), with the same request/response shapes as `server.js`.
- Storage: one `records` table (business_id, collection, id, JSON data) holds
  what the desktop app kept as `data/<collection>/<id>.json`; `business_meta`
  holds profile, settings and number counters. See `cloud/server/migrations/`.
- Every query takes the business from the **session**, never from the request.
- Invoice-number counters are incremented under a row lock; deadlocks retry.
- Deleted bills go to `bills-trash` (30 days); other deletes are tombstones
  (`deleted_at`), kept for a future offline-sync client.
- Sessions: random token in an httpOnly, Secure, SameSite=Strict cookie; only
  its SHA-256 is stored. Passwords: scrypt. Login: 5 failures / 15 min per
  email, 20 per IP. Writes from other origins are refused.
- Browser settings (print layout, letterhead, modules...) are shared per
  business; a browser switching user/business clears and reloads them.
- The cloud build keeps no API responses in the offline cache.
- Recurring invoices fire hourly for every active business.
- Audit log of who created / changed / deleted what (`/api/admin/audit`).

Desktop-only features (Control Panel, PIN lock, update check, backup folders,
saving PDFs to disk) are hidden in the cloud build and answered harmlessly.

## Local development

1. `cp cloud/env.example cloud/.env.local` and set `GSP_DB_PASSWORD`
   (development uses the `gst_portal_dev` database).
2. `npm run dev:cloud` then open http://localhost:5173.
3. First login: `npm run cloud:cli -- create-superadmin you@example.com "Your Name"`.

Tests (they wipe `gst_portal_dev`; they refuse to run on any other database):

```bash
npm run test:cloud
```

## Deploying

```bash
bash cloud/deploy/deploy.sh
```

Builds here, uploads, installs production dependencies on the server, swaps
`/opt/gst-portal` (previous version kept in `/opt/gst-portal.prev`), restarts.

### On the server

| What | Where |
|---|---|
| App | `/opt/gst-portal`, service `gst-portal` (user `gstportal`) |
| Settings (DB password) | `/etc/gst-portal/env` (root:gstportal, 640) |
| HTTPS | Caddy, `/etc/caddy/Caddyfile` |
| Backups | `/var/backups/gst-portal/gst_portal-YYYY-MM-DD.sql.gz`, nightly 02:30 IST, 7 kept (`gst-portal-backup.timer`) |
| Logs | `journalctl -u gst-portal`, `/var/log/caddy/gst-portal.log` |

Operator commands (on the server):

```bash
cd /opt/gst-portal
sudo -u gstportal GSP_ENV_FILE=/etc/gst-portal/env node cloud/server/cli.js create-superadmin you@example.com "Your Name"
sudo -u gstportal GSP_ENV_FILE=/etc/gst-portal/env node cloud/server/cli.js reset-password someone@example.com
sudo -u gstportal GSP_ENV_FILE=/etc/gst-portal/env node cloud/server/cli.js list-users
```

Restore a backup into the live database (stops the app first):

```bash
sudo systemctl stop gst-portal
gunzip -c /var/backups/gst-portal/gst_portal-2026-11-14.sql.gz | MYSQL_PWD=... mysql -h 10.0.0.124 -u gst_app --ssl-mode=REQUIRED gst_portal
sudo systemctl start gst-portal
```

## Pulling the original author's updates

```bash
git fetch upstream
git merge upstream/main
npm install && npm test && npm run test:cloud && npm run build:cloud
```

Conflicts are limited to the `[cloud]` hooks in `src/App.jsx`, `src/main.jsx`,
`src/store.js`, `vite.config.js`, `eslint.config.js` and `package.json`. If the
author adds a new `/api/...` route used by the screens, add it to
`cloud/server/routes/data.js` (scoped to `biz(req)`).

## Planned (phase 2)

An offline desktop app that syncs with this server when online. Needs
per-device invoice-number blocks and conflict handling; the schema already
keeps `updated_at`, tombstones and the audit log for it.
