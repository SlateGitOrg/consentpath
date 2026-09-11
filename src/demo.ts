/**
 * The 60-second artefact: the same query, four sessions, four answers -
 * decided by the data layer. Run: `npm run demo`
 */
import {
  createDatabase, seed, setSession, listParticipants, exportGenomic,
  type Role,
} from './store.ts';

const db = createDatabase();
seed(db);

console.log('\n  CONSENTPATH - authorisation is a property of the data layer');
console.log('  ' + '-'.repeat(66));
console.log('  Every row below comes from the SAME query: SELECT * FROM v_participant');
console.log('  No WHERE clause. No handler-level check. Only the session differs.\n');

const sessions: Array<{ userId: string; role: Role; siteId: string; note: string }> = [
  { userId: 'c1', role: 'COORDINATOR', siteId: 'SITE_A', note: 'site A staff' },
  { userId: 'c2', role: 'COORDINATOR', siteId: 'SITE_B', note: 'site B staff' },
  { userId: 'i1', role: 'BLINDED_INVESTIGATOR', siteId: 'SITE_A', note: 'blinded' },
  { userId: 's1', role: 'UNBLINDED_STATS', siteId: 'SITE_A', note: 'unblinded' },
  { userId: 'mon1', role: 'MONITOR', siteId: 'SITE_B', note: 'granted SITE_A only' },
  { userId: 'mon9', role: 'MONITOR', siteId: 'SITE_A', note: 'no grant' },
];

console.log('  session                        claims     rows  subjects       arm');
console.log('  ' + '-'.repeat(72));
for (const s of sessions) {
  setSession(db, s);
  const rows = listParticipants(db);
  const subjects = rows.map((r) => r.subject_ref).join(',') || '-';
  const arm = rows.length ? (rows[0]!.arm ?? 'BLINDED') : '-';
  console.log(
    `  ${(s.userId + ' ' + s.role).padEnd(30)} ${s.siteId.padEnd(10)} ` +
    `${String(rows.length).padEnd(5)} ${subjects.padEnd(14)} ${arm}`,
  );
}

console.log('\n  Note row 5: the monitor CLAIMS SITE_B but holds a grant for SITE_A,');
console.log('  and sees SITE_A. The claim does not decide; the policy does.');
console.log('  Note row 6: a monitor with no grant sees nothing at all.\n');

setSession(db, { userId: 's1', role: 'UNBLINDED_STATS', siteId: 'SITE_A' });
console.log('  Consent-gated export:');
console.log(`    A-001 genomic export: ${exportGenomic(db, 1) ? 'ALLOWED' : 'DENIED'}` +
            '   (consented CORE+GENOMIC)');
console.log(`    A-002 genomic export: ${exportGenomic(db, 2) ? 'ALLOWED' : 'DENIED'}` +
            '    (consented CORE only)\n');
db.close();
