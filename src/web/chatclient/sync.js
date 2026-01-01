// A response snapshot may race live events. Changes received after the request began win.
export function mergeSnapshot(snapshot, cached, versions, requestedAt) {
  const rows = new Map(snapshot.map(message => [message.id, message]));
  const latest = snapshot.at(-1)?.id || 0;
  for (const message of cached) if ((versions.get(message.id) || 0) > requestedAt || !rows.has(message.id) && message.id > latest) rows.set(message.id, message);
  return [...rows.values()].sort((a, b) => a.id - b.id);
}
