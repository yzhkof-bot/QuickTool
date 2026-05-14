const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let cache = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  try {
    const txt = fs.readFileSync(settingsFile(), 'utf8');
    cache = JSON.parse(txt) || {};
  } catch (_) {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(cache || {}, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function get(key, fallback) {
  const all = load();
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
}

function set(key, value) {
  const all = load();
  if (value === null || value === undefined || value === '') delete all[key];
  else all[key] = value;
  cache = all;
  return save();
}

module.exports = { get, set, load, settingsFile };
