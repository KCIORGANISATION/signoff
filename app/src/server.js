import { config } from './config.js';
import { close, migrate } from './db.js';
import { createApp } from './app.js';
import { legalWarning } from './legal-config.js';

const port = process.env.PORT || 3000;

await migrate();

const legalGap = legalWarning();
if (legalGap) console.warn(`WARNING: ${legalGap}`);

const server = createApp().listen(port, () => {
  console.log(`Signoff running on ${config.appUrl || `http://localhost:${port}`}`);
});

// Render sends SIGTERM before a deploy or restart: finish open requests, then close the database.
process.on('SIGTERM', () => {
  server.close(async () => {
    await close();
    process.exit(0);
  });
});
