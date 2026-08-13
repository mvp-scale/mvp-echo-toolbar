/**
 * Minimal TypeScript loader for `node --test`.
 *
 * Renderer modules are .ts and normally only ever pass through Vite. To unit
 * test their pure logic we transpile on the fly with esbuild, which is already
 * present as a Vite transitive dependency — so this adds NO new package and no
 * lockfile risk (the project has no committed lockfile, so that matters).
 *
 * Type errors are not reported here; `npm run typecheck` owns that.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const TS_RE = /\.(ts|tsx)$/;

/**
 * Resolve extensionless relative imports (`./model-cache`) to their .ts file.
 * Bundlers do this implicitly; Node does not.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
      if (TS_RE.test(candidate) && existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, format: 'module', shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (TS_RE.test(url)) {
    const filename = fileURLToPath(url);
    const { code } = await esbuild.transform(await readFile(filename, 'utf8'), {
      loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
      format: 'esm',
      target: 'node20',
      sourcefile: filename,
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
