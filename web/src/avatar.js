// three.js scene with a VRM avatar (via @pixiv/three-vrm) and a stick-figure
// fallback/overlay, both driven by the SMPL-X joint rotations on the wire.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { SMPLX_JOINT_NAMES, SMPLX_PARENTS, SMPLX_TO_VRM, SMPLX_REST_POSITIONS } from './joint-map.js';
import { jawAngle } from './wire.js';

const N = SMPLX_JOINT_NAMES.length;
const JAW = 22, HANDS0 = 25;
const Z_UP_FIX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

/** Assemble a (55 x 4) quaternion array from a ring sample. */
export function assembleQuats(sample, out, zUpFix) {
  out.fill(0);
  for (let j = 0; j < N; j++) out[j * 4 + 3] = 1;
  out.set(sample.body, 0);
  if (sample.hands) out.set(sample.hands, HANDS0 * 4);
  if (sample.jaw) out.set(sample.jaw, JAW * 4);
  if (zUpFix) {
    const q = new THREE.Quaternion(out[0], out[1], out[2], out[3]).premultiply(Z_UP_FIX);
    out[0] = q.x; out[1] = q.y; out[2] = q.z; out[3] = q.w;
  }
  return out;
}

class SkeletonOverlay {
  constructor(scene) {
    this.group = new THREE.Group();
    this.joints = SMPLX_JOINT_NAMES.map(() => new THREE.Object3D());
    for (let j = 0; j < N; j++) {
      const p = SMPLX_PARENTS[j];
      const pos = SMPLX_REST_POSITIONS[j], ppos = p >= 0 ? SMPLX_REST_POSITIONS[p] : [0, 0, 0];
      this.joints[j].position.set(pos[0] - ppos[0], pos[1] - ppos[1], pos[2] - ppos[2]);
      (p >= 0 ? this.joints[p] : this.group).add(this.joints[j]);
    }
    const pairs = [];
    for (let j = 1; j < N; j++) pairs.push(SMPLX_PARENTS[j], j);
    this.pairs = pairs;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x5fd3ff }));
    this.lines.frustumCulled = false;
    this.spheres = new THREE.InstancedMesh(new THREE.SphereGeometry(0.012, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffb454 }), N);
    this.group.add(this.lines, this.spheres);
    scene.add(this.group);
    this._v = new THREE.Vector3(); this._m = new THREE.Matrix4();
  }
  setVisible(v) { this.group.visible = v; }
  setPose(quats, root) {
    for (let j = 0; j < N; j++) this.joints[j].quaternion.set(quats[j * 4], quats[j * 4 + 1], quats[j * 4 + 2], quats[j * 4 + 3]);
    if (root) this.joints[0].position.set(root[0], root[1], root[2]);
    this.group.updateMatrixWorld(true);
    const pos = this.lines.geometry.attributes.position;
    for (let i = 0; i < this.pairs.length; i++) {
      this.joints[this.pairs[i]].getWorldPosition(this._v);
      this.group.worldToLocal(this._v);
      pos.setXYZ(i, this._v.x, this._v.y, this._v.z);
    }
    pos.needsUpdate = true;
    for (let j = 0; j < N; j++) {
      this.joints[j].getWorldPosition(this._v); this.group.worldToLocal(this._v);
      this._m.makeTranslation(this._v.x, this._v.y, this._v.z);
      this.spheres.setMatrixAt(j, this._m);
    }
    this.spheres.instanceMatrix.needsUpdate = true;
  }
}

export class AvatarView {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0f12);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    this.camera.position.set(0, 1.25, 3.2);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.0, 0);
    this.controls.update();
    // One white light at strength pi: VRM models' cartoon-style material (MToon) then shows the texture
    // colours as painted.  A tinted sky light or a weaker light greys the skin.
    const dir = new THREE.DirectionalLight(0xffffff, Math.PI); dir.position.set(1, 3, 2); this.scene.add(dir);
    this.scene.add(new THREE.GridHelper(4, 16, 0x334455, 0x222a33));
    this.skeleton = new SkeletonOverlay(this.scene);
    this.vrm = null;
    this.options = { zUpFix: false, rootXZ: false, skeleton: false };
    this.quats = new Float32Array(N * 4);
    this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion();
    this._bones = null; this._folds = null; this._hipsBase = null; this._rootBase = null;
    this.status = 'stick figure';
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }
  resize() {
    const w = this.container.clientWidth || window.innerWidth, h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  async loadVRM(url) {
    const loader = new GLTFLoader();
    // Models with compressed (KTX2) textures need this decoder; its files are copied from three.js to public/basis.
    loader.setKTX2Loader(new KTX2Loader().setTranscoderPath('/basis/').detectSupport(this.renderer));
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('not a VRM file');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x face -Z; make them face +Z like VRM 1.0 / SMPL-X
    this.scene.add(vrm.scene);
    this.vrm = vrm;
    // Resolve bones once; record which mapped joints are missing so their
    // rotation can be folded into their mapped descendants.
    this._bones = SMPLX_JOINT_NAMES.map((n) => vrm.humanoid.getNormalizedBoneNode(SMPLX_TO_VRM[n]) || null);
    this._folds = SMPLX_JOINT_NAMES.map((_, j) => {
      if (!this._bones[j]) return null;
      const chain = [];
      let p = SMPLX_PARENTS[j];
      while (p >= 0 && !this._bones[p]) { chain.push(p); p = SMPLX_PARENTS[p]; }
      return chain; // nearest missing ancestor first
    });
    const hips = this._bones[0];
    this._hipsBase = hips ? hips.position.clone() : null;
    const missing = SMPLX_JOINT_NAMES.filter((_, j) => !this._bones[j]);
    this.status = `VRM loaded; unmapped: ${missing.length ? missing.join(', ') : 'none'}`;
    this.skeleton.group.position.x = 0.9; // overlay beside the character
    return vrm;
  }

  /** A head-and-shoulders view, the camera standing for the partner. */
  frameFace() {
    const head = this.vrm?.humanoid.getNormalizedBoneNode('head');
    const y = head ? head.getWorldPosition(new THREE.Vector3()).y + 0.02 : 1.4;
    this.camera.position.set(0, y, 1.25); this.controls.target.set(0, y - 0.06, 0); this.controls.update();
  }

  /**
   * Turn cues instead of a pose stream: what the kinesics realizer says the body shows
   * (src/kinesics/). `adapter` is a VrmKinesics; `mouth` is 0 to 1.
   */
  setKinesics(adapter, sample, mouth) {
    if (!this.vrm) return;
    adapter.apply(sample, mouth);
    this.skeleton.setVisible(false);
  }

  /** Apply a ring sample (interpolated pose). */
  setPose(sample) {
    if (!sample) return;
    const q = assembleQuats(sample, this.quats, this.options.zUpFix);
    const root = sample.root?.t || null;
    if (this.vrm) {
      const bones = this._bones;
      for (let j = 0; j < N; j++) {
        const node = bones[j];
        if (!node) continue;
        this._q.set(q[j * 4], q[j * 4 + 1], q[j * 4 + 2], q[j * 4 + 3]);
        for (const m of this._folds[j]) {
          this._q2.set(q[m * 4], q[m * 4 + 1], q[m * 4 + 2], q[m * 4 + 3]);
          this._q.premultiply(this._q2);
        }
        node.quaternion.copy(this._q);
      }
      if (!bones[JAW] && this.vrm.expressionManager && sample.jaw) {
        this.vrm.expressionManager.setValue('aa', Math.min(1, jawAngle(sample) / 0.35));
      }
      if (bones[0] && this._hipsBase) {
        if (this.options.rootXZ && root) {
          if (!this._rootBase) this._rootBase = [...root];
          bones[0].position.set(this._hipsBase.x + root[0] - this._rootBase[0], this._hipsBase.y, this._hipsBase.z + root[2] - this._rootBase[2]);
        } else bones[0].position.copy(this._hipsBase);
      }
    }
    this.skeleton.setVisible(this.options.skeleton || !this.vrm);
    if (this.skeleton.group.visible) {
      let skRoot = null;
      if (this.options.rootXZ && root) { if (!this._rootBase) this._rootBase = [...root]; skRoot = [root[0] - this._rootBase[0], SMPLX_REST_POSITIONS[0][1], root[2] - this._rootBase[2]]; }
      this.skeleton.setPose(q, skRoot);
    }
  }

  render(dt) {
    if (this.vrm) this.vrm.update(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
