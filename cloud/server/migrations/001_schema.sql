-- GST Portal (cloud) schema. Applied automatically by db.js on start-up.
-- Every business-owned row carries business_id; the server always takes it
-- from the logged-in session, never from the request.

CREATE TABLE IF NOT EXISTS businesses (
  id            VARCHAR(40)  NOT NULL PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  gstin         VARCHAR(20)  NULL,
  status        ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS users (
  id                    VARCHAR(40)  NOT NULL PRIMARY KEY,
  email                 VARCHAR(255) NOT NULL,
  name                  VARCHAR(200) NOT NULL DEFAULT '',
  password_hash         VARCHAR(255) NOT NULL,
  is_super_admin        TINYINT(1)   NOT NULL DEFAULT 0,
  status                ENUM('active','disabled') NOT NULL DEFAULT 'active',
  must_change_password  TINYINT(1)   NOT NULL DEFAULT 0,
  created_at            DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at         DATETIME(3)  NULL,
  UNIQUE KEY uq_users_email (email)
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id      VARCHAR(40) NOT NULL,
  business_id  VARCHAR(40) NOT NULL,
  role         ENUM('admin','support') NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, business_id),
  KEY ix_memberships_business (business_id),
  CONSTRAINT fk_mem_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_mem_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash    CHAR(64)    NOT NULL PRIMARY KEY,
  user_id       VARCHAR(40) NOT NULL,
  business_id   VARCHAR(40) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at    DATETIME(3) NOT NULL,
  ip            VARCHAR(64)  NULL,
  user_agent    VARCHAR(300) NULL,
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_expires (expires_at),
  CONSTRAINT fk_sess_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- One generic document table: what the desktop app kept as data/<collection>/<id>.json.
-- deleted_at = tombstone (kept for the future offline sync); bills deleted by the
-- user go to collection 'bills-trash' instead, exactly like data/trash/.
CREATE TABLE IF NOT EXISTS records (
  business_id  VARCHAR(40)  NOT NULL,
  collection   VARCHAR(40)  NOT NULL,
  id           VARCHAR(191) NOT NULL,
  data         JSON         NOT NULL,
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at   DATETIME(3)  NULL,
  updated_by   VARCHAR(40)  NULL,
  PRIMARY KEY (business_id, collection, id),
  KEY ix_records_list (business_id, collection, deleted_at),
  KEY ix_records_updated (business_id, updated_at),
  CONSTRAINT fk_rec_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

-- What the desktop app kept in profile.json + meta.json, one row per key.
-- Keys starting with "__" are internal (e.g. __profile) and never served by /api/meta.
CREATE TABLE IF NOT EXISTS business_meta (
  business_id  VARCHAR(40)  NOT NULL,
  k            VARCHAR(191) NOT NULL,
  v            JSON         NULL,
  updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (business_id, k),
  CONSTRAINT fk_meta_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

-- Browser settings mirror (was data/local-prefs.json), per user and business.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id      VARCHAR(40) NOT NULL,
  business_id  VARCHAR(40) NOT NULL DEFAULT '',
  prefs        JSON        NOT NULL,
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, business_id),
  CONSTRAINT fk_prefs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  business_id  VARCHAR(40)  NULL,
  user_id      VARCHAR(40)  NULL,
  action       VARCHAR(40)  NOT NULL,
  collection   VARCHAR(40)  NULL,
  record_id    VARCHAR(191) NULL,
  detail       VARCHAR(500) NULL,
  ip           VARCHAR(64)  NULL,
  KEY ix_audit_business (business_id, at),
  KEY ix_audit_user (user_id, at)
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id     BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  email  VARCHAR(255) NOT NULL,
  ip     VARCHAR(64)  NOT NULL,
  ok     TINYINT(1)   NOT NULL,
  KEY ix_login_email (email, at),
  KEY ix_login_ip (ip, at)
);
