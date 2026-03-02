const fs = require('fs');
const coverage = JSON.parse(fs.readFileSync('coverage/coverage-final.json', 'utf8'));

let totalStmts = 0, totalCoveredStmts = 0;
let totalBranches = 0, totalCoveredBranches = 0;
let totalFns = 0, totalCoveredFns = 0;

const rows = [];

for (const [file, data] of Object.entries(coverage)) {
  const shortPath = file.replace(/.*packages\/chat\//, '');
  if (shortPath.indexOf('src/') !== 0) continue;

  const stmts = Object.values(data.s);
  const ts = stmts.length;
  const cs = stmts.filter(c => c > 0).length;
  const sp = ts > 0 ? (cs / ts * 100).toFixed(2) : '100.00';

  const branches = Object.values(data.b).flat();
  const tb = branches.length;
  const cb = branches.filter(c => c > 0).length;
  const bp = tb > 0 ? (cb / tb * 100).toFixed(2) : '100.00';

  const fns = Object.values(data.f);
  const tf = fns.length;
  const cf = fns.filter(c => c > 0).length;
  const fp = tf > 0 ? (cf / tf * 100).toFixed(2) : '100.00';

  totalStmts += ts;
  totalCoveredStmts += cs;
  totalBranches += tb;
  totalCoveredBranches += cb;
  totalFns += tf;
  totalCoveredFns += cf;

  const srcPath = shortPath;
  rows.push({ srcPath, sp, bp, fp });
}

rows.sort((a, b) => a.srcPath.localeCompare(b.srcPath));

for (const r of rows) {
  console.log(`${r.srcPath.padEnd(50)} Stmts: ${r.sp.padStart(6)}% | Branches: ${r.bp.padStart(6)}% | Funcs: ${r.fp.padStart(6)}%`);
}

console.log('');
console.log('TOTAL'.padEnd(50) +
  ` Stmts: ${(totalCoveredStmts / totalStmts * 100).toFixed(2).padStart(6)}%` +
  ` | Branches: ${(totalCoveredBranches / totalBranches * 100).toFixed(2).padStart(6)}%` +
  ` | Funcs: ${(totalCoveredFns / totalFns * 100).toFixed(2).padStart(6)}%`);

console.log(`\nStatements: ${totalCoveredStmts}/${totalStmts}`);
console.log(`Branches: ${totalCoveredBranches}/${totalBranches}`);
console.log(`Functions: ${totalCoveredFns}/${totalFns}`);
