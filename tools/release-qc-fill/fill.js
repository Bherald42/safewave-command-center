// One-off writer for Release QC (see .github/workflows/release-qc-fill.yml).
// Records only what was actually done: the firmware image built from commit
// 7cc0cb9 with its SHA-256, the release's target build numbers, and the three
// simulator runs (exported from the simulator engine). Physical checks and
// "build is on TestFlight / Play" stay open for a person to check off.
const fs = require('fs');
const crypto = require('crypto');
const admin = require('firebase-admin');

const sa = JSON.parse(process.env.SA_JSON || '{}');
if (!sa.project_id) { console.error('FIREBASE_SERVICE_ACCOUNT secret missing'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: 'safewave-command-center' });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const REL_ID = 'RLNOV26';
const BY = 'Claude (for Brad)';
const now = new Date().toISOString();

(async () => {
  // ---- firmware image ----
  const bin = fs.readFileSync(process.env.FW_BIN);
  const sha = crypto.createHash('sha256').update(bin).digest('hex');
  const ver = bin.readUInt32LE(24);
  const dotted = ((ver >>> 12) & 15) + '.' + ((ver >>> 8) & 15) + '.' + (((ver >>> 4) & 15) * 10 + (ver & 15));
  console.log('firmware image', bin.length, 'bytes, header version', dotted, 'sha256', sha);
  if (dotted !== '1.0.51') throw new Error('image header says ' + dotted + ', expected 1.0.51');

  let fwSnap = await db.collection('releases').where('product', '==', 'firmware').where('version', '==', '1.0.51').limit(1).get();
  let fwId;
  if (fwSnap.empty) {
    fwId = 'RLFW1051';
    await db.collection('releases').doc(fwId).set({ product: 'firmware', version: '1.0.51', buildNumber: '', channel: 'prod', status: 'draft', notes: '', createdAt: now, createdBy: BY });
    console.log('created firmware release record', fwId);
  } else { fwId = fwSnap.docs[0].id; console.log('using firmware release record', fwId); }
  await db.collection('releases').doc(fwId).update({
    image: { name: 'Safewave_band_firmware_v1.0.51_7cc0cb9.bin', url: 'data:application/octet-stream;base64,' + bin.toString('base64'), size: bin.length, sha256: sha,
      uploadedBy: BY + ' — CI build of firmware commit 7cc0cb9 (branch claude/led-on-when-powered)', uploadedAt: now, storedIn: 'inline' } });

  // ---- release doc ----
  const ref = db.collection('launches').doc(REL_ID);
  const snap = await ref.get();
  const target = { fw: { version: '1.0.51', build: '' }, ios_biz: { version: '1.0.1', build: '24' }, ios_cons: { version: '1.4.0', build: '16' }, and_biz: { version: '1.0.1', build: '6' }, and_cons: { version: '1.4.0', build: '18' } };
  if (!snap.exists) {
    await ref.set({ id: REL_ID, kind: 'release', name: 'November release — HKNC pilot', targetDate: '2026-11-06', status: 'open', comps: target, fwRelId: fwId,
      checks: {}, owners: {}, feedback: {}, signoffs: {}, notes: '', createdBy: BY, createdAt: now });
    console.log('created release', REL_ID);
  }
  const cur = (await ref.get()).data();
  const upd = { fwRelId: fwId };
  Object.keys(target).forEach(k => { const c = (cur.comps || {})[k] || {};
    if (c.version !== target[k].version || String(c.build || '') !== target[k].build) { upd['comps.' + k] = target[k]; console.log('version', k, (c.version || '?') + ' (' + (c.build || '') + ') ->', target[k].version + ' (' + target[k].build + ')'); } });
  const sim = JSON.parse(fs.readFileSync(__dirname + '/sim-results.json', 'utf8'));
  Object.keys(sim.checks).forEach(id => {
    const prev = (cur.checks || {})[id]; const c = sim.checks[id];
    upd['checks.' + id] = Object.assign({}, c, { by: BY, at: now,
      note: c.note + ' Simulated against Business 1.0.1 (24 / Android 6) and Safewave 1.4.0 (16 / Android 18) — the Aware life-safety fix in mobile PR #4.',
      hist: prev && prev.state ? (prev.hist || []).concat([{ state: prev.state, by: prev.by, at: prev.at, note: prev.note || '' }]) : [] });
    console.log('check', id, c.state, c.sim.ran + ' scenarios,', c.sim.failed, 'failed');
  });
  await ref.update(upd);

  // ---- stock counts (Command Center → Stock) ----
  await db.collection('inventory').doc('main').set({ locations: { covington: { S: 1, M: 16, L: 20 }, pace: { S: 80, M: 320, L: 60 } }, updatedAt: now }, { merge: true });
  console.log('stock: office S1 M16 L20 · Pace S80 M320 L60');
  console.log('done');
})().catch(e => { console.error(e.message || e); process.exit(1); });
