import { toRaw } from 'vue';

// Snapshots are JSON data. Read the underlying current value, not a cached
// signature: local optimistic edits must still participate in every comparison.
export function sameSnapshotField(current, incoming) {
  return JSON.stringify(toRaw(current)) === JSON.stringify(toRaw(incoming));
}
