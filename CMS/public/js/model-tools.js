// Model tools (CMS admin only) — converts STL / 3MF / STEP files to GLB in the
// browser so the published site only ever needs GLTFLoader.
//
//   STL  -> three.js STLLoader
//   3MF  -> three.js ThreeMFLoader
//   STEP -> occt-import-js (OpenCascade WASM served from /vendor/occt)
//
// Exposed as window.ModelTools = { convertToGlb, isModelFile, SUPPORTED_EXTS }.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const SUPPORTED_EXTS = ['stl', '3mf', 'step', 'stp'];
const DEFAULT_COLOR = 0x9ca3af;
const OCCT_BASE = '/vendor/occt/';
// Below this triangle count models are typically boxy prints where hard edges
// matter, so vertices are split for flat shading. Above it (organic / high-res
// surfaces) vertices are merged and normals smoothed, which is about a third of
// the GLB size — important for mobile visitors.
const FLAT_SHADING_MAX_TRIANGLES = 40000;

// Normalizes a mesh geometry for export: fresh normals, and either flat-shaded
// (non-indexed) or compact indexed + smooth depending on triangle count.
function finalizeGeometry(geometry) {
  let g = geometry;
  const triCount = (g.index ? g.index.count : g.attributes.position.count) / 3;
  g.deleteAttribute('normal');
  if (triCount <= FLAT_SHADING_MAX_TRIANGLES) {
    if (g.index) g = g.toNonIndexed();
  } else if (!g.index) {
    g = mergeVertices(g);
  }
  g.computeVertexNormals();
  return g;
}

function extOf(name) {
  return (name || '').split('.').pop().toLowerCase();
}

function isModelFile(nameOrFile) {
  const name = typeof nameOrFile === 'string' ? nameOrFile : nameOrFile?.name;
  return SUPPORTED_EXTS.includes(extOf(name));
}

function stemOf(name) {
  return (name || 'model').replace(/\.[^.]+$/, '');
}

function readAsArrayBuffer(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

// --- OpenCascade (STEP) -----------------------------------------------------------

let occtPromise = null;
function loadOcct() {
  if (occtPromise) return occtPromise;
  occtPromise = new Promise((resolve, reject) => {
    const ready = () => {
      if (typeof window.occtimportjs !== 'function') {
        reject(new Error('occt-import-js did not initialize'));
        return;
      }
      window.occtimportjs({ locateFile: (p) => OCCT_BASE + p }).then(resolve, reject);
    };
    if (typeof window.occtimportjs === 'function') { ready(); return; }
    const script = document.createElement('script');
    script.src = OCCT_BASE + 'occt-import-js.js';
    script.async = true;
    script.onload = ready;
    script.onerror = () => reject(new Error('Could not load OpenCascade (occt-import-js). Is the CMS server running with node_modules installed?'));
    document.head.appendChild(script);
  }).catch((err) => { occtPromise = null; throw err; });
  return occtPromise;
}

function occtColorToHex(color) {
  if (!Array.isArray(color) || color.length < 3) return null;
  let [r, g, b] = color;
  if (r > 1 || g > 1 || b > 1) { r /= 255; g /= 255; b /= 255; }
  return new THREE.Color(r, g, b);
}

function nodeNamesByMesh(root) {
  const map = new Map();
  const walk = (node, inherited) => {
    if (!node) return;
    const name = (node.name || '').trim() || inherited;
    (node.meshes || []).forEach((idx) => { if (!map.has(idx)) map.set(idx, name); });
    (node.children || []).forEach((child) => walk(child, name));
  };
  walk(root, '');
  return map;
}

function stepToGroup(result, stem) {
  if (!result || !result.success || !Array.isArray(result.meshes) || result.meshes.length === 0) {
    throw new Error('OpenCascade could not read this STEP file (no solids found).');
  }
  const names = nodeNamesByMesh(result.root);
  const group = new THREE.Group();
  group.name = stem;

  result.meshes.forEach((m, i) => {
    const pos = m.attributes?.position?.array;
    if (!pos || pos.length < 9) return;
    let geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(Float32Array.from(pos), 3));
    const nrm = m.attributes?.normal?.array;
    if (nrm && nrm.length === pos.length) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(Float32Array.from(nrm), 3));
    }
    const idx = m.index?.array;
    if (idx && idx.length) {
      geometry.setIndex(Array.from(idx));
    }

    const material = new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR, metalness: 0.1, roughness: 0.55 });
    const baseColor = occtColorToHex(m.color);
    if (baseColor) material.color.copy(baseColor);

    // Per-face colors (brep_faces with first/last triangle ranges) -> vertex colors
    const faces = Array.isArray(m.brep_faces) ? m.brep_faces.filter((f) => Array.isArray(f.color)) : [];
    const distinct = new Set(faces.map((f) => f.color.join(',')));
    if (faces.length && (distinct.size > 1 || !baseColor)) {
      geometry = geometry.index ? geometry.toNonIndexed() : geometry;
      const triCount = geometry.attributes.position.count / 3;
      const colors = new Float32Array(triCount * 9);
      const fallback = baseColor || new THREE.Color(DEFAULT_COLOR);
      for (let t = 0; t < triCount; t++) {
        for (let v = 0; v < 3; v++) {
          const o = (t * 3 + v) * 3;
          colors[o] = fallback.r; colors[o + 1] = fallback.g; colors[o + 2] = fallback.b;
        }
      }
      faces.forEach((f) => {
        const c = occtColorToHex(f.color);
        if (!c) return;
        for (let t = f.first; t <= f.last && t < triCount; t++) {
          for (let v = 0; v < 3; v++) {
            const o = (t * 3 + v) * 3;
            colors[o] = c.r; colors[o + 1] = c.g; colors[o + 2] = c.b;
          }
        }
      });
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      material.vertexColors = true;
      material.color.set(0xffffff);
    }

    if (!geometry.attributes.normal) geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = (m.name || '').trim() || names.get(i) || `Part ${i + 1}`;
    group.add(mesh);
  });

  if (group.children.length === 0) throw new Error('STEP file contained no renderable geometry.');
  return group;
}

// --- STL / 3MF ---------------------------------------------------------------------

function stlToGroup(buffer, stem) {
  const parsed = new STLLoader().parse(buffer);
  const material = new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR, metalness: 0.1, roughness: 0.55 });
  if (parsed.hasColors && parsed.attributes.color) {
    material.vertexColors = true;
    material.color.set(0xffffff);
  }
  // STL facet normals are frequently zero or unreliable; recompute from geometry.
  const geometry = finalizeGeometry(parsed);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = stem;
  const group = new THREE.Group();
  group.name = stem;
  group.add(mesh);
  return group;
}

function toStandard(src) {
  const mat = new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.55 });
  // No material in the file (three's placeholder) -> neutral grey, same as STL.
  if (!src || src.name === '__DEFAULT') { mat.color.set(DEFAULT_COLOR); return mat; }
  if (src.color) mat.color.copy(src.color);
  if (src.vertexColors) { mat.vertexColors = true; mat.color.set(0xffffff); }
  if (typeof src.opacity === 'number' && src.opacity < 1) { mat.opacity = src.opacity; mat.transparent = true; }
  return mat;
}

function threeMfToGroup(buffer, stem) {
  const loaded = new ThreeMFLoader().parse(buffer);
  const group = new THREE.Group();
  group.name = stem;
  loaded.updateMatrixWorld(true);

  let counter = 0;
  loaded.traverse((obj) => {
    if (!obj.isMesh) return;
    counter++;
    // Bake transforms so the exported GLB is a flat list of named parts.
    let geometry = obj.geometry.clone();
    geometry.applyMatrix4(obj.matrixWorld);
    geometry = finalizeGeometry(geometry);

    const srcMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const material = toStandard(srcMat);
    if (!geometry.attributes.color) material.vertexColors = false;

    const mesh = new THREE.Mesh(geometry, material);
    let name = (obj.name || '').trim();
    let p = obj.parent;
    while (!name && p && p !== loaded) { name = (p.name || '').trim(); p = p.parent; }
    mesh.name = name || `Part ${counter}`;
    group.add(mesh);
  });

  if (group.children.length === 0) throw new Error('3MF file contained no mesh objects.');
  return group;
}

// --- GLB export --------------------------------------------------------------------

function exportGlb(root) {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(new Blob([result], { type: 'model/gltf-binary' }));
        else reject(new Error('GLTFExporter did not return binary output'));
      },
      (err) => reject(err instanceof Error ? err : new Error('GLB export failed')),
      { binary: true, onlyVisible: true, truncateDrawRange: true }
    );
  });
}

function summarizeParts(root) {
  const parts = [];
  let triangles = 0;
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const geo = obj.geometry;
    const count = geo.index ? geo.index.count : geo.attributes.position.count;
    triangles += Math.floor(count / 3);
    const m = obj.material;
    parts.push({
      name: obj.name,
      color: m.vertexColors ? null : ('#' + m.color.getHexString()),
      opacity: typeof m.opacity === 'number' ? m.opacity : 1
    });
  });
  return { parts, triangles };
}

/**
 * Convert a File (STL / 3MF / STEP) into a GLB Blob.
 * @param {File} file
 * @param {(stage: string) => void} [onStage] progress callback with a human-readable stage label
 * @returns {Promise<{ glbBlob: Blob, parts: Array<{name:string,color:string|null,opacity:number}>, triangles: number, format: string, stem: string }>}
 */
async function convertToGlb(file, onStage = () => {}) {
  const ext = extOf(file.name);
  if (!SUPPORTED_EXTS.includes(ext)) throw new Error(`Unsupported model type ".${ext}" — use STL, 3MF or STEP.`);
  const stem = stemOf(file.name);
  const format = ext === 'stp' ? 'step' : ext;

  onStage('Reading file…');
  const buffer = await readAsArrayBuffer(file);

  let root;
  if (ext === 'stl') {
    onStage('Parsing STL…');
    root = stlToGroup(buffer, stem);
  } else if (ext === '3mf') {
    onStage('Parsing 3MF…');
    root = threeMfToGroup(buffer, stem);
  } else {
    onStage('Loading OpenCascade…');
    const occt = await loadOcct();
    onStage('Tessellating STEP…');
    const result = occt.ReadStepFile(new Uint8Array(buffer), {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.0015,
      angularDeflection: 0.35
    });
    root = stepToGroup(result, stem);
  }

  onStage('Exporting GLB…');
  const glbBlob = await exportGlb(root);
  const { parts, triangles } = summarizeParts(root);

  // Free GPU-side objects we created (nothing was rendered, but geometries hold memory).
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material && obj.material.dispose) obj.material.dispose();
  });

  return { glbBlob, parts, triangles, format, stem };
}

window.ModelTools = { convertToGlb, isModelFile, SUPPORTED_EXTS, loadOcct };
