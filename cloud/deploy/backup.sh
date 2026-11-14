#!/usr/bin/env bash
# Nightly MySQL dump of the live GST Portal database, 7 days kept.
# Installed as /opt/gst-portal-backup/backup.sh, run by gst-portal-backup.timer.
# Reads the database login from /etc/gst-portal/env (gst_app).
set -euo pipefail
# shellcheck disable=SC1091
set -a; . /etc/gst-portal/env; set +a
DIR=/var/backups/gst-portal
mkdir -p "$DIR"
chmod 700 "$DIR"
FILE="$DIR/gst_portal-$(date +%F).sql.gz"
MYSQL_PWD="$GSP_DB_PASSWORD" mysqldump \
  -h "$GSP_DB_HOST" -P "$GSP_DB_PORT" -u "$GSP_DB_USER" \
  --ssl-mode=REQUIRED --single-transaction --no-tablespaces --set-gtid-purged=OFF \
  --routines --triggers "$GSP_DB_NAME" | gzip -9 > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
chmod 600 "$FILE"
find "$DIR" -name 'gst_portal-*.sql.gz' -mtime +7 -delete
echo "backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
