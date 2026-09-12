const fs = require('fs');
const path = require('path');
const { getProjects } = require('./data');

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

function relatedNames(project = {}) {
  const raw = project.related;
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (typeof item === 'string') return item.trim();
      return String(item && item.name ? item.name : '').trim();
    }).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function parseProjectHash(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith('#project/')) return null;
  try { return decodeURIComponent(trimmed.slice('#project/'.length)); }
  catch { return trimmed.slice('#project/'.length); }
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function firstSentence(value) {
  const text = stripHtml(value);
  if (!text) return '';
  const match = text.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = (match ? match[1] : text).trim();
  return sentence.length > 240 ? `${sentence.slice(0, 237).trim()}...` : sentence;
}

function relatedEntries(project = {}) {
  const raw = project.related;
  if (!Array.isArray(raw)) {
    return relatedNames(project).map((name) => ({ name, url: '' }));
  }
  return raw.map((item) => {
    if (typeof item === 'string') return { name: item.trim(), url: '' };
    return {
      name: String(item && item.name ? item.name : '').trim(),
      url: String(item && item.url ? item.url : '').trim(),
    };
  }).filter((item) => item.name || item.url);
}

function siblingCopyLines(project = {}) {
  const entries = relatedEntries(project);
  if (!entries.length) return [];

  let catalog = [];
  try {
    catalog = getProjects() || [];
  } catch {
    catalog = [];
  }

  const selfId = project && project.id != null ? String(project.id) : '';
  return entries.map((entry) => {
    const id = parseProjectHash(entry.url);
    let sibling = id && String(id) !== selfId
      ? catalog.find((p) => String(p.id) === String(id))
      : null;
    if (!sibling && entry.name) {
      const needle = entry.name.toLowerCase();
      sibling = catalog.find((p) => String(p.id) !== selfId && String(p.title || '').trim().toLowerCase() === needle) || null;
    }
    if (!sibling) {
      const label = entry.name || entry.url || '(unnamed related)';
      return `- ${label}: unresolved or external. Do not invent its story.`;
    }
    const title = sibling.title || entry.name || '(untitled)';
    const short = stripHtml(sibling.short || sibling.description);
    const opens = firstSentence(sibling.long || sibling.longDescription);
    if (short && opens) return `- ${title}: ${short} Opens: ${opens}`;
    if (short) return `- ${title}: ${short}`;
    if (opens) return `- ${title}: Opens: ${opens}`;
    return `- ${title}: (no copy yet)`;
  });
}

function categoryBankName(category) {
  const raw = String(category || '').trim();
  if (/^sculpture$/i.test(raw)) return 'Art';
  return raw || '(none)';
}

function isLighting(project = {}) {
  return /^lighting$/i.test(String(project.category || '').trim());
}

function categorySteer(task, project = {}) {
  const bank = categoryBankName(project.category);
  const hasRelated = relatedNames(project).length > 0;
  const lighting = isLighting(project);

  if (task === 'interview') {
    const parts = [
      `Use the Category interview bank for ${bank}. Sculpture uses Art. If this category has no bank, use the shared interview rules only and do not invent a bank.`,
    ];
    if (hasRelated) {
      parts.push('Related pages are listed below with their opening lines. Decide hub vs satellite from those titles: a hub is the whole room or rig; a satellite is one layer, fixture, or subsystem. Ask about this page. Do not retell a sibling. Do not steal a sibling\'s rule or closer.');
    }
    if (lighting && hasRelated) {
      parts.push('Lighting with Related links: if this is a layer or subsystem, do not ask what rule he refused to break. Ask what this layer covers that the room page does not, or what the drawings got wrong.');
    }
    return parts.join(' ');
  }

  const parts = [
    `Write the long body using the Category shape for ${bank}. Sculpture uses Art. If this category has no bank, use the shared long rules only and do not invent a shape.`,
  ];
  if (hasRelated) {
    parts.push('Related pages are listed below with their opening lines. Already told: do not retell. Do not steal a rule, phrase, or closer from them. Decide hub vs satellite from the titles: a hub is the whole room or rig; a satellite is one layer, fixture, or subsystem. A hub may write the room look and its own rule if that rule is in this draft. A satellite must not invent a design rule or end on what the whole room did.');
  }
  if (lighting && hasRelated) {
    parts.push('If this Lighting page is a layer or subsystem, open on what the layer is. Keep layout numbers from the draft (counts, pods, universes, service size). At most one install snag. Layout, power, and data are not snags. If this page is the room, open on the look or the rule only if that rule is in the draft.');
  } else if (lighting) {
    parts.push('Lighting hub: open on the look or the rule only if that rule is in the draft. Do not invent a rule to satisfy the shape.');
  }
  return parts.join(' ');
}

function projectBlock(project = {}) {
  const specs = project.specs ? String(project.specs).trim() : '';
  const related = relatedNames(project);
  const siblings = siblingCopyLines(project);
  const lines = [
    `Title: ${project.title || '(untitled)'}`,
    `Category: ${project.category || '(none)'}`,
    `Tags: ${Array.isArray(project.tags) ? project.tags.join(', ') : (project.tags || '(none)')}`,
    related.length ? `Related: ${related.join(', ')}` : 'Related: (none)',
  ];
  if (siblings.length) {
    lines.push('Related pages already on the site (already told; do not retell; do not steal a rule, phrase, or closer):');
    lines.push(...siblings);
  }
  lines.push(
    specs ? `Specifications (do not dump these unless a number is the story):\n${specs}` : 'Specifications: (none)',
    '',
    'Current short description:',
    (project.short || '(empty)').trim(),
    '',
    'Current long description:',
    (project.long || '(empty)').trim(),
  );
  return lines.join('\n');
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
      categorySteer('interview', project),
      'Ask exactly one question that would actually improve this draft. Not a list. If he already answered or skipped something, do not ask it again. JSON: { "question": "..." }',
    ].join('\n');
  }
  const transcript = formatMessages(messages);
  return [
    context,
    transcript ? `\nQ&A so far:\n${transcript}` : '\nNo extra answers. Polish the current long description. Do not invent facts.',
    '',
    categorySteer('long', project),
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

  const temperature = task === 'short' ? 0.4 : task === 'interview' ? 0.5 : 0.45;
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
