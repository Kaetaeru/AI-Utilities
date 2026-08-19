const STORAGE_KEY = 'ui-blueprint.autosave.v0.1';

export function saveAutosave(document, activeScreenId) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ document, activeScreenId, savedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function loadAutosave() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearAutosave() {
  localStorage.removeItem(STORAGE_KEY);
}
