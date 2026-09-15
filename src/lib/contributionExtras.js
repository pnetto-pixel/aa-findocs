// Decide whether the Redis snapshot should repair contribution extras that are
// missing from localStorage. An explicitly persisted empty array is a user
// choice (for example, after deleting the last extra) and must never be
// mistaken for missing storage.
export function extrasFromSnapshotForRestore({ extrasWerePersisted, snapshotExtras }) {
  if (extrasWerePersisted || !Array.isArray(snapshotExtras) || snapshotExtras.length === 0) {
    return null;
  }

  return snapshotExtras.map((extra) => ({
    label: extra?.name ?? "",
    value: extra?.amount != null ? String(extra.amount) : "",
  }));
}

