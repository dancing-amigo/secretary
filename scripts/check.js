import fs from 'fs';

const required = ['src/index.js', 'src/services/assistantEngine.js', 'src/services/scheduler.js', 'data/state.json'];
const missing = required.filter((f) => !fs.existsSync(f));
if (missing.length) {
  console.error('Missing files:', missing.join(', '));
  process.exit(1);
}
console.log('check ok');
