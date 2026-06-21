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

function saveSettings(settings) {
  writeJSON('settings.json', settings);
  return { success: true };
}

module.exports = { getProjects, getSettings, saveProject, deleteProject, saveSettings, reorderProjects };
