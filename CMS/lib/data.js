const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function readJSON(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return filename === 'projects.json' ? [] : {};
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJSON(filename, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function normalizeOrder(projects) {
  let changed = false;
  const byCategory = {};
  projects.forEach(p => {
    (byCategory[p.category] = byCategory[p.category] || []).push(p);
  });

  Object.values(byCategory).forEach(group => {
    const withoutOrder = group.filter(p => typeof p.order !== 'number');
    if (withoutOrder.length === 0) return;

    changed = true;
    const withOrder = group.filter(p => typeof p.order === 'number');
    let next = withOrder.length ? Math.max(...withOrder.map(p => p.order)) + 1 : 0;

    withoutOrder.sort((a, b) => {
      const dateA = a.timestamp ? new Date(a.timestamp) : new Date(0);
      const dateB = b.timestamp ? new Date(b.timestamp) : new Date(0);
      return dateB - dateA;
    });
    withoutOrder.forEach(p => { p.order = next++; });
  });

  return changed;
}

function getProjects() {
  const projects = readJSON('projects.json');
  if (normalizeOrder(projects)) {
    writeJSON('projects.json', projects);
  }
  return projects;
}

function getSettings() {
  return readJSON('settings.json');
}

const SKILL_KEYS = ['skills_hardware','skills_lighting','skills_software','skills_fabrication','skills_systems'];

const CATEGORY_TO_SKILL_KEY = {
  Lighting:    'skills_lighting',
  Sculpture:   'skills_fabrication',
  Fixtures:    'skills_hardware',
  Software:    'skills_software',
  Tooling:     'skills_fabrication',
  Systems:     'skills_systems',
  Art:         'skills_fabrication',
  Circuits:    'skills_hardware',
  Apps:        'skills_software',
  Solutions:   'skills_fabrication',
  Integration: 'skills_systems'
};

function parseSkillsCSV(str) {
  return (str || '').split(',').map(s => s.trim()).filter(Boolean);
}

function allSkillsSet(settings) {
  const set = new Set();
  SKILL_KEYS.forEach(k => parseSkillsCSV(settings[k]).forEach(s => set.add(s)));
  return set;
}

function saveProject(project) {
  const projects = getProjects();

  if (project.featured === true) {
    projects.forEach(p => {
      if (p.category === project.category && String(p.id) !== String(project.id)) {
        p.featured = false;
      }
    });
  }

  if (!project.timestamp) {
    project.timestamp = new Date().toISOString();
  }

  if (!project.id) {
    project.id = Math.floor(Math.random() * 10000);
  }

  const existingIndex = projects.findIndex(p => String(p.id) === String(project.id));
  if (existingIndex !== -1) {
    const existing = projects[existingIndex];
    if (project.category !== existing.category) {
      projects.forEach(p => {
        if (p.category === project.category && String(p.id) !== String(project.id)) {
          p.order = (p.order ?? 0) + 1;
        }
      });
      project.order = 0;
    } else {
      project.order = existing.order;
    }
    projects[existingIndex] = { ...existing, ...project, order: project.order };
  } else {
    projects.forEach(p => {
      if (p.category === project.category) {
        p.order = (p.order ?? 0) + 1;
      }
    });
    project.order = 0;
    projects.push(project);
  }

  writeJSON('projects.json', projects);

  // Auto-add new tags to the corresponding skills group
  const tags = Array.isArray(project.tags) ? project.tags : [];
  if (tags.length > 0) {
    const settings = getSettings();
    const existing = allSkillsSet(settings);
    const targetKey = CATEGORY_TO_SKILL_KEY[project.category] || 'skills_fabrication';
    let added = false;

    tags.forEach(tag => {
      if (!existing.has(tag)) {
        const current = parseSkillsCSV(settings[targetKey]);
        current.push(tag);
        settings[targetKey] = current.join(', ');
        existing.add(tag);
        added = true;
      }
    });

    if (added) writeJSON('settings.json', settings);
  }

  return { success: true, project };
}

function reorderProjects(items) {
  const projects = getProjects();
  const counters = {};
  (items || []).forEach(({ id, category }) => {
    const p = projects.find(pr => String(pr.id) === String(id));
    if (!p) return;
    p.category = category;
    counters[category] = (counters[category] || 0);
    p.order = counters[category]++;
  });
  writeJSON('projects.json', projects);
  return { success: true };
}

function deleteProject(id) {
  let projects = getProjects();
  projects = projects.filter(p => String(p.id) !== String(id));
  writeJSON('projects.json', projects);
  return { success: true };
}

function saveSettings(newSettings) {
  const oldSettings = getSettings();
  const oldSkills = allSkillsSet(oldSettings);
  const newSkills = allSkillsSet(newSettings);

  // Find skills that were removed
  const removed = new Set();
  oldSkills.forEach(s => { if (!newSkills.has(s)) removed.add(s); });

  // Cascade-delete removed skills from all project tags
  if (removed.size > 0) {
    const projects = getProjects();
    let changed = false;
    projects.forEach(p => {
      if (!Array.isArray(p.tags) || p.tags.length === 0) return;
      const filtered = p.tags.filter(t => !removed.has(t));
      if (filtered.length !== p.tags.length) {
        p.tags = filtered;
        changed = true;
      }
    });
    if (changed) writeJSON('projects.json', projects);
  }

  writeJSON('settings.json', newSettings);
  return { success: true };
}

module.exports = { getProjects, getSettings, saveProject, deleteProject, saveSettings, reorderProjects };
