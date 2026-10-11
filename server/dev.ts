/** Local API server: `npm run dev:api` (Vite proxies /api to it). */
import { createPool } from './db';
import { createApp } from './app';

try {
  process.loadEnvFile();
} catch {
  // No .env file: use the environment as is.
}
process.env.DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5432/shelfsync';

const port = Number(process.env.PORT ?? 4001);
createApp(createPool()).listen(port, () => console.log(`ShelfSync API on http://localhost:${port}`));
