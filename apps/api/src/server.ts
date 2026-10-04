import { buildApp } from './app.js';
import { config } from './config.js';

// Keep request logging disabled: tracking URLs can contain a reporter's case code,
// and request logs could otherwise retain that credential alongside network data.
const app = await buildApp({ logger: false });
await app.listen({ port: config.PORT, host: config.HOST });
