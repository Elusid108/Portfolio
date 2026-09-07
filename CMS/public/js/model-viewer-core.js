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
//     url, parts, up, view, onProgress(fraction), onReady({ parts }),
//     onPartHover(hit|null), onPartActivate(hit)  // CMS editor only
//   });
//   viewer.setPart(0, { color: '#ff0000', opacity: 0.5 });
//   viewer.resetView(); viewer.setAutoRotate(true); await viewer.capture();
//   viewer.getView(); viewer.dispose();
(function () {
  if (typeof window === 'undefined') return;
  if (window.ModelViewerCore) return;

  const DEFAULT_COLOR = '#9ca3af';
  const BACKGROUND = 0x18181b;
  const MAX_PIXEL_RATIO = 2;

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
    renderer.toneMappingExposure = 1.05;
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

    const hemi = new THREE.HemisphereLight(0xffffff, 0x3f3f46, 1.6);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, 1.6, 1.2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.9);
    fill.position.set(-1.2, 0.4, -1);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.6);
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
      controls.enableRotate = !panning;
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
      if (pointers.size > 0 || isPanning()) {
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

    function onPointerDown(e) {
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
        && !isPanning();
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

    function applyUp() {
      upGroup.rotation.set(0, 0, 0);
      upGroup.position.set(0, 0, 0);
      if (state.up === 'z') upGroup.rotation.x = -Math.PI / 2;
      upGroup.updateMatrixWorld(true);
      if (!modelRoot) return;
      // Center the model's bounding box on the world origin.
      const box = new THREE.Box3().setFromObject(upGroup);
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
      return parts.map((p) => ({
        name: p.name,
        color: p.color || p.fileColor || DEFAULT_COLOR,
        opacity: clamp01(p.opacity, 1),
        fileColor: p.fileColor,
        hasVertexColors: p.hasVertexColors
      }));
    }

    function getState() {
      return {
        up: state.up,
        parts: parts.map((p) => ({
          name: p.name,
          color: p.color || p.fileColor || DEFAULT_COLOR,
          opacity: Math.round(clamp01(p.opacity, 1) * 1000) / 1000
        })),
        view: getView()
      };
    }

    function setUp(axis) {
      state.up = axis === 'y' ? 'y' : 'z';
      applyUp();
      resetView();
    }

    function setAutoRotate(on) {
      state.autoRotate = !!on;
      controls.autoRotate = state.autoRotate;
      requestRender();
    }

    // --- sizing ---------------------------------------------------------------------
    function resize() {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      applyViewPanTo(camera, w, h);
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
      if (moved || needsRender || controls.autoRotate) {
        renderer.render(scene, camera);
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
      controls.autoRotate = false;
      pivotMarker.visible = false;
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      applyViewPanTo(camera, width, height);
      renderer.render(scene, camera);
      let blob;
      try {
        blob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Capture failed'))), type, quality);
        });
      } finally {
        renderer.setPixelRatio(prevRatio);
        controls.autoRotate = prevAutoRotate;
        pivotMarker.visible = prevMarker;
        resize();
        renderer.render(scene, camera);
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
      controls.dispose();
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      window.removeEventListener('resize', resize);
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
    resize();
    renderer.render(scene, camera);

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
      capture,
      requestRender,
      dispose
    };

    if (typeof opts.onReady === 'function') opts.onReady({ parts: listParts(), viewer: api });
    return api;
  }

  window.ModelViewerCore = { createModelViewer, loadLibs, DEFAULT_COLOR };
})();
