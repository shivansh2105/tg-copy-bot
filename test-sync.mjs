// Edit-sync + /del test with fake Durable Objects: node test-sync.mjs
import { handleUpdate, AlbumBuffer, Store } from "./worker.js";
import assert from "node:assert";

const SRC = -1004396657933, DST = "-1001549839446";
const env = { ROUTES: `${SRC}=${DST}`, BOT_TOKEN: "x" };
const calls = [];
let nextId = 500;
const api = async (m, b) => {
  calls.push([m, b]);
  if (m === "copyMessage") return { ok: true, result: { message_id: nextId++ } };
  if (m === "copyMessages") return { ok: true, result: b.message_ids.map(() => ({ message_id: nextId++ })) };
  return { ok: true };
};

function makeStorage() {
  const m = new Map();
  return {
    get: async (k) => Array.isArray(k)
      ? new Map(k.filter((x) => m.has(x)).map((x) => [x, structuredClone(m.get(x))]))
      : structuredClone(m.get(k)),
    put: async (o) => { for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v)); },
    delete: async (ks) => ks.forEach((k) => m.delete(k)),
    deleteAll: async () => m.clear(),
    setAlarm: async () => {},
  };
}
function ns(Cls) {
  const objs = new Map();
  return {
    objs,
    idFromName: (n) => n,
    get: (id) => {
      if (!objs.has(id)) { const o = new Cls({ storage: makeStorage() }, env); o.api = api; objs.set(id, o); }
      const o = objs.get(id);
      return { fetch: (url, init) => o.fetch(new Request(url, init)) };
    },
  };
}
env.STORE = ns(Store);
env.ALBUMS = ns(AlbumBuffer);
const chan = { id: SRC, type: "channel" };

// 1. text post -> copied, mapping stored
await handleUpdate({ channel_post: { message_id: 10, chat: chan, text: "hello" } }, env, api);
assert.deepStrictEqual(calls.pop(), ["copyMessage", { chat_id: DST, from_chat_id: SRC, message_id: 10 }]); // copy id 500

// 2. edit text -> editMessageText on copy 500
await handleUpdate({ edited_channel_post: { message_id: 10, chat: chan, text: "hello v2", entities: [{ type: "bold", offset: 0, length: 5 }] } }, env, api);
let [m, b] = calls.pop();
assert.strictEqual(m, "editMessageText");
assert.deepStrictEqual([b.chat_id, b.message_id, b.text, b.entities[0].type], [DST, 500, "hello v2", "bold"]);

// 3. photo post then caption edit -> editMessageMedia
await handleUpdate({ channel_post: { message_id: 11, chat: chan, photo: [{ file_id: "s" }, { file_id: "BIG" }], caption: "a" } }, env, api); // copy 501
calls.pop();
await handleUpdate({ edited_channel_post: { message_id: 11, chat: chan, photo: [{ file_id: "s" }, { file_id: "BIG" }], caption: "b" } }, env, api);
[m, b] = calls.pop();
assert.strictEqual(m, "editMessageMedia");
assert.deepStrictEqual([b.message_id, b.media.type, b.media.media, b.media.caption], [501, "photo", "BIG", "b"]);

// 4. album 3 photos -> copyMessages, mapping per photo
for (const id of [21, 20, 22]) {
  await handleUpdate({ channel_post: { message_id: id, media_group_id: "G", chat: chan, photo: [{ file_id: "p" + id }] } }, env, api);
}
await [...env.ALBUMS.objs.values()][0].alarm(); // copies 502,503,504
assert.deepStrictEqual(calls.pop()[1].message_ids, [20, 21, 22]);

// 5. /del reply to album item 21 -> deletes all 3 copies + originals + command
await handleUpdate({ channel_post: { message_id: 30, chat: chan, text: "/del", reply_to_message: { message_id: 21 } } }, env, api);
const dels = calls.splice(0);
assert.deepStrictEqual(dels[0], ["deleteMessages", { chat_id: DST, message_ids: [502, 503, 504] }]);
assert.deepStrictEqual(dels[1], ["deleteMessages", { chat_id: SRC, message_ids: [20, 21, 22, 30] }]);

// 6. /del with a post link
await handleUpdate({ channel_post: { message_id: 31, chat: chan, text: "/del https://t.me/c/4396657933/10" } }, env, api);
assert.deepStrictEqual(calls[0], ["deleteMessages", { chat_id: DST, message_ids: [500] }]);
assert.deepStrictEqual(calls[1], ["deleteMessages", { chat_id: SRC, message_ids: [10, 31] }]);
calls.length = 0;

// 7. edit after delete -> nothing happens; /del is never copied
await handleUpdate({ edited_channel_post: { message_id: 10, chat: chan, text: "x" } }, env, api);
assert.strictEqual(calls.length, 0);

console.log("sync tests passed");
