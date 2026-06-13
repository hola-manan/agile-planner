// Cloudflare Worker entry. Hono is Workers-native — the app *is* the fetch
// handler. Static assets (the built React UI) are served by Workers Assets;
// only /api/* runs this Worker (see wrangler.toml run_worker_first).
import { createApp } from './app.js';

export default createApp();
