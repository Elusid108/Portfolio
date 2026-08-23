/**
 * Short/long description generation for the Portfolio CMS.
 * API key stays in the browser; prompts live on the server.
 */
(function (global) {
  const SPARKLE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="#fbbf24" d="M12 2.4 13.55 7.1 18.4 8.6l-4.85 1.5L12 14.8l-1.55-4.7L5.6 8.6l4.85-1.5L12 2.4z"/>' +
    '<path fill="#f59e0b" d="M5.2 14.4 6 16.7l2.3.8-2.3.8-.8 2.3-.8-2.3-2.3-.8 2.3-.8.8-2.3z"/>' +
    '<path fill="#fcd34d" d="M18.6 13.1 19.2 14.9 21 15.5l-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6.6-1.8z"/>' +
    '</svg>';

  const SPINNER_SVG =
    '<svg class="ql-ai-spin" viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="8" fill="none" stroke="#fbbf24" stroke-width="3" stroke-linecap="round" stroke-dasharray="40 20"/>' +
    '</svg>';

  let hooks = {};
  let modalBound = false;
  let interview = emptyInterview();

  function emptyInterview() {
    return {
      question: '',
      answered: [],
      skipped: [],
      asking: false,
      generating: false,
    };
  }

  function el(id) {
    return document.getElementById(id);
  }

  function toast(text, kind) {
    const colors = { success: '#10b981', warning: '#f59e0b', error: '#ef4444', info: '#4f46e5' };
    if (typeof Toastify === 'function') {
      Toastify({ text, duration: 4000, backgroundColor: colors[kind] || colors.info }).showToast();
    }
  }

  function requireKey() {
    const key = global.GeminiSettings && GeminiSettings.getApiKey && GeminiSettings.getApiKey();
    if (!key || !key.trim()) {
      toast('Add a Google AI API key first', 'warning');
      if (global.GeminiSettings) GeminiSettings.open();
      return '';
    }
    return key.trim();
  }

  function decorateButton(btn, title) {
    if (!btn) return;
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = SPARKLE_SVG;
  }

  function setButtonBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = !!busy;
    btn.classList.toggle('ql-ai-busy', !!busy);
    btn.innerHTML = busy ? SPINNER_SVG : SPARKLE_SVG;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function postGemini(task, messages) {
    const apiKey = requireKey();
    if (!apiKey) return null;
    const modelId =
      global.GeminiSettings && GeminiSettings.getSelectedTextModel
        ? GeminiSettings.getSelectedTextModel()
        : '';
    const res = await fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        apiKey,
        modelId,
        project: hooks.getProject ? hooks.getProject() : {},
        messages: messages || [],
      }),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      throw new Error('The CMS returned a non-JSON response');
    }
    if (!res.ok) throw new Error(data.error || 'Gemini request failed');
    return data;
  }

  async function generateShort() {
    const btn = document.querySelector('.ql-ai-short');
    if (!requireKey()) return;
    const longText = hooks.getLongText ? hooks.getLongText() : '';
    if (!longText) {
      toast('Write or paste a long description first', 'warning');
      return;
    }
    setButtonBusy(btn, true);
    try {
      const result = await postGemini('short');
      if (!result) return;
      if (hooks.setShortText) hooks.setShortText(result.text);
      toast('Short description updated', 'success');
    } catch (err) {
      toast(err.message || 'Failed to generate short description', 'error');
    } finally {
      setButtonBusy(btn, false);
    }
  }

  function isInterviewOpen() {
    return !el('gemini-copy-modal')?.classList.contains('hidden');
  }

  function messagesForAsk() {
    const msgs = [];
    interview.answered.forEach((pair) => {
      msgs.push({ role: 'model', text: pair.question });
      msgs.push({ role: 'user', text: pair.answer });
    });
    const avoid = interview.skipped.slice();
    if (interview.question) avoid.push(interview.question);
    if (avoid.length) {
      msgs.push({
        role: 'user',
        text:
          'Do not ask these questions or close variants. Ask one different question:\n' +
          avoid.map((q) => `- ${q}`).join('\n'),
      });
    }
    return msgs;
  }

  function messagesForGenerate() {
    const msgs = [];
    interview.answered.forEach((pair) => {
      msgs.push({ role: 'model', text: pair.question });
      msgs.push({ role: 'user', text: pair.answer });
    });
    if (interview.skipped.length) {
      msgs.push({
        role: 'user',
        text:
          'I skipped these questions. Do not invent answers for them:\n' +
          interview.skipped.map((q) => `- ${q}`).join('\n'),
      });
    }
    return msgs;
  }

  function renderInterview() {
    const logEl = el('gemini-copy-log');
    const qEl = el('gemini-copy-questions');
    const statusEl = el('gemini-copy-status');
    const sendBtn = el('gemini-copy-send');
    const skipBtn = el('gemini-copy-skip');
    const genBtn = el('gemini-copy-generate');
    const busy = interview.asking || interview.generating;

    if (logEl) {
      if (interview.answered.length === 0) {
        logEl.innerHTML = '';
        logEl.classList.add('hidden');
      } else {
        logEl.classList.remove('hidden');
        logEl.innerHTML = interview.answered
          .map(
            (pair) =>
              `<div class="mb-3 last:mb-0"><p class="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">${escapeHtml(pair.question)}</p><p class="text-sm text-slate-700 whitespace-pre-wrap">${escapeHtml(pair.answer)}</p></div>`
          )
          .join('');
      }
    }

    if (qEl) {
      if (interview.asking && !interview.question) {
        qEl.innerHTML = '<p class="text-sm text-slate-500">Reading the current draft…</p>';
      } else if (interview.question) {
        qEl.innerHTML = `<p class="text-sm font-medium text-slate-800">${escapeHtml(interview.question)}</p>`;
      } else {
        qEl.innerHTML =
          '<p class="text-sm text-slate-500">You can generate now to polish what is already there, or wait for a question.</p>';
      }
    }

    if (statusEl) {
      statusEl.textContent = interview.generating
        ? 'Writing the long description…'
        : interview.asking
          ? 'Asking a question…'
          : 'Answer, skip, or generate now. Close leaves the current text.';
    }
    if (sendBtn) sendBtn.disabled = busy;
    if (skipBtn) skipBtn.disabled = busy;
    if (genBtn) genBtn.disabled = interview.generating;
  }

  async function askQuestion() {
    interview.asking = true;
    renderInterview();
    try {
      const result = await postGemini('interview', messagesForAsk());
      if (!result) return;
      interview.question = result.question || '';
    } catch (err) {
      toast(err.message || 'Failed to get a follow-up question', 'error');
    } finally {
      interview.asking = false;
      renderInterview();
    }
  }

  async function openInterview() {
    if (!requireKey()) return;
    const longText = hooks.getLongText ? hooks.getLongText() : '';
    if (!longText) {
      toast('Write or paste a long description first', 'warning');
      return;
    }
    interview = emptyInterview();
    const modal = el('gemini-copy-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    const answers = el('gemini-copy-answers');
    if (answers) answers.value = '';
    renderInterview();
    await askQuestion();
  }

  function closeInterview() {
    const modal = el('gemini-copy-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    interview = emptyInterview();
  }

  async function sendAnswer() {
    if (!requireKey()) return;
    const text = (el('gemini-copy-answers')?.value || '').trim();
    if (!text) {
      toast('Add an answer before sending', 'warning');
      return;
    }
    interview.answered.push({
      question: interview.question || '(note)',
      answer: text,
    });
    interview.question = '';
    const answers = el('gemini-copy-answers');
    if (answers) answers.value = '';
    await askQuestion();
  }

  async function skipQuestion() {
    if (!requireKey()) return;
    if (interview.asking || interview.generating) return;
    if (interview.question) {
      interview.skipped.push(interview.question);
      interview.question = '';
    }
    const answers = el('gemini-copy-answers');
    if (answers) answers.value = '';
    await askQuestion();
  }

  async function generateLong() {
    if (!requireKey()) return;
    interview.generating = true;
    renderInterview();
    const btn = document.querySelector('.ql-ai-long');
    setButtonBusy(btn, true);
    try {
      const result = await postGemini('long', messagesForGenerate());
      if (!result) return;
      if (hooks.setLongHtml) hooks.setLongHtml(result.html);
      toast('Long description updated', 'success');
      closeInterview();
    } catch (err) {
      toast(err.message || 'Failed to generate long description', 'error');
    } finally {
      interview.generating = false;
      setButtonBusy(btn, false);
      if (isInterviewOpen()) renderInterview();
    }
  }

  function bindModal() {
    if (modalBound) return;
    modalBound = true;
    el('gemini-copy-close')?.addEventListener('click', closeInterview);
    el('gemini-copy-send')?.addEventListener('click', () => void sendAnswer());
    el('gemini-copy-skip')?.addEventListener('click', () => void skipQuestion());
    el('gemini-copy-generate')?.addEventListener('click', () => void generateLong());
    el('gemini-copy-modal')?.addEventListener('click', (e) => {
      if (e.target === el('gemini-copy-modal')) closeInterview();
    });
    el('gemini-copy-answers')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void sendAnswer();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isInterviewOpen() && !interview.generating) closeInterview();
    });
  }

  function init(nextHooks) {
    hooks = nextHooks || {};
    const shortBtn = document.querySelector('#description-editor')?.previousElementSibling?.querySelector('.ql-ai-short')
      || document.querySelector('button.ql-ai-short');
    const longBtn = document.querySelector('#longDescription-editor')?.previousElementSibling?.querySelector('.ql-ai-long')
      || document.querySelector('button.ql-ai-long');
    decorateButton(shortBtn, 'Generate short description from long');
    decorateButton(longBtn, 'Polish long description with AI');
    bindModal();
  }

  global.GeminiCopy = {
    init,
    generateShort,
    openInterview,
    closeInterview,
    sendAnswers: sendAnswer,
    skipQuestion,
    generateLong,
  };
})(window);
