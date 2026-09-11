import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDatabase, seed, setSession, listParticipants, getParticipant,
  exportGenomic, type Role, type Session,
} from '../src/store.ts';

const ROLES: Role[] = [
  'COORDINATOR', 'BLINDED_INVESTIGATOR', 'UNBLINDED_STATS', 'MONITOR',
];
const SITES = ['SITE_A', 'SITE_B'];
/** Ground truth: which site each participant belongs to. */
const PARTICIPANTS = [
  { id: 1, site: 'SITE_A' }, { id: 2, site: 'SITE_A' },
  { id: 3, site: 'SITE_B' }, { id: 4, site: 'SITE_B' },
];

function fresh() {
  const db = createDatabase();
  seed(db);
  return db;
}

function sessionsFor(userId: string): Session[] {
  const out: Session[] = [];
  for (const role of ROLES) for (const siteId of SITES) out.push({ userId, role, siteId });
  return out;
}

describe('the negative authorisation matrix', () => {
  test('THE MATRIX: no session can read a participant outside its entitlement', () => {
    // Enumerating what must be IMPOSSIBLE is the suite generic projects skip,
    // because writing it means stating every denial explicitly.
    const db = fresh();
    let denials = 0;
    let permits = 0;

    for (const s of sessionsFor('u1')) {
      setSession(db, s);
      for (const p of PARTICIPANTS) {
        const entitled =
          s.role === 'MONITOR'
            ? false // u1 holds no monitor grant
            : p.site === s.siteId;
        const row = getParticipant(db, p.id);
        if (entitled) {
          assert.ok(row, `${s.role}@${s.siteId} should read participant ${p.id}`);
          permits++;
        } else {
          assert.equal(
            row, null,
            `LEAK: ${s.role}@${s.siteId} read participant ${p.id} (${p.site})`,
          );
          denials++;
        }
      }
    }
    assert.equal(denials + permits, ROLES.length * SITES.length * PARTICIPANTS.length);
    assert.ok(denials > 0 && permits > 0, 'the matrix must exercise both outcomes');
    db.close();
  });

  test('a deny-everything layer would fail this: legitimate access still works', () => {
    // Without this, an authz layer that returns nothing at all passes the
    // negative matrix perfectly and is completely broken.
    const db = fresh();
    setSession(db, { userId: 'c1', role: 'COORDINATOR', siteId: 'SITE_A' });
    const rows = listParticipants(db);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.subject_ref), ['A-001', 'A-002']);
    db.close();
  });

  test('THE BYPASS: a hand-written query against the view is still constrained', () => {
    const db = fresh();
    setSession(db, { userId: 'c1', role: 'COORDINATOR', siteId: 'SITE_A' });
    // The application is given the view, not the table. Any query it can write
    // - including this one, with no WHERE clause at all - is still filtered.
    const rows = db.prepare('SELECT * FROM v_participant').all() as Array<{
      site_id: string;
    }>;
    assert.ok(rows.every((r) => r.site_id === 'SITE_A'),
      'an unfiltered SELECT * returned another site');
    assert.equal(rows.length, 2);
    db.close();
  });

  test('changing only the session claim changes what exists', () => {
    const db = fresh();
    setSession(db, { userId: 'c1', role: 'COORDINATOR', siteId: 'SITE_A' });
    assert.equal(listParticipants(db).length, 2);
    setSession(db, { userId: 'c2', role: 'COORDINATOR', siteId: 'SITE_B' });
    const b = listParticipants(db);
    assert.equal(b.length, 2);
    assert.deepEqual(b.map((r) => r.subject_ref), ['B-001', 'B-002']);
    db.close();
  });
});

describe('blinding is a column grant, not a hidden UI field', () => {
  test('a blinded investigator never receives the arm value', () => {
    const db = fresh();
    setSession(db, { userId: 'i1', role: 'BLINDED_INVESTIGATOR', siteId: 'SITE_A' });
    for (const r of listParticipants(db)) {
      assert.equal(r.arm, null, 'arm leaked to a blinded role');
    }
    db.close();
  });

  test('a coordinator is also blinded', () => {
    const db = fresh();
    setSession(db, { userId: 'c1', role: 'COORDINATOR', siteId: 'SITE_A' });
    assert.ok(listParticipants(db).every((r) => r.arm === null));
    db.close();
  });

  test('the unblinded statistician does receive it', () => {
    const db = fresh();
    setSession(db, { userId: 's1', role: 'UNBLINDED_STATS', siteId: 'SITE_A' });
    const arms = listParticipants(db).map((r) => r.arm);
    assert.deepEqual(arms, ['TREATMENT', 'CONTROL']);
    db.close();
  });

  test('blinding survives a query that asks for the column directly', () => {
    const db = fresh();
    setSession(db, { userId: 'i1', role: 'BLINDED_INVESTIGATOR', siteId: 'SITE_A' });
    const rows = db.prepare('SELECT arm FROM v_participant').all() as Array<{
      arm: string | null;
    }>;
    assert.ok(rows.every((r) => r.arm === null));
    db.close();
  });
});

describe('delegated monitor access', () => {
  test('a monitor sees exactly the sites granted to them', () => {
    const db = fresh();
    setSession(db, { userId: 'mon1', role: 'MONITOR', siteId: 'SITE_B' });
    const rows = listParticipants(db);
    // mon1 is granted SITE_A only - and the claimed site_id is irrelevant.
    assert.ok(rows.every((r) => r.site_id === 'SITE_A'));
    assert.equal(rows.length, 2);
    db.close();
  });

  test('a monitor with no grant sees nothing', () => {
    const db = fresh();
    setSession(db, { userId: 'mon_nobody', role: 'MONITOR', siteId: 'SITE_A' });
    assert.equal(listParticipants(db).length, 0);
    db.close();
  });
});

describe('consent scope gates export', () => {
  test('export is allowed only within the current consent scope', () => {
    const db = fresh();
    setSession(db, { userId: 's1', role: 'UNBLINDED_STATS', siteId: 'SITE_A' });
    assert.equal(exportGenomic(db, 1), true, 'A-001 consented to genomic');
    assert.equal(exportGenomic(db, 2), false, 'A-002 consented to core only');
    db.close();
  });

  test('consent is evaluated at the CURRENT version, not the enrolled one', () => {
    const db = fresh();
    setSession(db, { userId: 's1', role: 'UNBLINDED_STATS', siteId: 'SITE_A' });
    assert.equal(exportGenomic(db, 2), false);
    db.exec(`INSERT INTO consent (participant_id, version, scope, granted_at)
             VALUES (2, 2, 'CORE+GENOMIC', 1700009999)`);
    assert.equal(exportGenomic(db, 2), true, 'a re-consent must take effect');
    db.close();
  });

  test('consent rows outside the session entitlement are not visible', () => {
    const db = fresh();
    setSession(db, { userId: 'c1', role: 'COORDINATOR', siteId: 'SITE_A' });
    // participant 3 is SITE_B
    assert.equal(exportGenomic(db, 3), false);
    db.close();
  });
});

describe('the access log', () => {
  test('is append-only', () => {
    const db = fresh();
    setSession(db, { userId: 'c1', role: 'COORDINATOR', siteId: 'SITE_A' });
    db.exec(`INSERT INTO access_log (user_id, role, participant_id, action, at)
             VALUES ('c1','COORDINATOR',1,'read',1)`);
    assert.throws(() => db.exec("UPDATE access_log SET user_id = 'x'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM access_log'), /append-only/);
    db.close();
  });
});
