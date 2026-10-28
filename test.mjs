// Local test with a fake Telegram API: node test.mjs
import worker, { handleUpdate, parseRoutes } from "./worker.js";
import assert from "node:assert";

const calls = [];
const api = async (m, b) => (calls.push([m, b]), { ok: true });
const env = { ROUTES: "-1001=-1009, -1002=-1009", OWNER_ID: "42", WEBHOOK_SECRET: "s3cret", BOT_TOKEN: "x" };

assert.deepStrictEqual(parseRoutes(env.ROUTES), { "-1001": ["-1009"], "-1002": ["-1009"] });

// owner post in group 1 -> copied
await handleUpdate({ message: { message_id: 5, chat: { id: -1001, type: "supergroup" }, from: { id: 42 }, text: "hi" } }, env, api);
assert.deepStrictEqual(calls.pop(), ["copyMessage", { chat_id: "-1009", from_chat_id: -1001, message_id: 5 }]);

// photo from group 2 -> copied
await handleUpdate({ message: { message_id: 6, chat: { id: -1002, type: "supergroup" }, from: { id: 42 }, photo: [{}] } }, env, api);
assert.strictEqual(calls.pop()[1].from_chat_id, -1002);

// stranger -> ignored
await handleUpdate({ message: { message_id: 7, chat: { id: -1001, type: "supergroup" }, from: { id: 99 }, text: "spam" } }, env, api);
assert.strictEqual(calls.length, 0);

// anonymous admin -> copied
await handleUpdate({ message: { message_id: 8, chat: { id: -1001, type: "supergroup" }, from: { id: 1087968824 }, sender_chat: { id: -1001 }, text: "anon" } }, env, api);
assert.strictEqual(calls.pop()[0], "copyMessage");

// unknown chat -> ignored
await handleUpdate({ message: { message_id: 9, chat: { id: -1005, type: "group" }, from: { id: 42 }, text: "x" } }, env, api);
assert.strictEqual(calls.length, 0);

// /id -> reply
await handleUpdate({ message: { message_id: 10, chat: { id: -1005, type: "group" }, from: { id: 42 }, text: "/id@MyBot" } }, env, api);
assert.match(calls.pop()[1].text, /Chat ID: -1005/);

// forwarded channel post in private chat -> replies with channel ID
await handleUpdate({ message: { message_id: 11, chat: { id: 42, type: "private" }, from: { id: 42 }, forward_origin: { type: "channel", chat: { id: -1007, title: "News" } } } }, env, api);
assert.match(calls.pop()[1].text, /"News" ID: -1007/);

// webhook rejects wrong secret
const bad = await worker.fetch(new Request("https://w.dev/webhook", { method: "POST", body: "{}" }), env, { waitUntil() {} });
assert.strictEqual(bad.status, 403);

console.log("all tests passed");
