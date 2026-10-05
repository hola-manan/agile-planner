// Local dev only: `node --import ./dev/register.mjs …` installs the resolve hook that makes the
// Hatchable bare specifiers ('hatchable', 'lib/…') work under plain Node.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
