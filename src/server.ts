import 'dotenv/config';
import { createApp } from './app.js';
import { createAuthModule } from './modules/auth/index.js';
import { readAuthConfig, readDatabaseURL, readPort } from './shared/config.js';
import { createDatabase } from './shared/database/client.js';

async function main(): Promise<void> {
  const config = readAuthConfig(process.env);
  const port = readPort(process.env);
  const { db, pool } = createDatabase(readDatabaseURL(process.env));
  try {
    await pool.query('SELECT 1');
    const auth = await createAuthModule(db, config);
    const server = createApp(auth.router).listen(port, () => {
      console.log(`Server is running on port ${String(port)}`);
    });
    server.on('error', () => {
      console.error('HTTP server failed');
      void pool.end().finally(() => { process.exitCode = 1; });
    });
    const shutdown = (): void => {
      server.close(() => { void pool.end(); });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

main().catch(() => {
  console.error('Startup failed. Check database and authentication configuration.');
  process.exitCode = 1;
});
