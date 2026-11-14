# GST Portal: the hosted, multi-business version

This fork adds a hosted web version of Free GST Billing Software: one app on
a server, used in the browser by several businesses, each with its own data
and users, behind a login, with the data in MySQL.

Live: **https://oms-in.duckdns.org** (free DuckDNS name pointed at 130.210.127.108; the first address https://130-210-127-108.sslip.io redirects to it) (Oracle Cloud Always Free VM `free-vm`, database `free-mysql`).

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

## First-time server setup (rebuilding from scratch)

What was done once on the current server, in order. `deploy.sh` does everything after step 6.

1. **Database:** copy `cloud/sql/bootstrap.sql.example`, set a password, run it once as the
   MySQL admin (creates `gst_portal`, `gst_portal_dev`, user `gst_app` with `REQUIRE SSL`).
2. **Packages:** Node.js 22 (NodeSource apt repo), Caddy (Caddy's stable apt repo),
   `mysql-client` (for the nightly dump), `iptables-persistent`.
3. **Service user:** `sudo useradd --system --no-create-home --shell /usr/sbin/nologin gstportal`
4. **Settings:** `/etc/gst-portal/env` from `cloud/env.example` with the production values
   (`GSP_PUBLIC_ORIGIN=https://oms-in.duckdns.org`, `GSP_COOKIE_SECURE=1`, `GSP_DB_HOST=10.0.0.124`,
   `GSP_DB_NAME=gst_portal`, `GSP_RUN_RECURRING=1`, `TZ=Asia/Kolkata`), owner `root:gstportal`, mode 640.
5. **Firewalls:** TCP 80 and 443 open in the cloud security list **and** in iptables
   (`sudo netfilter-persistent save`).
6. **Name:** DNS name pointed at the server's public IP (DuckDNS `oms-in`), and the same name in
   `cloud/deploy/Caddyfile` and `GSP_PUBLIC_ORIGIN`.
7. **Deploy:** `bash cloud/deploy/deploy.sh` (installs the systemd units, Caddyfile and backup timer).
8. **First login:** `cli.js create-superadmin <email> "<name>"` on the server (asks for the password).

## File map

| Path | What |
|---|---|
| `cloud/server/index.js` | start-up: migrations, HTTP server, hourly recurring invoices, daily housekeeping |
| `cloud/server/app.js` | Express app: security headers, body limits, routing, static `dist/`, desktop-only stand-ins |
| `cloud/server/auth.js` | passwords, sessions, rate limit, origin guard, role / business middleware |
| `cloud/server/store.js` | business-scoped storage on MySQL (records, meta, audit) |
| `cloud/server/db.js` | connection pool (TLS), transactions with deadlock retry, migrations |
| `cloud/server/routes/auth.js` | `/api/auth/*` |
| `cloud/server/routes/admin.js` | `/api/admin/*` |
| `cloud/server/routes/data.js` | the app's data routes, ported from `server.js` |
| `cloud/server/recurring.js` | recurring invoices (Generate Now + hourly auto-fire) |
| `cloud/server/cli.js` | operator commands (create-superadmin, reset-password, list-users) |
| `cloud/server/migrations/*.sql` | database schema, applied in order on start |
| `cloud/sql/bootstrap.sql.example` | one-time database + login creation (run as MySQL admin) |
| `cloud/deploy/` | `deploy.sh`, `Caddyfile`, systemd units, nightly `backup.sh` |
| `cloud/tests/api.test.mjs` | API tests (`npm run test:cloud`) |
| `cloud/scripts/` | `dev.mjs` (`npm run dev:cloud`), `build.mjs` (`npm run build:cloud`) |
| `cloud/env.example` | every setting, documented |
| `src/cloud/` | screens: `CloudGate` (sign-in, password, business picker), `AccountPanel` (sidebar), `AdminPanels` (Users, Businesses), `cloudSession` |

## Cloud-only API routes

All under `/api`, JSON, session cookie. Writes need the app's own `Origin`.

| Route | Who | Purpose |
|---|---|---|
| `POST /auth/login` `{email, password}` | anyone | sign in (sets the cookie) |
| `POST /auth/logout` | signed in | sign out |
| `GET /auth/me` | signed in | user, current business, role, businesses they can open |
| `POST /auth/switch-business` `{businessId}` | signed in | change the session's business |
| `POST /auth/change-password` `{currentPassword, newPassword}` | signed in | own password (logs out other devices) |
| `GET/POST /admin/businesses`, `PATCH /admin/businesses/:id` | super admin | list, create (with first admin), rename, GSTIN, disable |
| `GET /admin/overview` | super admin | per-business quotations, invoices, amount invoiced, last activity |
| `GET/POST /admin/users` | admin / super admin | list, create or add an existing login to the business |
| `PUT/DELETE /admin/users/:id/membership` | admin / super admin | change role / remove from business (last admin protected) |
| `POST /admin/users/:id/reset-password` | admin (own-business-only users) / super admin | temporary password, user must change it |
| `PATCH /admin/users/:id` | super admin | rename, disable / enable a login everywhere |
| `GET /admin/audit` | admin / super admin | last 200 activity entries of the business |

Every other `/api/*` route is the desktop app's contract (see `src/store.js`),
scoped to the session's business.

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
