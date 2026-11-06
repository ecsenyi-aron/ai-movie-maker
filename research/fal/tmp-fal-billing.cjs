const fs = require('fs');
const files = process.argv.slice(2);
for (const f of files) {
  if (!fs.existsSync(f)) { console.log('==== ' + f + ' HIANYZIK'); continue; }
  const s = fs.readFileSync(f, 'utf8');
  const re = /billing_unit.{0,220}/g;
  const m = s.match(re) || [];
  console.log('==== ' + f + ' (' + m.length + ')');
  console.log([...new Set(m)].join('\n---\n'));
  const ep = s.match(/endpoint\\":\\"[^\\"]+/g) || [];
  console.log('ENDPOINTS: ' + [...new Set(ep)].slice(0, 8).join(', '));
  console.log();
}
