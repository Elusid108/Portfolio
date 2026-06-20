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

function getProjects() {
  return readJSON('projects.json');
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
    projects[existingIndex] = project;
  } else {
    projects.push(project);
  }

  writeJSON('projects.json', projects);
  return { success: true, project };
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

module.exports = { getProjects, getSettings, saveProject, deleteProject, saveSettings };
