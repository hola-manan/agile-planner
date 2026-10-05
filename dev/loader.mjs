// Node module.register() resolve hook (local dev / tests only — never deployed).
//   'hatchable'   → dev/fake-hatchable.mjs  (in-memory db + in-process events)
//   'lib/<path>'  → <root>/lib/<path>       (Hatchable's bare namespace for root lib/)
// Bootstrap aid: if a lib/ file does not exist yet AND dev/stub-engine/<same name> does, the import
// falls back to the stub (one-time warning). Used while lib/engine.js / lib/view.js were being
// written; the stub directory has since been removed, so this is inert. FELT_NO_STUB=1 disables it.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const DEV_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV_DIR, '..');
const LIB_DIR = path.join(ROOT, 'lib');
const STUB_DIR = path.join(DEV_DIR, 'stub-engine');
const FAKE_HATCHABLE = pathToFileURL(path.join(DEV_DIR, 'fake-hatchable.mjs')).href;
const allowStub = !process.env.FELT_NO_STUB;
const warned = new Set();

function libOrStub(file) {
  if (existsSync(file)) return pathToFileURL(file).href;
  const rel = path.relative(LIB_DIR, file);
  if (allowStub && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const stub = path.join(STUB_DIR, rel);
    if (existsSync(stub)) {
      if (!warned.has(rel)) {
        warned.add(rel);
        process.stderr.write(`[dev] lib/${rel} not found — using dev/stub-engine/${rel}\n`);
      }
      return pathToFileURL(stub).href;
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'hatchable') return { url: FAKE_HATCHABLE, shortCircuit: true };

  if (specifier.startsWith('lib/')) {
    const file = path.join(ROOT, specifier);
    const url = libOrStub(file);
    if (url) return { url, shortCircuit: true };
    return nextResolve(pathToFileURL(file).href, context); // let Node report the missing module
  }

  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Relative import from inside lib/ (e.g. view.js → './ledger.js') of a file that isn't written yet.
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && context.parentURL && /^\.\.?\//.test(specifier)) {
      const parent = context.parentURL.startsWith('file:') ? fileURLToPath(context.parentURL) : null;
      if (parent) {
        const url = libOrStub(path.resolve(path.dirname(parent), specifier));
        if (url) return { url, shortCircuit: true };
      }
    }
    throw err;
  }
}
