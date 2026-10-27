// Everything is kept on the tablet: scripts and edits in IndexedDB, the video file too, settings in localStorage.

const DB_NAME = 'vo-prompter';
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('videos')) d.createObjectStore('videos', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
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
  return (all || []).map((p) => ({ id: p.id, name: p.name, updated: p.updated, hasVideo: !!p.videoName, videoName: p.videoName }))
    .sort((a, b) => b.updated - a.updated);
}
export const getProject = (id) => tx('projects', 'readonly', (s) => req(s.get(id)));
export const putProject = (p) => tx('projects', 'readwrite', (s) => { s.put(p); });
export async function deleteProject(id) {
  await tx('projects', 'readwrite', (s) => { s.delete(id); });
  await tx('videos', 'readwrite', (s) => { s.delete(id); });
}
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
