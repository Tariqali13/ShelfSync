import express, { type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { SyncRequest } from '../shared/protocol';
import { migrate } from './db';
import { NotFound, createStore, getState, sync } from './store';

const StoreId = z.uuid();

/**
 * The HTTP API. Runs as a Netlify Function in production (see
 * netlify/functions/api.ts) and as a plain Node server locally (server/dev.ts).
 */
export function createApp(pool: pg.Pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  // Behind Netlify's /api/* rewrite the function can see either path; normalise to /api.
  app.use((req, _res, next) => {
    if (req.url.startsWith('/.netlify/functions/api')) req.url = '/api' + req.url.slice('/.netlify/functions/api'.length);
    next();
  });

  // Tables are created on first use, once per process (cold start).
  app.use(async (_req, _res, next) => {
    try {
      await migrate(pool);
      next();
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  app.post('/api/stores', async (_req, res) => {
    res.status(201).json(await createStore(pool));
  });

  app.get('/api/stores/:id', async (req, res) => {
    const id = StoreId.safeParse(req.params.id);
    if (!id.success) return void res.status(404).json({ error: 'not_found', message: 'This store does not exist or has expired.' });
    res.set('Cache-Control', 'no-store').json(await getState(pool, id.data));
  });

  app.post('/api/stores/:id/sync', async (req, res) => {
    const id = StoreId.safeParse(req.params.id);
    if (!id.success) return void res.status(404).json({ error: 'not_found', message: 'This store does not exist or has expired.' });
    const body = SyncRequest.safeParse(req.body);
    if (!body.success) {
      return void res.status(400).json({
        error: 'invalid_request',
        message: 'The sync request was not valid.',
        issues: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    res.set('Cache-Control', 'no-store').json(await sync(pool, id.data, body.data));
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NotFound) return void res.status(404).json({ error: 'not_found', message: err.message });
    if (err instanceof SyntaxError && 'body' in err) return void res.status(400).json({ error: 'invalid_json', message: 'The request body is not valid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server. Your changes are still queued on the till.' });
  });

  return app;
}
