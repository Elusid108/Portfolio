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
//     url, parts, up, onProgress(fraction), onReady({ parts })
//   });
//   viewer.setPart(0, { color: '#ff0000', opacity: 0.5 });
//   viewer.resetView(); viewer.setAutoRotate(true); await viewer.capture();
//   viewer.dispose();
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
    // Default "CAD" navigation: left-drag rotate, right-drag / two-finger pan,
    // wheel / pinch zoom. OrbitControls is pointer-event based, so mouse, touch
    // and stylus all work without special handling.
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.9;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.8;
    controls.screenSpacePanning = true;
    controls.autoRotate = state.autoRotate;
    controls.autoRotateSpeed = 1.6;
    controls.target.set(0, 0, 0);

    // OrbitControls pan moves camera AND target together. After a pan, rotate
    // would otherwise orbit a point that is no longer the model's bbox center
    // (world origin after applyUp). Snap the target back every frame so pan
    // trucks the camera while rotate/zoom stay locked to the model.
    function lockOrbitTarget() {
      controls.target.set(0, 0, 0);
    }

    // --- model graph ----------------------------------------------------------------
    // pivot (world origin) -> upGroup (up-axis rotation, offset so bbox center sits at origin) -> gltf scene
    const pivot = new THREE.Group();
    scene.add(pivot);
    const upGroup = new THREE.Group();
    pivot.add(upGroup);

    let modelRoot = null;
    let parts = []; // { mesh, material, name, fileColor, fileOpacity, color, opacity, hasVertexColors }
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
      lockOrbitTarget();
      requestRender();
    }

    function resetView() {
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const dist = (boundingRadius / Math.sin(fov / 2)) * 1.12;
      const dir = new THREE.Vector3(1, 0.75, 1.25).normalize();
      camera.position.copy(dir.multiplyScalar(dist));
      camera.lookAt(0, 0, 0);
      lockOrbitTarget();
      controls.update();
      lockOrbitTarget();
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
        }))
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
      camera.updateProjectionMatrix();
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
      lockOrbitTarget();
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
      controls.autoRotate = false;
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      let blob;
      try {
        blob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Capture failed'))), type, quality);
        });
      } finally {
        renderer.setPixelRatio(prevRatio);
        controls.autoRotate = prevAutoRotate;
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
      controls.removeEventListener('change', requestRender);
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
    resetView();
    resize();
    renderer.render(scene, camera);

    const api = {
      canvas,
      setPart,
      resetPart,
      setUp,
      getUp: () => state.up,
      resetView,
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
