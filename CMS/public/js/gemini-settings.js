/**
 * Gemini settings for the Portfolio CMS.
 * API key and model picks live in IndexedDB only — never in settings.json or the repo.
 * Model list fetch/split/sort copied from CharGen.AI.
 */
(function (global) {
  const DB_NAME = 'PortfolioCMS_DB';
  const DB_VERSION = 1;
  const STORE = 'settings';

  const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash-preview-09-2025';
  const DEFAULT_IMAGE_MODEL = 'gemini-3-flash-image';

  const TEXT_MODEL_EXCLUDE_PATTERNS = [
    'embedding',
    'aqa',
    'answer',
    'vision',
    'image',
    'tts',
    'robotics',
    'custom',
    'audio',
  ];

  const state = {
    ready: false,
    apiKey: '',
    availableTextModels: [],
    availableImageModels: [],
    selectedTextModel: DEFAULT_TEXT_MODEL,
    selectedImageModel: DEFAULT_IMAGE_MODEL,
    isRefreshingModels: false,
  };

  function modelIdFromApiName(name) {
    return (name || '').replace(/^models\//, '');
  }

  function getImageEndpointForModel(availableImageModels, selectedImageModel) {
    const m = (availableImageModels || []).find(
      (opt) => modelIdFromApiName(opt.name) === selectedImageModel
    );
    return m?.imageEndpoint ?? 'predict';
  }

  function sortModels(models) {
    return [...models].sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aHasGemini = aName.includes('gemini');
      const bHasGemini = bName.includes('gemini');
      const aHasGemma = aName.includes('gemma');
      const bHasGemma = bName.includes('gemma');

      if (aHasGemini && !bHasGemini) return -1;
      if (!aHasGemini && bHasGemini) return 1;
      if (aHasGemma && !bHasGemma) return -1;
      if (!aHasGemma && bHasGemma) return 1;
      return bName.localeCompare(aName);
    });
  }

  async function fetchGeminiModels(apiKey, current) {
    const key = apiKey?.trim();
    if (!key) return null;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
    );
    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error?.message || `HTTP ${response.status}`);
    }

    const rawModels = data.models ?? [];
    const textModels = [];
    const imageModels = [];

    for (const model of rawModels) {
      const name = model.name ?? '';
      const nameLower = name.toLowerCase();
      const displayName = model.displayName ?? modelIdFromApiName(name);
      const displayNameLower = displayName.toLowerCase();
      const methods = model.supportedGenerationMethods ?? model.supported_generation_methods ?? [];

      const hasGenerateContent = methods.some((m) => String(m).toLowerCase() === 'generatecontent');

      const textSearchHaystack = `${nameLower} ${displayNameLower}`;
      const excludedFromText = TEXT_MODEL_EXCLUDE_PATTERNS.some((p) =>
        textSearchHaystack.includes(p)
      );

      if (hasGenerateContent && !excludedFromText) {
        textModels.push({ name, displayName });
      }

      const isImagenByName = nameLower.includes('imagen') || nameLower.includes('image');
      const isImageByDisplayName = displayNameLower.includes('nano banana');
      const isImageModel = isImagenByName || isImageByDisplayName;

      if (isImageModel) {
        const isGeminiImage =
          hasGenerateContent &&
          (displayNameLower.includes('nano banana') ||
            (nameLower.includes('gemini') &&
              (displayNameLower.includes('image') || displayNameLower.includes('vision'))));
        const imageEndpoint = isGeminiImage ? 'generateContent' : 'predict';
        imageModels.push({ name, displayName, imageEndpoint });
      }
    }

    const sortedText = sortModels(textModels);
    const sortedImage = sortModels(imageModels);

    const textIds = sortedText.map((m) => modelIdFromApiName(m.name));
    let selectedTextModel = current.selectedTextModel;
    if (sortedText.length > 0 && !textIds.includes(selectedTextModel)) {
      selectedTextModel = modelIdFromApiName(sortedText[0].name);
    }

    const imageIds = sortedImage.map((m) => modelIdFromApiName(m.name));
    let selectedImageModel = current.selectedImageModel;
    if (sortedImage.length > 0 && !imageIds.includes(selectedImageModel)) {
      const nanoBanana = sortedImage.find((m) =>
        m.displayName.toLowerCase().includes('nano banana')
      );
      const safeDefault =
        nanoBanana ||
        sortedImage.find((m) => m.imageEndpoint === 'predict') ||
        sortedImage[0];
      selectedImageModel = modelIdFromApiName(safeDefault.name);
    }

    return {
      availableTextModels: sortedText,
      availableImageModels: sortedImage,
      selectedTextModel,
      selectedImageModel,
    };
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
    });
  }

  async function saveSetting(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE], 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.put({ key, value });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function getSetting(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE], 'readonly');
      const store = tx.objectStore(STORE);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function toast(text, kind) {
    const colors = { success: '#10b981', warning: '#f59e0b', error: '#ef4444', info: '#4f46e5' };
    if (typeof Toastify === 'function') {
      Toastify({
        text,
        duration: 3000,
        backgroundColor: colors[kind] || colors.info,
      }).showToast();
    }
  }

  function el(id) {
    return document.getElementById(id);
  }

  function escapeAttr(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function fillSelect(selectEl, models, selectedId) {
    if (!selectEl) return;
    selectEl.innerHTML = models
      .map((m) => {
        const id = modelIdFromApiName(m.name);
        const selected = id === selectedId ? ' selected' : '';
        return `<option value="${escapeAttr(id)}"${selected}>${escapeAttr(m.displayName || m.name)}</option>`;
      })
      .join('');
  }

  function keyForModelFetch() {
    const typed = el('gemini-api-key')?.value.trim() || '';
    return typed || state.apiKey;
  }

  function render() {
    const closeBtn = el('gemini-settings-close');
    const required = el('gemini-key-required');
    const modelsRow = el('gemini-models-row');
    const modelsCount = el('gemini-models-count');
    const refreshBtn = el('gemini-refresh-models');
    const refreshIcon = el('gemini-refresh-icon');
    const refreshLabel = el('gemini-refresh-label');
    const textWrap = el('gemini-text-model-wrap');
    const imageWrap = el('gemini-image-model-wrap');
    const keyInput = el('gemini-api-key');

    if (closeBtn) closeBtn.classList.toggle('hidden', !state.apiKey);
    if (required) required.classList.toggle('hidden', !!state.apiKey);
    if (keyInput && document.activeElement !== keyInput) {
      keyInput.value = state.apiKey || '';
    }

    const canFetch = !!keyForModelFetch();
    if (modelsRow) {
      modelsRow.classList.toggle('hidden', !canFetch);
      modelsRow.classList.toggle('flex', canFetch);
    }

    const hasLists = state.availableTextModels.length > 0 || state.availableImageModels.length > 0;
    if (modelsCount) {
      modelsCount.textContent = hasLists
        ? `${state.availableTextModels.length} text, ${state.availableImageModels.length} image models`
        : 'No models loaded — refresh to scan your account';
    }

    if (refreshBtn) refreshBtn.disabled = state.isRefreshingModels;
    if (refreshIcon) refreshIcon.classList.toggle('animate-spin', state.isRefreshingModels);
    if (refreshLabel) refreshLabel.textContent = state.isRefreshingModels ? 'Scanning…' : 'Refresh List';

    if (textWrap) textWrap.classList.toggle('hidden', state.availableTextModels.length === 0);
    if (imageWrap) imageWrap.classList.toggle('hidden', state.availableImageModels.length === 0);

    fillSelect(el('gemini-text-model'), state.availableTextModels, state.selectedTextModel);
    fillSelect(el('gemini-image-model'), state.availableImageModels, state.selectedImageModel);
  }

  function renderStorage(storage) {
    const box = el('gemini-storage-box');
    if (!box) return;
    if (!storage) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    const usedEl = el('gemini-storage-used');
    const availEl = el('gemini-storage-available');
    const availRow = el('gemini-storage-available-row');
    const bar = el('gemini-storage-bar');
    const pct = el('gemini-storage-percent');

    if (usedEl) usedEl.textContent = formatBytes(storage.used || 0);

    const hasQuota = !!storage.quota;
    if (availRow) availRow.classList.toggle('hidden', !hasQuota);
    if (availEl && hasQuota) availEl.textContent = formatBytes(storage.quota);

    const percent = hasQuota ? Number(storage.percentUsed) || 0 : 0;
    if (bar) bar.style.width = `${Math.min(percent, 100)}%`;
    if (pct) pct.textContent = hasQuota ? `${Number(percent).toFixed(1)}% used` : '';
  }

  async function loadStorage() {
    try {
      const res = await fetch('/api/storage');
      if (!res.ok) throw new Error(await res.text());
      renderStorage(await res.json());
    } catch (err) {
      console.error('Failed to read disk usage:', err);
      renderStorage({ used: 0, quota: 0, percentUsed: 0 });
    }
  }

  async function persistSelections() {
    try {
      await saveSetting('selectedTextModel', state.selectedTextModel);
      await saveSetting('selectedImageModel', state.selectedImageModel);
    } catch (e) {
      console.error('Failed to save model selection:', e);
    }
  }

  async function applyModelResult(result) {
    if (!result) return;
    state.availableTextModels = result.availableTextModels;
    state.availableImageModels = result.availableImageModels;
    state.selectedTextModel = result.selectedTextModel;
    state.selectedImageModel = result.selectedImageModel;
    await persistSelections();
    render();
  }

  async function refreshModels(key) {
    const trimmed = key?.trim();
    if (!trimmed) return;
    const result = await fetchGeminiModels(trimmed, {
      selectedTextModel: state.selectedTextModel,
      selectedImageModel: state.selectedImageModel,
    });
    await applyModelResult(result);
  }

  async function handleSaveKey() {
    const value = el('gemini-api-key')?.value.trim() || '';
    if (!value) {
      toast('Please enter a valid API key', 'warning');
      return;
    }
    state.apiKey = value;
    try {
      await saveSetting('apiKey', value);
    } catch (e) {
      console.error('Failed to save API key:', e);
      toast('Could not save API key in this browser', 'error');
      return;
    }
    toast('API key saved!', 'success');
    render();
    try {
      await refreshModels(value);
    } catch (e) {
      toast(e?.message || 'Failed to refresh models', 'error');
    }
  }

  async function handleRefreshModels() {
    const key = keyForModelFetch();
    if (!key) {
      toast('Enter or save an API key first', 'warning');
      return;
    }
    state.isRefreshingModels = true;
    render();
    try {
      await refreshModels(key);
      toast('Model list updated', 'success');
    } catch (e) {
      toast(e?.message || 'Failed to refresh models', 'error');
    } finally {
      state.isRefreshingModels = false;
      render();
    }
  }

  async function handleTextModelChange(value) {
    state.selectedTextModel = value;
    try {
      await saveSetting('selectedTextModel', value);
    } catch (e) {
      console.error('Failed to save text model:', e);
    }
  }

  async function handleImageModelChange(value) {
    state.selectedImageModel = value;
    try {
      await saveSetting('selectedImageModel', value);
    } catch (e) {
      console.error('Failed to save image model:', e);
    }
  }

  function isOpen() {
    return !el('gemini-settings-modal')?.classList.contains('hidden');
  }

  async function open() {
    if (!state.ready) await init();
    const modal = el('gemini-settings-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    render();
    void loadStorage();
    const input = el('gemini-api-key');
    if (input && !state.apiKey) input.focus();
  }

  function close() {
    const modal = el('gemini-settings-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  function bind() {
    el('gemini-save-key')?.addEventListener('click', () => void handleSaveKey());
    el('gemini-refresh-models')?.addEventListener('click', () => void handleRefreshModels());
    el('gemini-settings-close')?.addEventListener('click', close);
    el('gemini-api-key')?.addEventListener('input', render);
    el('gemini-api-key')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void handleSaveKey();
      }
    });
    el('gemini-text-model')?.addEventListener('change', (e) => {
      void handleTextModelChange(e.target.value);
    });
    el('gemini-image-model')?.addEventListener('change', (e) => {
      void handleImageModelChange(e.target.value);
    });
    el('gemini-settings-modal')?.addEventListener('click', (e) => {
      if (e.target === el('gemini-settings-modal')) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) close();
    });
  }

  async function init() {
    if (state.ready) return;
    if (state._initPromise) return state._initPromise;
    state._initPromise = (async () => {
      bind();
      try {
        const [key, textModel, imageModel] = await Promise.all([
          getSetting('apiKey'),
          getSetting('selectedTextModel'),
          getSetting('selectedImageModel'),
        ]);
        if (key) state.apiKey = key;
        if (textModel) state.selectedTextModel = textModel;
        if (imageModel) state.selectedImageModel = imageModel;
      } catch (e) {
        console.error('Failed to load Gemini settings:', e);
      }
      state.ready = true;
      render();
      if (state.apiKey) {
        try {
          await refreshModels(state.apiKey);
        } catch (e) {
          console.warn('Could not refresh Gemini models on load:', e?.message || e);
        }
      }
    })();
    return state._initPromise;
  }

  global.GeminiSettings = {
    init,
    open,
    close,
    getApiKey: () => state.apiKey,
    getSelectedTextModel: () => state.selectedTextModel,
    getSelectedImageModel: () => state.selectedImageModel,
    getAvailableImageModels: () => state.availableImageModels,
    getImageEndpointForModel,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void init());
  } else {
    void init();
  }
})(window);
