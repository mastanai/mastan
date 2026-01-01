// board-sync (every 10 minutes): refresh workspace/board/snapshot.json from the Topic Board API.
// Without a writer token it keeps the read-only mirror snapshot (bin/push-board-mirror) and skips.
import {config} from '../config.js';
import {createBoardClient} from '../board/client.js';

export async function run({board = createBoardClient(config)} = {}) {
  if (!board.hasToken()) {
    const snap = board.snapshot();
    const kept = snap.source === 'mirror' ? `, mirror snapshot kept (${snap.items.length} items, mirror ${snap.synced_at})` : ', no snapshot yet';
    return {status: 'skipped', detail: `no token${kept}`};
  }
  const s = await board.sync();
  const needs = s.items.filter(i => i.needs_you && i.lane !== 'done').length;
  return {status: 'ok', detail: `${s.items.length} items, ${needs} need Owner`};
}
