const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'abcjs', 'dist', 'abcjs-basic-min.js'),
  'utf8'
);

// Escape for safe embedding in a JS template literal
const escaped = src
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$/g, '\\$');

const output = [
  '// Auto-generated from abcjs/dist/abcjs-basic-min.js — do not edit',
  '// Run: node scripts/bundle-abcjs.js',
  'export const ABCJS_SOURCE = `' + escaped + '`;',
  '',
].join('\n');

const outDir = path.join(__dirname, '..', 'src', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'abcjs-source.ts'), output);
console.log('Written src/assets/abcjs-source.ts (' + output.length + ' bytes)');
