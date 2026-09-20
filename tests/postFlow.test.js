// Regression: the create call MUST carry the post body (title etc.) merged with
// suppressGroupBroadcast — the 2026-09-20 UI shipped the flag WITHOUT the body,
// so every publish failed with the backend's "Invalid title".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostAndBroadcast } from '../frontend/src/api/postFlow.js';

test('create call merges the post body with suppressGroupBroadcast', async () => {
  const seen = [];
  const out = await createPostAndBroadcast({
    body: { title: 'Quiz on Monday', content: 'Bring calculators', pinned: true },
    create: async (b) => {
      seen.push(b);
      return { data: { _id: 'ann123' } };
    },
    files: [],
    parentType: 'announcement',
    api: { sign: async () => { throw new Error('sign must not be called'); }, confirm: async () => {} },
    broadcast: async (id) => {
      assert.equal(id, 'ann123', 'broadcast must get the created id');
      return { data: { sent: true } };
    },
  });

  assert.equal(seen.length, 1, 'exactly one create call');
  assert.deepEqual(seen[0], {
    title: 'Quiz on Monday',
    content: 'Bring calculators',
    pinned: true,
    suppressGroupBroadcast: true,
  });
  assert.equal(out.doc._id, 'ann123');
  assert.deepEqual(out.failed, []);
});

test('default body (omitted) still sends suppressGroupBroadcast', async () => {
  const seen = [];
  await createPostAndBroadcast({
    create: async (b) => { seen.push(b); return { data: { id: 'n1' } }; },
    files: [],
    parentType: 'note',
    api: { sign: async () => {}, confirm: async () => {} },
    broadcast: async () => ({}),
  });
  assert.deepEqual(seen[0], { suppressGroupBroadcast: true });
});
