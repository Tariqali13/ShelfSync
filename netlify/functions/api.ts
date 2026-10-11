import serverless from 'serverless-http';
import { createApp } from '../../server/app';
import { createPool } from '../../server/db';

// One pool per warm function instance, reused across invocations.
const app = createApp(createPool());

export const handler = serverless(app);
