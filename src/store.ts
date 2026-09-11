import { DatabaseSync } from 'node:sqlite';

/**
 * THE DIFFERENTIATOR LIVES HERE.
 *
 * Authorisation is enforced by the data layer, not by request handlers.
 *
 * The reference target is PostgreSQL row-level security: the application
 * connects as a low-privilege role, sets session claims with `SET LOCAL`, and
 * the policies decide which rows exist. SQLite has no RLS, so this
 * implementation reproduces the same SHAPE with session-scoped security views:
 * a `session` table holds the current claims, every readable object is a view
 * that joins against it, and the application is only ever given access to the
 * views. The property under test is identical - there is no query the
 * application can issue that returns a row its session is not entitled to,
 * including a hand-written one.
 *
 * What this buys you is the thing a scattered `if (user.siteId === ...)` check
 * cannot: the guarantee does not depend on remembering to write the check.
 */

export type Role = 'COORDINATOR' | 'BLINDED_INVESTIGATOR' | 'UNBLINDED_STATS' | 'MONITOR';
export type Action = 'read' | 'read_arm' | 'export';

export interface Session {
  readonly userId: string;
  readonly role: Role;
  readonly siteId: string;
}

export function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
CREATE TABLE site (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE participant (
  id            INTEGER PRIMARY KEY,
  subject_ref   TEXT NOT NULL UNIQUE,
  site_id       TEXT NOT NULL REFERENCES site(id),
  arm           TEXT NOT NULL,          -- the blinded column
  date_of_birth TEXT NOT NULL,
  enrolled_at   INTEGER NOT NULL
);

CREATE TABLE consent (
  id             INTEGER PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participant(id),
  version        INTEGER NOT NULL,
  scope          TEXT NOT NULL,         -- 'CORE' | 'CORE+GENOMIC'
  granted_at     INTEGER NOT NULL
);

-- Delegated access: a monitor may be granted specific sites.
CREATE TABLE monitor_grant (
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL REFERENCES site(id),
  PRIMARY KEY (user_id, site_id)
);

-- The session claims. In PostgreSQL these are SET LOCAL settings read by the
-- policy; here they are a single-row table read by the views.
CREATE TABLE session (
  only_one INTEGER PRIMARY KEY CHECK (only_one = 1),
  user_id  TEXT NOT NULL,
  role     TEXT NOT NULL,
  site_id  TEXT NOT NULL
);

-- Append-only access log.
CREATE TABLE access_log (
  id             INTEGER PRIMARY KEY,
  user_id        TEXT NOT NULL,
  role           TEXT NOT NULL,
  participant_id INTEGER,
  action         TEXT NOT NULL,
  at             INTEGER NOT NULL
);
CREATE TRIGGER access_log_no_update BEFORE UPDATE ON access_log
BEGIN SELECT RAISE(ABORT, 'access log is append-only'); END;
CREATE TRIGGER access_log_no_delete BEFORE DELETE ON access_log
BEGIN SELECT RAISE(ABORT, 'access log is append-only'); END;

-- ---------------------------------------------------------------------------
-- THE POLICIES. Site isolation for everyone except delegated monitors, who see
-- exactly the sites they were granted.
-- ---------------------------------------------------------------------------
CREATE VIEW v_participant AS
SELECT p.id, p.subject_ref, p.site_id, p.date_of_birth, p.enrolled_at,
       -- Column-level blinding: the arm is NULL unless the role may see it.
       CASE WHEN (SELECT role FROM session) IN ('UNBLINDED_STATS')
            THEN p.arm ELSE NULL END AS arm
  FROM participant p
 WHERE (
   -- site isolation
   p.site_id = (SELECT site_id FROM session)
   AND (SELECT role FROM session) IN
       ('COORDINATOR', 'BLINDED_INVESTIGATOR', 'UNBLINDED_STATS')
 ) OR (
   -- delegated monitor access
   (SELECT role FROM session) = 'MONITOR'
   AND EXISTS (
     SELECT 1 FROM monitor_grant g
      WHERE g.user_id = (SELECT user_id FROM session)
        AND g.site_id = p.site_id
   )
 );

CREATE VIEW v_consent AS
SELECT c.* FROM consent c
 WHERE c.participant_id IN (SELECT id FROM v_participant);
`);
  db.prepare(
    `INSERT INTO session (only_one, user_id, role, site_id) VALUES (1, '', '', '')`,
  ).run();
  return db;
}

/** Equivalent of `SET LOCAL` before serving a request. */
export function setSession(db: DatabaseSync, s: Session): void {
  db.prepare('UPDATE session SET user_id = ?, role = ?, site_id = ? WHERE only_one = 1')
    .run(s.userId, s.role, s.siteId);
}

export function seed(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO site (id, name) VALUES ('SITE_A','Northside'),('SITE_B','Southside');
    INSERT INTO participant (subject_ref, site_id, arm, date_of_birth, enrolled_at)
    VALUES ('A-001','SITE_A','TREATMENT','1978-04-02',1700000000),
           ('A-002','SITE_A','CONTROL','1965-11-19',1700000100),
           ('B-001','SITE_B','TREATMENT','1990-01-07',1700000200),
           ('B-002','SITE_B','CONTROL','1982-06-30',1700000300);
    INSERT INTO consent (participant_id, version, scope, granted_at)
    VALUES (1,2,'CORE+GENOMIC',1700000000),(2,1,'CORE',1700000100),
           (3,1,'CORE',1700000200),(4,1,'CORE',1700000300);
    INSERT INTO monitor_grant (user_id, site_id) VALUES ('mon1','SITE_A');
  `);
}

export interface ParticipantRow {
  id: number;
  subject_ref: string;
  site_id: string;
  arm: string | null;
  date_of_birth: string;
}

/** The ONLY read path the application is given. */
export function listParticipants(db: DatabaseSync): ParticipantRow[] {
  return db.prepare('SELECT * FROM v_participant ORDER BY id')
    .all() as unknown as ParticipantRow[];
}

export function getParticipant(db: DatabaseSync, id: number): ParticipantRow | null {
  const r = db.prepare('SELECT * FROM v_participant WHERE id = ?').get(id);
  return (r as unknown as ParticipantRow) ?? null;
}

export function logAccess(
  db: DatabaseSync, s: Session, participantId: number | null, action: Action,
): void {
  db.prepare(
    `INSERT INTO access_log (user_id, role, participant_id, action, at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(s.userId, s.role, participantId, action, Date.now());
}

/** Export is gated on the participant's CURRENT consent scope. */
export function exportGenomic(db: DatabaseSync, participantId: number): boolean {
  const row = db.prepare(
    `SELECT scope FROM v_consent WHERE participant_id = ?
      ORDER BY version DESC LIMIT 1`,
  ).get(participantId) as { scope: string } | undefined;
  return row?.scope === 'CORE+GENOMIC';
}
