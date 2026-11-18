// Shared setup for the tests: load MuJoCo's WebAssembly build and the G1 model
// from disk, the same way the browser does over HTTP.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import loadMujoco from '@mujoco/mujoco';
import { loadG1 } from '../src/robot/g1-model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const G1_DIR = path.resolve(HERE, '../third_party/mujoco_menagerie/unitree_g1');
export const FIXTURES = path.join(HERE, 'fixtures');

let cached;
export function loadAll() {
  cached ??= (async () => {
    const mujoco = await loadMujoco();
    const { model } = await loadG1(mujoco, async (rel) => new Uint8Array(await fs.readFile(path.join(G1_DIR, rel))));
    return { mujoco, model };
  })();
  return cached;
}
