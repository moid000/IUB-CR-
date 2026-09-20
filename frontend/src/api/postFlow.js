import { uploadToCloudinary } from './upload.js';

/**
 * Combined one-shot publish flow (owner request 2026-09-20):
 * 1. create the post with suppressGroupBroadcast — NO group message yet
 * 2. upload every staged file (secure sign → Cloudinary → confirm)
 * 3. fire the explicit broadcast endpoint ONCE — the group receives the text
 *    AND all attachments together in a single burst.
 * Upload failures never block the broadcast — whatever succeeded goes out,
 * and the failed files can still be attached later via "Manage attachments"
 * (they auto-send to the group once the post has been broadcast).
 */
export async function createPostAndBroadcast({
  create, // (body) => api response with .data = created doc
  files = [],
  parentType,
  api, // { sign, confirm } — crApi.files
  broadcast, // (id) => api response
  onProgress, // optional (done, total)
}) {
  const res = await create({ suppressGroupBroadcast: true });
  const doc = res?.data ?? res;
  const id = doc?._id ?? doc?.id;
  if (!id) throw new Error('The post was created but its id is missing — files were not attached.');

  const failed = [];
  let done = 0;
  for (const f of files) {
    try {
      const sign = (await api.sign({
        parentType, parentId: id,
        file: { originalName: f.name, mimeType: f.type },
      }))?.data;
      const result = await uploadToCloudinary(sign, f);
      await api.confirm({ parentType, parentId: id, result });
    } catch {
      failed.push(f.name);
    }
    done += 1;
    onProgress?.(done, files.length);
  }

  await broadcast(id); // combined text + all confirmed attachments, one burst
  return { doc, failed };
}
