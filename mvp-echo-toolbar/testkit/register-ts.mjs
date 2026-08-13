/** Entry point for `node --import`. Installs the esbuild-backed .ts loader. */
import { register } from 'node:module';
register('./ts-loader.mjs', import.meta.url);
