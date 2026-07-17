const LEGACY_PAT_STORAGE_KEY = 'github_pat';

/** Remove credentials persisted by older GitShelf builds before any route loads. */
export function clearLegacyCredentials() {
  for (const storageName of ['sessionStorage', 'localStorage']) {
    try {
      globalThis[storageName]?.removeItem(LEGACY_PAT_STORAGE_KEY);
    } catch {
      // Storage can be disabled by browser privacy settings; no credential is writable then.
    }
  }
}
