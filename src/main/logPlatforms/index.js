const android = require('./android');
const harmony = require('./harmony');

const platforms = {
  [android.meta.id]: android,
  [harmony.meta.id]: harmony,
};

const order = [android.meta.id, harmony.meta.id];

function get(id) {
  return platforms[id] || platforms[android.meta.id];
}

function listMeta() {
  return order.map((id) => ({ ...platforms[id].meta }));
}

function stopAllStreams() {
  for (const id of order) {
    try { platforms[id].stopStream(); } catch (_) { /* ignore */ }
  }
}

module.exports = { get, listMeta, stopAllStreams };
