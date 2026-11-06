const fs = require('fs');
const path = require('path');
// A fájl a saját könyvtárában van, így a script bármelyik munkakönyvtárból futtatható.
const s = fs.readFileSync(path.join(__dirname, 'fal-auth.html'), 'utf8');
const t = s.replace(/<[^>]+>/g, ' ').replace(/"/g, '"').replace(/'/g, "'").replace(/\s+/g, ' ');
for (const kw of ['Authorization', 'Key ', 'FAL_KEY', 'Bearer']) {
  const idxs = [];
  let i = t.indexOf(kw);
  while (i !== -1 && idxs.length < 6) { idxs.push(i); i = t.indexOf(kw, i + 1); }
  console.log('=== ' + kw + ' (' + idxs.length + ')');
  for (const j of idxs) console.log('   ...' + t.slice(Math.max(0, j - 200), j + 300) + '...');
}
