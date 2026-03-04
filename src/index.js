import { config, assertMinimalConfig } from './config.js';
import { app } from './app.js';
import { startSchedulers } from './services/scheduler.js';

const missing = assertMinimalConfig();
if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(`Missing env vars: ${missing.join(', ')}`);
}

startSchedulers();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`line-secretary-mvp listening on :${config.port}`);
});
