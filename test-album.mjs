// Album test with fake Durable Object: node test-album.mjs
import { handleUpdate, AlbumBuffer } from "./worker.js";
import assert from "node:assert";

const env = { ROUTES: "-1001=-1009", OWNER_ID: "42", BOT_TOKEN: "x" };
const calls = [];
const api = async (m, b) => (calls.push([m, b]), { ok: true });

// fake DO namespace
const objs = new Map();
function makeStorage() {
  const m = new Map(); let alarm = null;
  return {
    get: async (k) => structuredClone(m.get(k)),
    put: async (o) => { for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v)); },
    deleteAll: async () => m.clear(),
    setAlarm: async (t) => { alarm = t; },
    get alarmAt() { return alarm; },
  };
}
env.ALBUMS = {
  idFromName: (n) => n,
  get: (id) => {
    if (!objs.has(id)) { const o = new AlbumBuffer({ storage: makeStorage() }, env); o.api = api; objs.set(id, o); }
    const o = objs.get(id);
    return { fetch: (url, init) => o.fetch(new Request(url, init)) };
  },
};

// 3-photo album arriving out of order + a normal text
for (const id of [12, 11, 13]) {
  await handleUpdate({ message: { message_id: id, media_group_id: "A1", chat: { id: -1001, type: "supergroup" }, from: { id: 42 }, photo: [{}] } }, env, api);
}
assert.strictEqual(calls.length, 0, "album must be buffered, not sent yet");
assert.strictEqual(objs.size, 1);

await [...objs.values()][0].alarm();
assert.deepStrictEqual(calls.pop(), ["copyMessages", { chat_id: "-1009", from_chat_id: -1001, message_ids: [11, 12, 13] }]);

// stranger's album ignored
await handleUpdate({ message: { message_id: 20, media_group_id: "B", chat: { id: -1001, type: "supergroup" }, from: { id: 7 }, photo: [{}] } }, env, api);
assert.strictEqual(objs.size, 1);

console.log("album tests passed");
