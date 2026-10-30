// Everything is kept on the tablet: scripts and edits in IndexedDB, the video file too, settings in localStorage.

const DB_NAME = 'vo-prompter';
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('videos')) d.createObjectStore('videos', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('vo')) d.createObjectStore('vo', { keyPath: 'id' }); // your voice-over recordings (version 2)
      };
      r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbp = null; }; resolve(d); };
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export async function listProjects() {
  const all = await tx('projects', 'readonly', (s) => req(s.getAll()));
  return (all || []).map((p) => ({ id: p.id, name: p.name, fileName: p.fileName, updated: p.updated, opened: p.opened || p.updated, hasVideo: !!p.videoName, videoName: p.videoName,
    progress: p.progress, bm: (p.bm || []).length, hl: (p.hl || []).length }))
    .sort((a, b) => b.opened - a.opened);
}
// how many voice-over recordings each project has
export async function voCounts() {
  const out = new Map();
  await tx('vo', 'readonly', (s) => new Promise((resolve) => {
    const r = s.openCursor();
    r.onsuccess = () => { const c = r.result; if (!c) { resolve(); return; } const id = c.value.projectId; out.set(id, (out.get(id) || 0) + 1); c.continue(); };
    r.onerror = () => resolve();
  }));
  return out;
}
export const getProject = (id) => tx('projects', 'readonly', (s) => req(s.get(id)));
export const putProject = (p) => tx('projects', 'readwrite', (s) => { s.put(p); });
export async function deleteProject(id) {
  await tx('projects', 'readwrite', (s) => { s.delete(id); });
  await tx('videos', 'readwrite', (s) => { s.delete(id); });
  for (const v of await listVo(id)) await deleteVo(v.id);
}
// Voice-over recordings: { id, projectId, name, added, duration, blob, map: [unit, start, end, ...] }
export async function listVo(projectId) {
  const all = await tx('vo', 'readonly', (s) => req(s.getAll()));
  return (all || []).filter((v) => v.projectId === projectId).sort((a, b) => a.added - b.added);
}
export const putVo = (v) => tx('vo', 'readwrite', (s) => { s.put(v); });
export const deleteVo = (id) => tx('vo', 'readwrite', (s) => { s.delete(id); });
export const putVideo = (id, file) => tx('videos', 'readwrite', (s) => { s.put({ id, name: file.name, type: file.type, blob: file }); });
export const getVideo = (id) => tx('videos', 'readonly', (s) => req(s.get(id)));
export const deleteVideo = (id) => tx('videos', 'readwrite', (s) => { s.delete(id); });

export async function wipeAll() {
  try { const d = await dbp; if (d) d.close(); } catch (e) { /* ignore */ }
  dbp = null;
  await new Promise((resolve) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
}

const SETTINGS_KEY = 'vo-prompter-settings';
export function loadSettings(defaults) {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch (e) { return { ...defaults }; }
}
export function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ } }
