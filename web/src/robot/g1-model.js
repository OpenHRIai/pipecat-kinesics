// Loads the Unitree G1 description (MuJoCo Menagerie, BSD-3-Clause) into
// MuJoCo's WebAssembly build.
//
// MuJoCo compiles a model from XML files on a file system.  A browser has no
// file system, so the files are fetched and written into the in-memory one
// that the WebAssembly module provides (`mujoco.FS`), then removed again once
// the model is compiled.
//
// `readFile(relativePath)` returns the file's bytes.  The browser passes a
// fetch-based reader; the tests pass one that reads from disk.  That is the
// only difference between the two environments.

const DIR = '/g1';

export const G1_ISAACLAB_TO_MUJOCO_DOF = [
  0, 3, 6, 9, 13, 17, 1, 4, 7, 10, 14, 18, 2, 5, 8, 11, 15, 19, 21, 23, 25, 27, 12, 16, 20, 22, 24, 26, 28,
];
export const G1_MUJOCO_TO_ISAACLAB_DOF = [
  0, 6, 12, 1, 7, 13, 2, 8, 14, 3, 9, 15, 22, 4, 10, 16, 23, 5, 11, 17, 24, 18, 25, 19, 26, 20, 27, 21, 28,
];

/** Mesh file names referenced by a MuJoCo XML document. */
export function meshFiles(xml) {
  return [...xml.matchAll(/<mesh\b[^>]*\bfile="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Fetch the G1 files, compile the model, and return it.
 * @param mujoco  the loaded `@mujoco/mujoco` module
 * @param readFile  async (relativePath) => Uint8Array
 * @param onProgress  optional (loadedFiles, totalFiles, loadedBytes) => void
 */
export async function loadG1(mujoco, readFile, onProgress) {
  const FS = mujoco.FS;
  const written = [];
  const write = (rel, bytes) => { FS.writeFile(`${DIR}/${rel}`, bytes); written.push(`${DIR}/${rel}`); };
  for (const d of [DIR, `${DIR}/assets`]) { try { FS.mkdir(d); } catch { /* exists */ } }

  const [scene, g1] = await Promise.all([readFile('scene.xml'), readFile('g1.xml')]);
  write('scene.xml', scene); write('g1.xml', g1);
  const files = meshFiles(new TextDecoder().decode(g1));
  let done = 0, bytes = 0;
  await Promise.all(files.map(async (f) => {
    const b = await readFile(`assets/${f}`);
    write(`assets/${f}`, b);
    done++; bytes += b.length;
    onProgress?.(done, files.length, bytes);
  }));

  const model = mujoco.MjModel.from_xml_path(`${DIR}/scene.xml`);
  for (const p of written) FS.unlink(p); // the compiled model holds its own copy
  return { model, bytes };
}

/** Index helpers shared by the retargeter, the simulated robot and the renderer. */
export function modelIndex(mujoco, model) {
  const id = (type, name) => {
    const i = mujoco.mj_name2id(model, type.value, name);
    if (i < 0) throw new Error(`G1 model has no ${name}`);
    return i;
  };
  const hinges = [];
  for (let j = 0; j < model.njnt; j++) if (model.jnt_type[j] === mujoco.mjtJoint.mjJNT_HINGE.value) hinges.push(j);
  return {
    joint: (n) => id(mujoco.mjtObj.mjOBJ_JOINT, n),
    body: (n) => id(mujoco.mjtObj.mjOBJ_BODY, n),
    key: (n) => id(mujoco.mjtObj.mjOBJ_KEY, n),
    hinges,                                                   // 29 joint ids, MuJoCo order
    hingeQadr: hinges.map((j) => model.jnt_qposadr[j]),
    hingeRange: hinges.map((j) => [model.jnt_range[2 * j], model.jnt_range[2 * j + 1]]),
    standQpos: (() => {
      const k = id(mujoco.mjtObj.mjOBJ_KEY, 'stand');
      return Float64Array.from(model.key_qpos.subarray(k * model.nq, (k + 1) * model.nq));
    })(),
  };
}
