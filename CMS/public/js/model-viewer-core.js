// Model viewer core — framework-free three.js GLB viewer shared by the CMS
// admin (model editor / thumbnail capture) and the published site (lightbox).
//
// This file is loaded directly by CMS/public/index.html and is inlined into
// the published index.html by CMS/lib/publish.js via the {{MODEL_VIEWER_CORE}}
// placeholder, so it must stay self-contained: no exports, no bare imports at
// the top level. three.js itself is pulled lazily through the page's import map
// (see the "three" / "three/addons/" entries) the first time a model opens.
//
// Usage:
//   const viewer = await ModelViewerCore.createModelViewer(containerEl, {
//     url, parts, up, view, matrix, gizmo, onProgress(fraction), onReady({ parts }),
//     onPartHover(hit|null), onPartActivate(hit), onMatrixChange()  // CMS editor
//   });
//   viewer.setPart(0, { color: '#ff0000', opacity: 0.5 });
//   viewer.setMatrix({ cols: 16, rows: 16 }); viewer.fitMatrix();
//   viewer.setPreset('rainbow'); viewer.setIntensity(0.32); viewer.setBloom(0.18);
//   viewer.resetView(); viewer.setAutoRotate(true); await viewer.capture();
//   viewer.getView(); viewer.dispose();
(function () {
  if (typeof window === 'undefined') return;
  if (window.ModelViewerCore) return;

  const DEFAULT_COLOR = '#9ca3af';
  const BACKGROUND = 0x18181b;
  const MAX_PIXEL_RATIO = 2;
  const MATRIX_PRESETS = ['rainbow', 'chase', 'plasma', 'solid'];
  const STUDIO = { hemi: 1.6, key: 2.2, fill: 0.9, rim: 0.6, exposure: 1.05 };
  const STUDIO_LIT = { hemi: 0.16, key: 0.22, fill: 0.1, rim: 0.08, exposure: 1.0 };
  const DEFAULT_INTENSITY = 0.32;
  const DEFAULT_BLOOM = 0.18;
  const GAIN_AT_FULL = 2.2;
  const BLOOM_AT_FULL = 0.72;

  let libPromise = null;
  function loadLibs() {
    if (!libPromise) {
      libPromise = Promise.all([
        import('three'),
        import('three/addons/controls/OrbitControls.js'),
        import('three/addons/loaders/GLTFLoader.js')
      ]).then(([THREE, orbit, gltf]) => ({
        THREE,
        OrbitControls: orbit.OrbitControls,
        GLTFLoader: gltf.GLTFLoader
      })).catch((err) => {
        libPromise = null;
        throw err;
      });
    }
    return libPromise;
  }

  function normalizeHex(value, fallback) {
    if (typeof value !== 'string') return fallback;
    const v = value.trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(v)) {
      return ('#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase();
    }
    return fallback;
  }

  function clamp01(n, fallback = 1) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(1, Math.max(0, v));
  }

  function roundN(n, digits) {
    const f = 10 ** digits;
    return Math.round(Number(n) * f) / f;
  }

  function luminance(hex) {
    const h = normalizeHex(hex, '#ffffff');
    if (!h) return 1;
    const r = parseInt(h.slice(1, 3), 16) / 255;
    const g = parseInt(h.slice(3, 5), 16) / 255;
    const b = parseInt(h.slice(5, 7), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function defaultReceiveForColor(hex) {
    return luminance(hex) > 0.14;
  }

  function hslToRgb(h, s, l, out, i) {
    h = ((h % 1) + 1) % 1;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h * 12) % 12;
      return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    };
    out[i] = Math.round(f(0) * 255);
    out[i + 1] = Math.round(f(8) * 255);
    out[i + 2] = Math.round(f(4) * 255);
    out[i + 3] = 255;
  }

  function sanitizeMatrix(raw, partCount) {
    if (!raw || typeof raw !== 'object') return null;
    const size = (Number(raw.cols) === 8 || Number(raw.rows) === 8) ? 8 : 16;
    const pitch = Number(raw.pitch);
    const origin = [0, 0, 0];
    if (Array.isArray(raw.origin) && raw.origin.length >= 3) {
      for (let i = 0; i < 3; i++) {
        const n = Number(raw.origin[i]);
        origin[i] = Number.isFinite(n) ? n : 0;
      }
    }
    const quaternion = [0, 0, 0, 1];
    if (Array.isArray(raw.quaternion) && raw.quaternion.length >= 4) {
      for (let i = 0; i < 4; i++) {
        const n = Number(raw.quaternion[i]);
        quaternion[i] = Number.isFinite(n) ? n : (i === 3 ? 1 : 0);
      }
      const len = Math.hypot(quaternion[0], quaternion[1], quaternion[2], quaternion[3]) || 1;
      for (let i = 0; i < 4; i++) quaternion[i] /= len;
    }
    const nParts = Math.max(0, Number(partCount) || (Array.isArray(raw.receive) ? raw.receive.length : 0));
    let receive = null;
    if (Array.isArray(raw.receive)) {
      receive = [];
      for (let i = 0; i < nParts; i++) receive.push(!!raw.receive[i]);
    }
    const preset = MATRIX_PRESETS.includes(raw.preset) ? raw.preset : 'rainbow';
    const intensity = clamp01(raw.intensity, DEFAULT_INTENSITY);
    const bloom = clamp01(raw.bloom, DEFAULT_BLOOM);
    return {
      enabled: raw.enabled !== false,
      cols: size,
      rows: size,
      pitch: Number.isFinite(pitch) && pitch > 0 ? pitch : 10,
      origin,
      quaternion,
      preset,
      intensity,
      bloom,
      receive
    };
  }

  async function createModelViewer(container, opts = {}) {
    if (!container) throw new Error('ModelViewerCore: container element required');
    const { THREE, OrbitControls, GLTFLoader } = await loadLibs();

    const state = {
      up: opts.up === 'y' ? 'y' : 'z',
      autoRotate: !!opts.autoRotate,
      disposed: false
    };

    // --- renderer / scene / camera -------------------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = STUDIO.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    canvas.setAttribute('aria-label', opts.label || '3D model viewer');
    canvas.setAttribute('role', 'img');
    container.appendChild(canvas);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(opts.background != null ? opts.background : BACKGROUND);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x3f3f46, STUDIO.hemi);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, STUDIO.key);
    key.position.set(1, 1.6, 1.2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, STUDIO.fill);
    fill.position.set(-1.2, 0.4, -1);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, STUDIO.rim);
    rim.position.set(0.2, -1, 0.6);
    scene.add(rim);

    // --- controls -------------------------------------------------------------------
    // Left-drag rotates around the current orbit pivot (bbox center by default).
    // Left-click on the mesh sets that hit as the pivot; click empty space restores
    // the bbox center. Right-drag / two-finger pan shifts the projection
    // (setViewOffset). Wheel / pinch zoom toward the current pivot.
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.9;
    controls.zoomSpeed = 0.9;
    controls.enablePan = false;
    controls.autoRotate = state.autoRotate;
    controls.autoRotateSpeed = 1.6;
    controls.target.set(0, 0, 0);

    const viewPan = { x: 0, y: 0 };
    const CLICK_PX = 5;
    let clickCandidate = null;

    const pivotMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85, depthTest: true })
    );
    pivotMarker.visible = false;
    pivotMarker.renderOrder = 10;
    scene.add(pivotMarker);

    function orbitPivotIsCenter() {
      return controls.target.lengthSq() < 1e-10;
    }

    function syncPivotMarker() {
      pivotMarker.position.copy(controls.target);
      const s = Math.max(boundingRadius * 0.018, 1e-4);
      pivotMarker.scale.setScalar(s);
      pivotMarker.visible = !orbitPivotIsCenter();
    }

    function setOrbitPivot(worldPoint) {
      if (!worldPoint) controls.target.set(0, 0, 0);
      else controls.target.copy(worldPoint);
      controls.update();
      syncPivotMarker();
      requestRender();
    }

    function resetOrbitPivot() {
      setOrbitPivot(null);
    }

    function applyViewPanTo(cam, w, h) {
      const width = Math.max(1, w);
      const height = Math.max(1, h);
      if (!viewPan.x && !viewPan.y) {
        cam.clearViewOffset();
      } else {
        cam.setViewOffset(width, height, viewPan.x * width, viewPan.y * height, width, height);
      }
      cam.updateProjectionMatrix();
    }

    function applyViewPan() {
      applyViewPanTo(camera, container.clientWidth, container.clientHeight);
      requestRender();
    }

    const pointers = new Map();
    let panLast = null;

    function pointerMidpoint() {
      let x = 0;
      let y = 0;
      pointers.forEach((p) => { x += p.x; y += p.y; });
      const n = Math.max(1, pointers.size);
      return { x: x / n, y: y / n };
    }

    function isPanning() {
      if (pointers.size >= 2) return true;
      for (const p of pointers.values()) {
        if (p.button === 2) return true;
      }
      return false;
    }

    function syncPanRotate() {
      const panning = isPanning();
      controls.enableRotate = !panning && !gizmoDragging;
      if (!panning) panLast = null;
    }

    const hoverEnabled = typeof opts.onPartHover === 'function';
    const activateEnabled = typeof opts.onPartActivate === 'function';
    const ndc = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    let hoverQueued = null;
    let hoverRaf = 0;
    let lastHoverKey = undefined;
    let parts = []; // { mesh, material, name, fileColor, fileOpacity, color, opacity, hasVertexColors }

    function emitHover(hit) {
      if (!hoverEnabled) return;
      const key = hit ? hit.index : null;
      if (key === lastHoverKey && !hit) return;
      lastHoverKey = key;
      opts.onPartHover(hit);
    }

    function scheduleHover(e) {
      if (!hoverEnabled) return;
      if (pointers.size > 0 || isPanning() || gizmoDragging) {
        hoverQueued = null;
        emitHover(null);
        return;
      }
      hoverQueued = { x: e.clientX, y: e.clientY };
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const q = hoverQueued;
        if (!q || pointers.size > 0) return;
        const hit = hitTest(q.x, q.y);
        emitHover(hit ? { index: hit.index, name: hit.name, x: q.x, y: q.y } : null);
      });
    }

    function gizmoBusy() {
      return !!(transformControls && (transformControls.dragging || transformControls.axis));
    }

    function onPointerDown(e) {
      if (gizmoBusy()) {
        clickCandidate = null;
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
      if (e.button === 0 && pointers.size === 1) {
        clickCandidate = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      } else {
        clickCandidate = null;
      }
      if (e.button === 2 || pointers.size >= 2) panLast = pointerMidpoint();
      syncPanRotate();
      emitHover(null);
    }

    function onPointerMove(e) {
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: pointers.get(e.pointerId).button });
        if (clickCandidate && clickCandidate.pointerId === e.pointerId) {
          if (Math.hypot(e.clientX - clickCandidate.x, e.clientY - clickCandidate.y) > CLICK_PX) {
            clickCandidate = null;
          }
        }
        if (isPanning()) {
          clickCandidate = null;
          const now = pointerMidpoint();
          if (!panLast) { panLast = now; return; }
          const w = Math.max(1, container.clientWidth);
          const h = Math.max(1, container.clientHeight);
          viewPan.x -= (now.x - panLast.x) / w;
          viewPan.y -= (now.y - panLast.y) / h;
          panLast = now;
          applyViewPan();
          return;
        }
      }
      scheduleHover(e);
    }

    function hitTest(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      ndc.set(
        ((clientX - rect.left) / w) * 2 - 1,
        -((clientY - rect.top) / h) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);
      const meshes = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.mesh && clamp01(p.opacity, 1) > 0) meshes.push(p.mesh);
      }
      if (!meshes.length) return null;
      const hits = raycaster.intersectObjects(meshes, false);
      if (!hits.length) return null;
      const mesh = hits[0].object;
      const index = typeof mesh.userData.partIndex === 'number'
        ? mesh.userData.partIndex
        : parts.findIndex((p) => p.mesh === mesh);
      if (index < 0 || !parts[index]) return null;
      return { index, name: parts[index].name, point: hits[0].point };
    }

    function trySetPivotFromClick(e) {
      if (gizmoBusy()) return;
      const hit = hitTest(e.clientX, e.clientY);
      if ((e.ctrlKey || e.metaKey) && activateEnabled) {
        if (hit) opts.onPartActivate({ index: hit.index, name: hit.name });
        return;
      }
      if (hit) setOrbitPivot(hit.point);
      else resetOrbitPivot();
    }

    function onPointerUp(e) {
      const wasClick = clickCandidate
        && clickCandidate.pointerId === e.pointerId
        && e.button === 0
        && pointers.size <= 1
        && !isPanning()
        && !gizmoDragging;
      pointers.delete(e.pointerId);
      if (wasClick) trySetPivotFromClick(e);
      clickCandidate = null;
      syncPanRotate();
      scheduleHover(e);
    }

    function onPointerLeave() {
      hoverQueued = null;
      emitHover(null);
    }

    function onContextMenu(e) { e.preventDefault(); }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('contextmenu', onContextMenu);

    // --- model graph ----------------------------------------------------------------
    // pivot (world origin) -> upGroup (up-axis rotation, offset so bbox center sits at origin) -> gltf scene
    const pivot = new THREE.Group();
    scene.add(pivot);
    const upGroup = new THREE.Group();
    pivot.add(upGroup);

    let modelRoot = null;
    let boundingRadius = 1;
    let needsRender = true;
    let rafId = 0;

    function requestRender() { needsRender = true; }

    function computeModelBounds() {
      const box = new THREE.Box3();
      if (parts.length) {
        parts.forEach((p) => { if (p.mesh) box.expandByObject(p.mesh); });
      } else if (modelRoot) {
        box.setFromObject(modelRoot);
      } else {
        box.setFromObject(upGroup);
      }
      return box;
    }

    function applyUp() {
      upGroup.rotation.set(0, 0, 0);
      upGroup.position.set(0, 0, 0);
      if (state.up === 'z') upGroup.rotation.x = -Math.PI / 2;
      upGroup.updateMatrixWorld(true);
      if (!modelRoot) return;
      // Center the model's bounding box on the world origin (parts only — skip the LED grid).
      const box = computeModelBounds();
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      upGroup.position.copy(center.negate());
      upGroup.updateMatrixWorld(true);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      boundingRadius = Math.max(sphere.radius, 1e-3);
      camera.near = boundingRadius / 100;
      camera.far = boundingRadius * 200;
      camera.updateProjectionMatrix();
      controls.minDistance = boundingRadius * 0.15;
      controls.maxDistance = boundingRadius * 12;
      resetOrbitPivot();
      requestRender();
    }

    function defaultDistance() {
      const fov = THREE.MathUtils.degToRad(camera.fov);
      return (boundingRadius / Math.sin(fov / 2)) * 1.12;
    }

    function roundViewNum(n, digits) {
      const f = 10 ** digits;
      return Math.round(n * f) / f;
    }

    function getView() {
      // Origin-relative spherical from the live camera; click-pivot is session-only.
      const spherical = new THREE.Spherical().setFromVector3(camera.position);
      return {
        theta: roundViewNum(spherical.theta, 4),
        phi: roundViewNum(spherical.phi, 4),
        radiusScale: roundViewNum(spherical.radius / Math.max(boundingRadius, 1e-6), 3),
        panX: roundViewNum(viewPan.x, 4),
        panY: roundViewNum(viewPan.y, 4)
      };
    }

    function setView(view) {
      if (!view || typeof view !== 'object') {
        resetView();
        return;
      }
      const theta = Number(view.theta);
      const phi = Number(view.phi);
      const radiusScale = Number(view.radiusScale);
      if (![theta, phi, radiusScale].every(Number.isFinite)) {
        resetView();
        return;
      }
      const radius = Math.max(
        controls.minDistance,
        Math.min(controls.maxDistance, radiusScale * boundingRadius)
      );
      const spherical = new THREE.Spherical(radius, phi, theta);
      camera.position.setFromSpherical(spherical);
      camera.lookAt(0, 0, 0);
      resetOrbitPivot();
      const panX = Number(view.panX);
      const panY = Number(view.panY);
      viewPan.x = Number.isFinite(panX) ? panX : 0;
      viewPan.y = Number.isFinite(panY) ? panY : 0;
      applyViewPan();
      controls.update();
      resetOrbitPivot();
      requestRender();
    }

    function resetView() {
      viewPan.x = 0;
      viewPan.y = 0;
      applyViewPan();
      resetOrbitPivot();
      const dir = new THREE.Vector3(1, 0.75, 1.25).normalize();
      camera.position.copy(dir.multiplyScalar(defaultDistance()));
      camera.lookAt(0, 0, 0);
      controls.update();
      resetOrbitPivot();
      requestRender();
    }

    function toStandardMaterial(src) {
      if (src && src.isMeshStandardMaterial) return src.clone();
      const mat = new THREE.MeshStandardMaterial();
      if (src && src.color) mat.color.copy(src.color);
      if (src && typeof src.opacity === 'number') mat.opacity = src.opacity;
      if (src && src.vertexColors) mat.vertexColors = true;
      return mat;
    }

    function collectParts(root) {
      const found = [];
      root.traverse((obj) => {
        if (!obj.isMesh) return;
        if (obj.userData && obj.userData.ledDiode) return;
        const material = toStandardMaterial(Array.isArray(obj.material) ? obj.material[0] : obj.material);
        material.side = THREE.DoubleSide;
        material.metalness = Math.min(material.metalness ?? 0.1, 0.35);
        material.roughness = material.roughness != null ? material.roughness : 0.55;
        if (!obj.geometry.attributes.normal) material.flatShading = true;
        obj.material = material;
        const hasVertexColors = !!(obj.geometry.attributes.color);
        const fileColor = hasVertexColors ? null : ('#' + material.color.getHexString());
        const name = (obj.name || (obj.parent && obj.parent.name) || '').trim() || `Part ${found.length + 1}`;
        obj.userData.partIndex = found.length;
        found.push({
          mesh: obj,
          material,
          name,
          hasVertexColors,
          fileColor,
          fileOpacity: clamp01(material.opacity, 1),
          color: fileColor,
          opacity: clamp01(material.opacity, 1)
        });
      });
      return found;
    }

    function applyPart(part) {
      const m = part.material;
      if (part.color) {
        m.vertexColors = false;
        m.color.set(part.color);
      } else if (part.hasVertexColors) {
        m.vertexColors = true;
        m.color.set('#ffffff');
      } else {
        m.color.set(part.fileColor || DEFAULT_COLOR);
      }
      const o = clamp01(part.opacity, 1);
      m.opacity = o;
      m.transparent = o < 0.999;
      m.depthWrite = !m.transparent;
      m.needsUpdate = true;
      requestRender();
    }

    function setPart(index, patch = {}) {
      const part = parts[index];
      if (!part) return;
      if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
        part.color = patch.color === null ? null : normalizeHex(patch.color, part.color || part.fileColor || DEFAULT_COLOR);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'opacity')) {
        part.opacity = clamp01(patch.opacity, 1);
      }
      applyPart(part);
    }

    function resetPart(index) {
      const part = parts[index];
      if (!part) return;
      part.color = part.fileColor;
      part.opacity = part.fileOpacity;
      applyPart(part);
    }

    function applyOverrides(list) {
      if (!Array.isArray(list)) return;
      list.forEach((entry, i) => {
        if (!entry || !parts[i]) return;
        setPart(i, { color: entry.color ?? parts[i].color, opacity: entry.opacity ?? parts[i].opacity });
      });
    }

    function listParts() {
      return parts.map((p, i) => ({
        name: p.name,
        color: p.color || p.fileColor || DEFAULT_COLOR,
        opacity: clamp01(p.opacity, 1),
        fileColor: p.fileColor,
        hasVertexColors: p.hasVertexColors,
        receive: matrixCfg ? !!(matrixCfg.receive && matrixCfg.receive[i]) : undefined
      }));
    }

    function getState() {
      const out = {
        up: state.up,
        parts: parts.map((p) => ({
          name: p.name,
          color: p.color || p.fileColor || DEFAULT_COLOR,
          opacity: Math.round(clamp01(p.opacity, 1) * 1000) / 1000
        })),
        view: getView()
      };
      const matrix = getMatrix();
      if (matrix) out.matrix = matrix;
      return out;
    }

    function setUp(axis) {
      state.up = axis === 'y' ? 'y' : 'z';
      applyUp();
      resetView();
    }

    function setAutoRotate(on) {
      state.autoRotate = !!on;
      controls.autoRotate = state.autoRotate && !gizmoDragging;
      requestRender();
    }

    // --- LED matrix -----------------------------------------------------------------
    const ledUniforms = {
      uLedMap: { value: null },
      uLedOrigin: { value: new THREE.Vector3() },
      uLedU: { value: new THREE.Vector3(1, 0, 0) },
      uLedV: { value: new THREE.Vector3(0, 1, 0) },
      uLedSize: { value: new THREE.Vector2(16, 16) },
      uLedPitch: { value: 10 },
      uLedGain: { value: DEFAULT_INTENSITY * GAIN_AT_FULL },
      uLedOn: { value: 0 }
    };
    const worldOrigin = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const dummy = new THREE.Object3D();
    const tmpColor = new THREE.Color();
    const tmpBox = new THREE.Box3();
    const tmpSize = new THREE.Vector3();
    const tmpMat = new THREE.Matrix4();

    let matrixCfg = null;
    let matrixGroup = null;
    let diodeMesh = null;
    let ledData = null;
    let ledTexture = null;
    let composer = null;
    let bloomPass = null;
    let postPromise = null;
    let transformControls = null;
    let gizmoHelper = null;
    let gizmoDragging = false;
    let gizmoMode = null;
    let gizmoPromise = null;
    const wantGizmo = !!opts.gizmo;

    function applyStudio(lit) {
      const s = lit ? STUDIO_LIT : STUDIO;
      hemi.intensity = s.hemi;
      key.intensity = s.key;
      fill.intensity = s.fill;
      rim.intensity = s.rim;
      renderer.toneMappingExposure = s.exposure;
    }

    function applyLook() {
      if (!matrixCfg) return;
      const intensity = clamp01(matrixCfg.intensity, DEFAULT_INTENSITY);
      const bloom = clamp01(matrixCfg.bloom, DEFAULT_BLOOM);
      ledUniforms.uLedGain.value = intensity * GAIN_AT_FULL;
      if (bloomPass) bloomPass.strength = bloom * BLOOM_AT_FULL;
      if (ledData) writePresetFrame(performance.now() / 1000);
      requestRender();
    }

    function boxInModelSpace(mesh) {
      if (!mesh || !mesh.geometry || !modelRoot) {
        tmpBox.makeEmpty();
        return tmpBox;
      }
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      tmpBox.copy(mesh.geometry.boundingBox);
      mesh.updateWorldMatrix(true, false);
      modelRoot.updateWorldMatrix(true, false);
      tmpMat.copy(modelRoot.matrixWorld).invert().multiply(mesh.matrixWorld);
      tmpBox.applyMatrix4(tmpMat);
      return tmpBox;
    }

    function defaultReceiveList() {
      return parts.map((p) => defaultReceiveForColor(p.color || p.fileColor || DEFAULT_COLOR));
    }

    function ensureReceive() {
      if (!matrixCfg) return;
      const defaults = defaultReceiveList();
      if (!Array.isArray(matrixCfg.receive) || matrixCfg.receive.length !== parts.length) {
        const prev = Array.isArray(matrixCfg.receive) ? matrixCfg.receive : [];
        matrixCfg.receive = defaults.map((d, i) => (i < prev.length ? !!prev[i] : d));
      }
    }

    function disposeDiodes() {
      if (!diodeMesh) return;
      if (matrixGroup) matrixGroup.remove(diodeMesh);
      if (diodeMesh.geometry) diodeMesh.geometry.dispose();
      if (diodeMesh.material) diodeMesh.material.dispose();
      diodeMesh = null;
    }

    function rebuildLedTexture() {
      if (!matrixCfg) return;
      const cols = matrixCfg.cols;
      const rows = matrixCfg.rows;
      ledData = new Uint8Array(cols * rows * 4);
      if (ledTexture) ledTexture.dispose();
      ledTexture = new THREE.DataTexture(ledData, cols, rows, THREE.RGBAFormat);
      ledTexture.colorSpace = THREE.NoColorSpace;
      ledTexture.magFilter = THREE.LinearFilter;
      ledTexture.minFilter = THREE.LinearFilter;
      ledTexture.wrapS = THREE.ClampToEdgeWrapping;
      ledTexture.wrapT = THREE.ClampToEdgeWrapping;
      ledTexture.flipY = false;
      ledTexture.needsUpdate = true;
      ledUniforms.uLedMap.value = ledTexture;
      ledUniforms.uLedSize.value.set(cols, rows);
      ledUniforms.uLedPitch.value = matrixCfg.pitch;
    }

    function rebuildDiodes() {
      disposeDiodes();
      if (!matrixCfg || !matrixGroup) return;
      const cols = matrixCfg.cols;
      const rows = matrixCfg.rows;
      const pitch = matrixCfg.pitch;
      const count = cols * rows;
      const radius = Math.max(0.7, pitch * 0.22);
      const geo = new THREE.CircleGeometry(radius, 18);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        toneMapped: true
      });
      diodeMesh = new THREE.InstancedMesh(geo, mat, count);
      diodeMesh.userData.ledDiode = true;
      diodeMesh.frustumCulled = false;
      diodeMesh.renderOrder = 2;
      const colors = new Float32Array(count * 3);
      diodeMesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      let i = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          dummy.position.set(
            (c - (cols - 1) / 2) * pitch,
            (r - (rows - 1) / 2) * pitch,
            0
          );
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          diodeMesh.setMatrixAt(i, dummy.matrix);
          i++;
        }
      }
      diodeMesh.instanceMatrix.needsUpdate = true;
      diodeMesh.visible = matrixCfg.enabled !== false;
      matrixGroup.add(diodeMesh);
    }

    function applyMatrixPose() {
      if (!matrixCfg || !matrixGroup) return;
      matrixGroup.position.set(matrixCfg.origin[0], matrixCfg.origin[1], matrixCfg.origin[2]);
      matrixGroup.quaternion.set(
        matrixCfg.quaternion[0],
        matrixCfg.quaternion[1],
        matrixCfg.quaternion[2],
        matrixCfg.quaternion[3]
      );
      matrixGroup.updateMatrixWorld(true);
    }

    function syncLedWorldUniforms() {
      if (!matrixCfg || !matrixGroup) return;
      matrixGroup.updateMatrixWorld(true);
      matrixGroup.getWorldPosition(worldOrigin);
      matrixGroup.getWorldQuaternion(worldQuat);
      ledUniforms.uLedOrigin.value.copy(worldOrigin);
      ledUniforms.uLedU.value.set(1, 0, 0).applyQuaternion(worldQuat);
      ledUniforms.uLedV.value.set(0, 1, 0).applyQuaternion(worldQuat);
      ledUniforms.uLedPitch.value = matrixCfg.pitch;
      ledUniforms.uLedSize.value.set(matrixCfg.cols, matrixCfg.rows);
      ledUniforms.uLedOn.value = matrixCfg.enabled ? 1 : 0;
    }

    function writePresetFrame(t) {
      if (!matrixCfg || !ledData) return;
      const cols = matrixCfg.cols;
      const rows = matrixCfg.rows;
      const name = matrixCfg.preset;
      const n = cols * rows;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const idx = y * cols + x;
          const o = idx * 4;
          if (name === 'chase') {
            const head = (t * n * 0.45) % n;
            let dist = idx - head;
            if (dist < 0) dist += n;
            const tail = Math.max(4, Math.floor(n * 0.08));
            const k = dist < tail ? 1 - dist / tail : 0;
            hslToRgb((x / cols + t * 0.05) % 1, 1, 0.12 + 0.43 * k, ledData, o);
          } else if (name === 'plasma') {
            const v = 0.5 + 0.5 * Math.sin(x * 0.55 + t * 1.4) * Math.cos(y * 0.42 + t * 0.95);
            hslToRgb((0.55 + t * 0.04 + v * 0.28) % 1, 0.9, 0.18 + 0.32 * v, ledData, o);
          } else if (name === 'solid') {
            hslToRgb((t * 0.045) % 1, 0.85, 0.42, ledData, o);
          } else {
            hslToRgb((x / Math.max(1, cols - 1) + y / Math.max(1, rows - 1) * 0.15 + t * 0.08) % 1, 1, 0.48, ledData, o);
          }
        }
      }
      ledTexture.needsUpdate = true;
      if (diodeMesh && diodeMesh.instanceColor) {
        const dim = clamp01(matrixCfg.intensity, DEFAULT_INTENSITY);
        for (let i = 0; i < n; i++) {
          const o = i * 4;
          tmpColor.setRGB((ledData[o] / 255) * dim, (ledData[o + 1] / 255) * dim, (ledData[o + 2] / 255) * dim);
          diodeMesh.setColorAt(i, tmpColor);
        }
        diodeMesh.instanceColor.needsUpdate = true;
      }
    }

    function patchLedMaterial(part, receive) {
      const material = part.material;
      if (!material.userData.ledReceiveUniform) {
        material.userData.ledReceiveUniform = { value: receive ? 1 : 0 };
      } else {
        material.userData.ledReceiveUniform.value = receive ? 1 : 0;
      }
      if (material.userData.ledPatched) {
        material.needsUpdate = true;
        return;
      }
      material.userData.ledPatched = true;
      material.customProgramCacheKey = function () { return 'led-matrix-v2'; };
      material.onBeforeCompile = function (shader) {
        shader.uniforms.uLedMap = ledUniforms.uLedMap;
        shader.uniforms.uLedOrigin = ledUniforms.uLedOrigin;
        shader.uniforms.uLedU = ledUniforms.uLedU;
        shader.uniforms.uLedV = ledUniforms.uLedV;
        shader.uniforms.uLedSize = ledUniforms.uLedSize;
        shader.uniforms.uLedPitch = ledUniforms.uLedPitch;
        shader.uniforms.uLedGain = ledUniforms.uLedGain;
        shader.uniforms.uLedOn = ledUniforms.uLedOn;
        shader.uniforms.uLedReceive = material.userData.ledReceiveUniform;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vLedWorldPos;')
          .replace('#include <project_vertex>', '#include <project_vertex>\nvLedWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', [
            '#include <common>',
            'uniform sampler2D uLedMap;',
            'uniform vec3 uLedOrigin;',
            'uniform vec3 uLedU;',
            'uniform vec3 uLedV;',
            'uniform vec2 uLedSize;',
            'uniform float uLedPitch;',
            'uniform float uLedGain;',
            'uniform float uLedOn;',
            'uniform float uLedReceive;',
            'varying vec3 vLedWorldPos;'
          ].join('\n'))
          .replace('#include <emissivemap_fragment>', [
            '#include <emissivemap_fragment>',
            'if (uLedOn > 0.5 && uLedReceive > 0.5) {',
            '  vec3 nrm = normalize(cross(uLedU, uLedV));',
            '  vec3 rel = vLedWorldPos - uLedOrigin;',
            '  float lu = dot(rel, uLedU);',
            '  float lv = dot(rel, uLedV);',
            '  float depth = dot(rel, nrm);',
            '  float halfW = 0.5 * uLedSize.x * uLedPitch;',
            '  float halfH = 0.5 * uLedSize.y * uLedPitch;',
            '  if (depth > -8.0 && depth < 520.0 && abs(lu) <= halfW && abs(lv) <= halfH) {',
            '    vec2 uv = vec2(lu / (uLedSize.x * uLedPitch) + 0.5, lv / (uLedSize.y * uLedPitch) + 0.5);',
            '    vec3 led = texture2D(uLedMap, uv).rgb;',
            '    totalEmissiveRadiance += led * uLedGain;',
            '    diffuseColor.rgb += led * (0.065 * uLedGain);',
            '  }',
            '}'
          ].join('\n'));
        material.userData.ledShader = shader;
      };
      material.needsUpdate = true;
    }

    function syncPartReceive() {
      if (!matrixCfg) return;
      ensureReceive();
      parts.forEach((part, i) => {
        patchLedMaterial(part, !!matrixCfg.receive[i]);
      });
    }

    function ensureComposer() {
      if (composer) return Promise.resolve();
      if (!postPromise) {
        postPromise = Promise.all([
          import('three/addons/postprocessing/EffectComposer.js'),
          import('three/addons/postprocessing/RenderPass.js'),
          import('three/addons/postprocessing/UnrealBloomPass.js'),
          import('three/addons/postprocessing/OutputPass.js')
        ]).then(([ec, rp, ub, op]) => {
          if (state.disposed) return;
          composer = new ec.EffectComposer(renderer);
          composer.addPass(new rp.RenderPass(scene, camera));
          const size = new THREE.Vector2();
          renderer.getSize(size);
          bloomPass = new ub.UnrealBloomPass(size, DEFAULT_BLOOM * BLOOM_AT_FULL, 0.38, 0.28);
          composer.addPass(bloomPass);
          composer.addPass(new op.OutputPass());
          applyLook();
          resize();
        }).catch((err) => {
          postPromise = null;
          throw err;
        });
      }
      return postPromise;
    }

    function notifyMatrixChange() {
      if (typeof opts.onMatrixChange === 'function') opts.onMatrixChange();
    }

    function ensureGizmo() {
      if (!wantGizmo) return Promise.resolve();
      if (transformControls) return Promise.resolve();
      if (!gizmoPromise) {
        gizmoPromise = import('three/addons/controls/TransformControls.js').then((mod) => {
          if (state.disposed) return;
          transformControls = new mod.TransformControls(camera, canvas);
          transformControls.setSpace('world');
          transformControls.setSize(0.75);
          gizmoHelper = typeof transformControls.getHelper === 'function'
            ? transformControls.getHelper()
            : transformControls;
          scene.add(gizmoHelper);
          gizmoHelper.visible = false;
          transformControls.addEventListener('dragging-changed', (e) => {
            gizmoDragging = !!e.value;
            controls.enabled = !gizmoDragging;
            controls.enableRotate = !gizmoDragging;
            controls.autoRotate = state.autoRotate && !gizmoDragging;
            if (!gizmoDragging) notifyMatrixChange();
          });
          transformControls.addEventListener('change', requestRender);
          transformControls.addEventListener('objectChange', requestRender);
        }).catch((err) => {
          gizmoPromise = null;
          throw err;
        });
      }
      return gizmoPromise;
    }

    function setGizmoMode(mode) {
      gizmoMode = (mode === 'rotate' || mode === 'translate') ? mode : null;
      const apply = () => {
        if (!transformControls || !matrixGroup) return;
        if (!gizmoMode || !matrixCfg) {
          transformControls.detach();
          if (gizmoHelper) gizmoHelper.visible = false;
          requestRender();
          return;
        }
        transformControls.setMode(gizmoMode);
        transformControls.attach(matrixGroup);
        if (gizmoHelper) gizmoHelper.visible = true;
        requestRender();
      };
      if (!gizmoMode) {
        apply();
        return;
      }
      ensureGizmo().then(apply);
    }

    function setMatrixEnabled(on) {
      if (!matrixCfg) return;
      matrixCfg.enabled = !!on;
      ledUniforms.uLedOn.value = matrixCfg.enabled ? 1 : 0;
      if (diodeMesh) diodeMesh.visible = matrixCfg.enabled;
      applyStudio(matrixCfg.enabled);
      applyLook();
      if (matrixCfg.enabled && clamp01(matrixCfg.bloom, 0) > 0.001) {
        ensureComposer().then(() => { applyLook(); requestRender(); });
      }
      requestRender();
    }

    function setPreset(name) {
      if (!matrixCfg) return;
      matrixCfg.preset = MATRIX_PRESETS.includes(name) ? name : 'rainbow';
      requestRender();
    }

    function setIntensity(value) {
      if (!matrixCfg) return;
      matrixCfg.intensity = clamp01(value, DEFAULT_INTENSITY);
      applyLook();
    }

    function setBloom(value) {
      if (!matrixCfg) return;
      matrixCfg.bloom = clamp01(value, DEFAULT_BLOOM);
      applyLook();
      if (matrixCfg.enabled && matrixCfg.bloom > 0) ensureComposer().then(() => { applyLook(); requestRender(); });
    }

    function setPartReceive(index, on) {
      if (!matrixCfg || !parts[index]) return;
      ensureReceive();
      matrixCfg.receive[index] = !!on;
      patchLedMaterial(parts[index], !!on);
      requestRender();
    }

    function getMatrix() {
      if (!matrixCfg) return null;
      if (matrixGroup) {
        matrixCfg.origin = [
          roundN(matrixGroup.position.x, 3),
          roundN(matrixGroup.position.y, 3),
          roundN(matrixGroup.position.z, 3)
        ];
        matrixCfg.quaternion = [
          roundN(matrixGroup.quaternion.x, 5),
          roundN(matrixGroup.quaternion.y, 5),
          roundN(matrixGroup.quaternion.z, 5),
          roundN(matrixGroup.quaternion.w, 5)
        ];
      }
      ensureReceive();
      return {
        enabled: matrixCfg.enabled !== false,
        cols: matrixCfg.cols,
        rows: matrixCfg.rows,
        pitch: roundN(matrixCfg.pitch, 3),
        origin: matrixCfg.origin.slice(),
        quaternion: matrixCfg.quaternion.slice(),
        preset: matrixCfg.preset,
        intensity: roundN(clamp01(matrixCfg.intensity, DEFAULT_INTENSITY), 3),
        bloom: roundN(clamp01(matrixCfg.bloom, DEFAULT_BLOOM), 3),
        receive: parts.map((_, i) => !!(matrixCfg.receive && matrixCfg.receive[i]))
      };
    }

    function fitMatrix() {
      if (!matrixCfg || !parts.length || !modelRoot) return;
      const target = matrixCfg.cols * 10;
      const candidates = [];
      let closest = null;
      let closestScore = Infinity;
      let backZ = Infinity;
      parts.forEach((p) => {
        const box = boxInModelSpace(p.mesh).clone();
        if (box.isEmpty()) return;
        if (box.min.z < backZ) backZ = box.min.z;
        box.getSize(tmpSize);
        const span = Math.max(tmpSize.x, tmpSize.y);
        const score = Math.abs(span - target);
        const item = { box, span, score };
        if (score < closestScore) {
          closestScore = score;
          closest = item;
        }
        if (target > 0 && score / target < 0.25) candidates.push(item);
      });
      const picked = (candidates.length
        ? candidates.sort((a, b) => a.score - b.score)[0]
        : closest);
      if (!picked || !Number.isFinite(backZ)) return;
      const best = picked.box;
      const span = picked.span;
      const pitch = span / matrixCfg.cols;
      matrixCfg.pitch = Number.isFinite(pitch) && pitch > 0.1 ? pitch : matrixCfg.pitch;
      matrixCfg.origin = [
        (best.min.x + best.max.x) / 2,
        (best.min.y + best.max.y) / 2,
        backZ - Math.max(1, matrixCfg.pitch * 0.15)
      ];
      matrixCfg.quaternion = [0, 0, 0, 1];
      applyMatrixPose();
      rebuildLedTexture();
      rebuildDiodes();
      writePresetFrame(0);
      syncLedWorldUniforms();
      requestRender();
    }

    function removeMatrix() {
      setGizmoMode(null);
      disposeDiodes();
      if (matrixGroup && modelRoot) modelRoot.remove(matrixGroup);
      matrixGroup = null;
      matrixCfg = null;
      if (ledTexture) {
        ledTexture.dispose();
        ledTexture = null;
      }
      ledData = null;
      ledUniforms.uLedMap.value = null;
      ledUniforms.uLedOn.value = 0;
      parts.forEach((p) => {
        if (p.material && p.material.userData.ledReceiveUniform) {
          p.material.userData.ledReceiveUniform.value = 0;
        }
      });
      applyStudio(false);
      requestRender();
    }

    function setMatrix(raw, flags = {}) {
      const next = sanitizeMatrix(raw, parts.length);
      if (!next) {
        removeMatrix();
        return;
      }
      const sizeChanged = !matrixCfg
        || matrixCfg.cols !== next.cols
        || matrixCfg.rows !== next.rows
        || matrixCfg.pitch !== next.pitch;
      matrixCfg = next;
      ensureReceive();
      if (!matrixGroup) {
        matrixGroup = new THREE.Group();
        matrixGroup.name = '__ledMatrix';
        modelRoot.add(matrixGroup);
      }
      applyMatrixPose();
      if (sizeChanged || !ledTexture || !diodeMesh) {
        rebuildLedTexture();
        rebuildDiodes();
      } else if (diodeMesh) {
        diodeMesh.visible = matrixCfg.enabled !== false;
      }
      syncPartReceive();
      setMatrixEnabled(matrixCfg.enabled !== false);
      applyLook();
      if (flags.fit) fitMatrix();
      if (wantGizmo && !gizmoMode) setGizmoMode('translate');
      writePresetFrame(0);
      syncLedWorldUniforms();
      requestRender();
    }

    function matrixPlaying() {
      return !!(matrixCfg && matrixCfg.enabled);
    }

    function renderFrame() {
      const useBloom = matrixPlaying() && composer && clamp01(matrixCfg.bloom, 0) > 0.001;
      if (useBloom) composer.render();
      else renderer.render(scene, camera);
    }

    // --- sizing ---------------------------------------------------------------------
    function resize() {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      applyViewPanTo(camera, w, h);
      if (composer) {
        composer.setSize(w, h);
        if (bloomPass && bloomPass.setSize) bloomPass.setSize(w, h);
      }
      requestRender();
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
    if (ro) ro.observe(container);
    window.addEventListener('resize', resize);
    resize();

    // --- render loop ----------------------------------------------------------------
    let intersecting = true;
    const io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          intersecting = entries.some((e) => e.isIntersecting);
          if (intersecting) requestRender();
        })
      : null;
    if (io) io.observe(container);

    function tick() {
      if (state.disposed) return;
      rafId = requestAnimationFrame(tick);
      if (!intersecting) return;
      const moved = controls.update();
      if (moved) syncPivotMarker();
      const playing = matrixPlaying();
      if (playing) {
        writePresetFrame(performance.now() / 1000);
        syncLedWorldUniforms();
      }
      if (moved || needsRender || controls.autoRotate || playing) {
        renderFrame();
        needsRender = false;
      }
    }
    controls.addEventListener('change', requestRender);
    rafId = requestAnimationFrame(tick);

    // --- capture --------------------------------------------------------------------
    async function capture(width = 1600, height = 1200, type = 'image/png', quality) {
      const prevRatio = renderer.getPixelRatio();
      const prevAutoRotate = controls.autoRotate;
      const prevMarker = pivotMarker.visible;
      const prevHelper = gizmoHelper ? gizmoHelper.visible : false;
      controls.autoRotate = false;
      pivotMarker.visible = false;
      if (gizmoHelper) gizmoHelper.visible = false;
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      applyViewPanTo(camera, width, height);
      if (composer) {
        composer.setSize(width, height);
        if (bloomPass && bloomPass.setSize) bloomPass.setSize(width, height);
      }
      if (matrixPlaying()) {
        writePresetFrame(performance.now() / 1000);
        syncLedWorldUniforms();
        if (!composer) await ensureComposer();
      }
      renderFrame();
      let blob;
      try {
        blob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Capture failed'))), type, quality);
        });
      } finally {
        renderer.setPixelRatio(prevRatio);
        controls.autoRotate = prevAutoRotate;
        pivotMarker.visible = prevMarker;
        if (gizmoHelper) gizmoHelper.visible = prevHelper;
        resize();
        renderFrame();
      }
      return blob;
    }

    // --- dispose --------------------------------------------------------------------
    function dispose() {
      if (state.disposed) return;
      state.disposed = true;
      cancelAnimationFrame(rafId);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      controls.removeEventListener('change', requestRender);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('contextmenu', onContextMenu);
      if (transformControls) {
        try { transformControls.detach(); } catch (_) { /* ignore */ }
        try { transformControls.dispose(); } catch (_) { /* ignore */ }
      }
      if (gizmoHelper && gizmoHelper.parent) gizmoHelper.parent.remove(gizmoHelper);
      controls.dispose();
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      window.removeEventListener('resize', resize);
      if (ledTexture) ledTexture.dispose();
      if (composer && composer.dispose) composer.dispose();
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
        mats.forEach((m) => {
          Object.keys(m).forEach((k) => { if (m[k] && m[k].isTexture) m[k].dispose(); });
          m.dispose();
        });
      });
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch (_) { /* ignore */ }
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    // --- load -----------------------------------------------------------------------
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.load(
        opts.url,
        resolve,
        (xhr) => {
          if (typeof opts.onProgress === 'function' && xhr && xhr.total) {
            opts.onProgress(Math.min(1, xhr.loaded / xhr.total));
          }
        },
        (err) => reject(err instanceof Error ? err : new Error('Failed to load model'))
      );
    }).catch((err) => {
      dispose();
      throw err;
    });
    if (state.disposed) return null;

    modelRoot = gltf.scene || gltf.scenes[0];
    upGroup.add(modelRoot);
    parts = collectParts(modelRoot);
    parts.forEach(applyPart);
    applyOverrides(opts.parts);
    applyUp();
    if (opts.view) setView(opts.view);
    else resetView();
    if (opts.matrix) {
      const saved = sanitizeMatrix(opts.matrix, parts.length);
      if (saved) {
        setMatrix(saved, { fit: !Array.isArray(opts.matrix.origin) });
        if (wantGizmo) setGizmoMode('translate');
      }
    }
    resize();
    renderFrame();

    const api = {
      canvas,
      setPart,
      resetPart,
      setUp,
      getUp: () => state.up,
      resetView,
      getView,
      setView,
      setAutoRotate,
      isAutoRotating: () => state.autoRotate,
      listParts,
      getState,
      setMatrix,
      getMatrix,
      removeMatrix,
      fitMatrix,
      setMatrixEnabled,
      setPreset,
      setIntensity,
      setBloom,
      setPartReceive,
      setGizmoMode,
      getGizmoMode: () => gizmoMode,
      capture,
      requestRender,
      dispose
    };

    if (typeof opts.onReady === 'function') opts.onReady({ parts: listParts(), viewer: api });
    return api;
  }

  window.ModelViewerCore = {
    createModelViewer,
    loadLibs,
    DEFAULT_COLOR,
    MATRIX_PRESETS,
    sanitizeMatrix,
    defaultReceiveForColor
  };
})();
