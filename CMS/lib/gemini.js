const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const WRITING_GUIDE_PATH = path.join(PROMPTS_DIR, 'writing-guide.md');
const SPUTNIK_PATH = path.join(PROMPTS_DIR, 'sputnik.txt');

const TASKS = new Set(['short', 'interview', 'long']);

function sanitizeModelId(modelId) {
  const raw = String(modelId || '').trim().replace(/^models\//, '');
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '');
  return cleaned || 'gemini-2.5-flash';
}

function loadVoiceFiles() {
  if (!fs.existsSync(WRITING_GUIDE_PATH)) {
    const err = new Error('Missing CMS/prompts/writing-guide.md');
    err.status = 500;
    throw err;
  }
  if (!fs.existsSync(SPUTNIK_PATH)) {
    const err = new Error('Missing CMS/prompts/sputnik.txt. Copy your Sputnik voice file into CMS/prompts/sputnik.txt.');
    err.status = 400;
    throw err;
  }
  const guide = fs.readFileSync(WRITING_GUIDE_PATH, 'utf8');
  const sputnik = fs.readFileSync(SPUTNIK_PATH, 'utf8');
  return { guide, sputnik };
}

function buildSystemInstruction(task) {
  const { guide, sputnik } = loadVoiceFiles();
  return [
    guide.trim(),
    '',
    '## Current task',
    `You are performing the "${task}" task. Follow the output JSON for that task exactly.`,
    '',
    '## Sputnik (voice sample only)',
    sputnik.trim(),
  ].join('\n');
}

function projectBlock(project = {}) {
  const specs = project.specs ? String(project.specs).trim() : '';
  return [
    `Title: ${project.title || '(untitled)'}`,
    `Category: ${project.category || '(none)'}`,
    `Tags: ${Array.isArray(project.tags) ? project.tags.join(', ') : (project.tags || '(none)')}`,
    specs ? `Specifications (do not dump these unless a number is the story):\n${specs}` : 'Specifications: (none)',
    '',
    'Current short description:',
    (project.short || '(empty)').trim(),
    '',
    'Current long description:',
    (project.long || '(empty)').trim(),
  ].join('\n');
}

function userPromptForTask(task, project, messages) {
  const context = projectBlock(project);
  if (task === 'short') {
    return [
      context,
      '',
      'Write the short grid tile from the long description and project context. JSON: { "text": "..." }',
    ].join('\n');
  }
  if (task === 'interview') {
    const transcript = formatMessages(messages);
    return [
      context,
      transcript ? `\nQ&A so far:\n${transcript}` : '',
      '',
      'Ask exactly one question that would actually improve this draft. Not a list. If he already answered or skipped something, do not ask it again. JSON: { "question": "..." }',
    ].join('\n');
  }
  const transcript = formatMessages(messages);
  return [
    context,
    transcript ? `\nQ&A so far:\n${transcript}` : '\nNo extra answers. Polish the current long description. Do not invent facts.',
    '',
    'Write the long project body. JSON: { "html": "<p>...</p>" }',
  ].join('\n');
}

function formatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  return messages.map((m) => {
    const role = m.role === 'model' ? 'Assistant' : 'Chris';
    return `${role}: ${String(m.text || '').trim()}`;
  }).filter((line) => !line.endsWith(':')).join('\n\n');
}

function stripFences(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function parseJsonOutput(text, task) {
  const raw = stripFences(text);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const err = new Error('Gemini did not return valid JSON');
    err.status = 502;
    throw err;
  }

  if (task === 'short') {
    const value = String(data.text || '').replace(/\u2014/g, ',').trim();
    if (!value) {
      const err = new Error('Gemini returned an empty short description');
      err.status = 502;
      throw err;
    }
    return { text: value };
  }
  if (task === 'interview') {
    const fromArray = Array.isArray(data.questions)
      ? data.questions.map((q) => String(q || '').trim()).filter(Boolean)[0]
      : '';
    const question = String(data.question || fromArray || '').trim();
    if (!question) {
      const err = new Error('Gemini returned no interview question');
      err.status = 502;
      throw err;
    }
    return { question };
  }
  const html = sanitizeLongHtml(data.html);
  if (!html) {
    const err = new Error('Gemini returned an empty long description');
    err.status = 502;
    throw err;
  }
  return { html };
}

function sanitizeLongHtml(html) {
  const raw = String(html || '').replace(/\u2014/g, ',').trim();
  if (!raw) return '';
  const paragraphs = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match;
  while ((match = re.exec(raw))) {
    const inner = match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (inner) paragraphs.push(`<p>${inner}</p>`);
  }
  if (paragraphs.length) return paragraphs.join('');
  const text = raw.replace(/<[^>]+>/g, '').trim();
  if (!text) return '';
  return text.split(/\n\n+/).map((p) => `<p>${p.replace(/\s+/g, ' ').trim()}</p>`).filter((p) => p !== '<p></p>').join('');
}

async function callGemini({ apiKey, modelId, systemInstruction, userPrompt, temperature }) {
  const model = sanitizeModelId(modelId);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    const err = new Error(`Gemini returned a non-JSON response (HTTP ${response.status})`);
    err.status = 502;
    throw err;
  }

  if (!response.ok || data.error) {
    const message = data.error?.message || `Gemini HTTP ${response.status}`;
    const err = new Error(message);
    err.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw err;
  }

  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) {
    const err = new Error('No text returned from Gemini');
    err.status = 502;
    throw err;
  }
  return text;
}

async function runTask(body) {
  const task = String(body.task || '').trim();
  if (!TASKS.has(task)) {
    const err = new Error('task must be short, interview, or long');
    err.status = 400;
    throw err;
  }
  const apiKey = String(body.apiKey || '').trim();
  if (!apiKey) {
    const err = new Error('API key is required');
    err.status = 400;
    throw err;
  }

  const temperature = task === 'short' ? 0.4 : task === 'interview' ? 0.5 : 0.7;
  const systemInstruction = buildSystemInstruction(task);
  const userPrompt = userPromptForTask(task, body.project || {}, body.messages || []);
  const raw = await callGemini({
    apiKey,
    modelId: body.modelId,
    systemInstruction,
    userPrompt,
    temperature,
  });
  return parseJsonOutput(raw, task);
}

module.exports = { runTask };
