const fs = require('fs');

function text(file) {
  let s = fs.readFileSync(file, 'utf8');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '\n');
  s = s.replace(/"/g, '"').replace(/'/g, "'").replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
  return s;
}

function contexts(file, needles, radius = 260) {
  const t = text(file);
  const lines = t.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const out = [];
  for (const needle of needles) {
    let hits = 0;
    for (let i = 0; i < lines.length && hits < 6; i++) {
      if (lines[i].toLowerCase().includes(needle.toLowerCase())) {
        hits++;
        out.push(`--- [${file}] "${needle}" @${i}: ` + lines.slice(i, i + 4).join(' | ').slice(0, radius * 2));
      }
    }
    if (hits === 0) out.push(`--- [${file}] "${needle}": NEM TALÁLVA`);
  }
  return out;
}

const targets = process.argv.slice(2);
for (const f of targets) {
  const needles = ['price', 'per megapixel', 'per second', 'per unit', 'schnell', 'reference_image_urls', 'image_url', 'duration', 'multi', 'element', 'start_image_url', 'cost'];
  console.log(contexts(f, needles).join('\n'));
  console.log('\n=================\n');
}
