import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SERVER_DIR, '..');
const HATCHABLE = pathToFileURL(path.join(SERVER_DIR, 'hatchable.mjs')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'hatchable') return { url: HATCHABLE, shortCircuit: true };

  if (specifier.startsWith('lib/')) {
    const file = path.join(ROOT, specifier);
    return nextResolve(pathToFileURL(file).href, context);
  }

  return await nextResolve(specifier, context);
}
