// Draws the simulated G1 with three.js.
//
// MuJoCo does the physics; it is not asked to draw.  The robot's visual meshes
// are copied out of the compiled model once.  After that, every rendered frame
// only copies each part's position and orientation out of the simulation.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const VISIBLE_GROUPS = 3; // MuJoCo draws geom groups 0 to 2 by default; the G1's collision shapes are group 3

export class RobotView {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d0f12);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    this.camera.position.set(3.0, 1.15, 1.0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.72, 0);
    this.controls.update();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.3));
    const dir = new THREE.DirectionalLight(0xffffff, 1.8); dir.position.set(3, 4, 2); this.scene.add(dir);
    // A fill light from the front at head height: the head's dark visor faces forward and gets little
    // from the light above.
    const fill = new THREE.DirectionalLight(0xffffff, 2.0); fill.position.set(3, 1.4, -1); this.scene.add(fill);
    this.scene.add(new THREE.GridHelper(4, 16, 0x334455, 0x222a33));
    // MuJoCo's world has z up and the robot facing +x; three.js has y up.
    this.root = new THREE.Group();
    this.root.rotation.x = -Math.PI / 2;
    this.scene.add(this.root);
    this.parts = []; // { mesh, geom }
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  /** Copy the visual meshes out of the compiled model.  Returns counts for the log. */
  build(mujoco, model) {
    const MESH = mujoco.mjtGeom.mjGEOM_MESH.value;
    const vert = model.mesh_vert, normal = model.mesh_normal, face = model.mesh_face, faceNormal = model.mesh_facenormal;
    const geometries = new Map(), materials = new Map();
    let triangles = 0;

    const geometryFor = (meshId) => {
      if (geometries.has(meshId)) return geometries.get(meshId);
      const v0 = model.mesh_vertadr[meshId], n0 = model.mesh_normaladr[meshId];
      const f0 = model.mesh_faceadr[meshId], nf = model.mesh_facenum[meshId];
      const pos = new Float32Array(nf * 9), nor = new Float32Array(nf * 9);
      for (let f = 0; f < nf; f++) for (let c = 0; c < 3; c++) {
        const vi = 3 * (v0 + face[3 * (f0 + f) + c]), ni = 3 * (n0 + faceNormal[3 * (f0 + f) + c]);
        const o = 9 * f + 3 * c;
        pos[o] = vert[vi]; pos[o + 1] = vert[vi + 1]; pos[o + 2] = vert[vi + 2];
        nor[o] = normal[ni]; nor[o + 1] = normal[ni + 1]; nor[o + 2] = normal[ni + 2];
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geometries.set(meshId, g);
      triangles += nf;
      return g;
    };
    const materialFor = (geom) => {
      const mat = model.geom_matid[geom];
      const src = mat >= 0 ? model.mat_rgba : model.geom_rgba, i = 4 * (mat >= 0 ? mat : geom);
      const key = `${src[i]},${src[i + 1]},${src[i + 2]}`;
      if (!materials.has(key)) {
        materials.set(key, new THREE.MeshStandardMaterial({
          color: new THREE.Color().setRGB(src[i], src[i + 1], src[i + 2], THREE.SRGBColorSpace),
          metalness: 0.25, roughness: 0.55,
        }));
      }
      return materials.get(key);
    };

    let skipped = 0;
    for (let g = 0; g < model.ngeom; g++) {
      if (model.geom_group[g] >= VISIBLE_GROUPS) continue;
      if (model.geom_type[g] !== MESH) { skipped++; continue; } // the floor plane; the grid stands in for it
      const mesh = new THREE.Mesh(geometryFor(model.geom_dataid[g]), materialFor(g));
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.parts.push({ mesh, geom: g });
    }
    return { parts: this.parts.length, triangles, skipped };
  }

  /** Move every part to where the simulation has it. */
  update(data) {
    const p = data.geom_xpos, r = data.geom_xmat;
    for (const { mesh, geom } of this.parts) {
      const a = 3 * geom, b = 9 * geom;
      mesh.matrix.set(
        r[b], r[b + 1], r[b + 2], p[a],
        r[b + 3], r[b + 4], r[b + 5], p[a + 1],
        r[b + 6], r[b + 7], r[b + 8], p[a + 2],
        0, 0, 0, 1,
      );
      mesh.matrixWorldNeedsUpdate = true;
    }
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
