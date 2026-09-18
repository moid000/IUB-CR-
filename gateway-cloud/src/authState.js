import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { WaStore } from './models.js';

/**
 * Baileys auth state backed by MongoDB — the key difference from the laptop
 * gateway. Cloud hosts have EPHEMERAL disks (every restart wipes files), so
 * the WhatsApp session (creds + keys) is serialized into the `wa_store`
 * collection. Result: QR scan survives every restart/rebuild/redeploy.
 */

export async function useMongoAuthState() {
  const readData = async (key) => {
    const doc = await WaStore.findById(key).lean();
    if (!doc) return null;
    return JSON.parse(doc.v, BufferJSON.reviver);
  };

  const writeData = async (key, data) => {
    if (data === undefined) return;
    const v = JSON.stringify(data, BufferJSON.replacer);
    await WaStore.findByIdAndUpdate(key, { $set: { v } }, { upsert: true });
  };

  const creds = (await readData('creds')) || initAuthCreds();
  const saveCreds = () => writeData('creds', creds);

  return {
    state: {
      creds,
      keys: {
        get: async (key, idx) => {
          const data = await readData(`key-${key}-${idx}`);
          return data ?? null;
        },
        set: async (key, idx, value) => {
          if (value === undefined || value === null) return;
          await writeData(`key-${key}-${idx}`, value);
        },
      },
    },
    saveCreds,
    clearAll: async () => {
      await WaStore.deleteMany({});
    },
  };
}
