const fs = require('fs');
const f = process.argv[2];
const needles = process.argv.slice(3);
const s = fs.readFileSync(f, 'utf8');
const t = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n');
const lines = t.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
for (const needle of needles) {
  let hits = 0;
  for (let i = 0; i < lines.length && hits < 4; i++) {
    if (lines[i].toLowerCase().includes(needle.toLowerCase())) {
      hits++;
      console.log(`[${needle}] ` + lines.slice(i, i + 5).join(' | ').slice(0, 700));
    }
  }
  if (!hits) console.log(`[${needle}] NEM TALALVA`);
}
