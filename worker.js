// Telegram "copy without sender" bot for Cloudflare Workers (free plan).
//
// - Copies every post from source chats to destination chats with copyMessage,
//   so there is NO "Forwarded from <name>" header.
// - Albums are buffered for a moment (Durable Object) and sent as one album.
// - Edits in the source are mirrored to the copy.
// - Reply "/del" to a source post (or "/del <post link>") -> deletes the copy,
//   the original and the /del message.
//
// Secrets (npx wrangler secret put NAME):
//   BOT_TOKEN       token from @BotFather
//   WEBHOOK_SECRET  random string, letters/digits/_/- only
//   ROUTES          source=destination pairs, comma separated
//                   e.g. -1001111111111=-1009999999999,-1002222222222=-1009999999999
//   OWNER_ID        (optional) your Telegram user id(s), comma separated. In groups,
//                   only posts from these users (or anonymous admins) are copied.

const TG = "https://api.telegram.org/bot";
const ALBUM_WAIT_MS = 2000;
const EDITABLE_MEDIA = ["photo", "video", "animation", "document", "audio"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const api = makeApi(env.BOT_TOKEN);

    // One-time: open https://<your-worker>.workers.dev/setup?key=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) {
        return new Response("Set BOT_TOKEN and WEBHOOK_SECRET first.", { status: 500 });
      }
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("Wrong key", { status: 403 });
      }
      const res = await api("setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post"],
        drop_pending_updates: true,
      });
      return Response.json(res);
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env, api).catch((e) => console.log("error", e)));
      return new Response("ok");
    }

    return new Response("Telegram copy bot is running.");
  },
};

export function makeApi(token) {
  return async (method, body) => {
    const r = await fetch(`${TG}${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) console.log(method, "failed:", j.description);
    return j;
  };
}

export function parseRoutes(str = "") {
  const routes = {};
  for (const pair of str.split(/[,\n;]+/)) {
    const [src, dst] = pair.split("=").map((s) => (s || "").trim());
    if (!src || !dst) continue;
    (routes[src] ||= []).push(dst);
  }
  return routes;
}

export async function handleUpdate(update, env, api) {
  const edited = update.edited_message || update.edited_channel_post;
  const msg = update.message || update.channel_post || edited;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();

  // /id -> tells you the chat id and your user id (works even before ROUTES is set)
  if (!edited && /^\/id(@\w+)?$/i.test(text)) {
    await api("sendMessage", {
      chat_id: msg.chat.id,
      text: `Chat ID: ${chatId}\nYour user ID: ${msg.from ? msg.from.id : "n/a (channel)"}`,
    });
    return;
  }

  // Forward any channel post to the bot in private chat -> it replies with that
  // channel's ID (no need to post /id in the channel).
  if (msg.chat.type === "private") {
    const origin = msg.forward_origin;
    const fwdChat = (origin && (origin.chat || origin.sender_chat)) || msg.forward_from_chat;
    if (fwdChat && !edited) {
      await api("sendMessage", {
        chat_id: msg.chat.id,
        text: `"${fwdChat.title || "chat"}" ID: ${fwdChat.id}`,
      });
    }
    return;
  }

  const dests = parseRoutes(env.ROUTES)[chatId];
  if (!dests) return; // not a source chat

  // Only copy posts from the owner(s), if configured
  if (env.OWNER_ID && msg.chat.type !== "channel") {
    const owners = env.OWNER_ID.split(",").map((s) => s.trim());
    const fromOwner = msg.from && owners.includes(String(msg.from.id));
    const anonAdmin = msg.sender_chat && String(msg.sender_chat.id) === chatId;
    if (!fromOwner && !anonAdmin) return;
  }

  if (edited) return syncEdit(msg, env, api);

  const del = text.match(/^\/del(?:@\w+)?(?:\s+(\S+))?$/i);
  if (del) return deleteCopies(msg, del[1], env, api);

  if (text.startsWith("/")) return; // don't copy other bot commands

  // Album: Telegram sends each photo separately. Collect them in a Durable
  // Object for ALBUM_WAIT_MS, then copy them together so they stay one album.
  if (msg.media_group_id && env.ALBUMS) {
    const key = `${chatId}:${msg.media_group_id}`;
    const stub = env.ALBUMS.get(env.ALBUMS.idFromName(key));
    await stub.fetch("https://album/add", {
      method: "POST",
      body: JSON.stringify({ chatId, messageId: msg.message_id }),
    });
    return;
  }

  const copies = [];
  for (const dest of dests) {
    const res = await api("copyMessage", {
      chat_id: dest,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    });
    if (res.ok && res.result) copies.push({ chat: dest, id: res.result.message_id });
  }
  if (copies.length && env.STORE) {
    await store(env, chatId).put({ [`m:${msg.message_id}`]: copies });
  }
}

// Source post was edited -> edit the copies the same way.
async function syncEdit(msg, env, api) {
  if (!env.STORE) return;
  const key = `m:${msg.message_id}`;
  const copies = (await store(env, String(msg.chat.id)).get([key]))[key];
  if (!copies) return;
  const mediaType = EDITABLE_MEDIA.find((t) => msg[t]);

  for (const c of copies) {
    const target = { chat_id: c.chat, message_id: c.id };
    if (msg.text !== undefined) {
      await api("editMessageText", {
        ...target,
        text: msg.text,
        entities: msg.entities,
        link_preview_options: msg.link_preview_options,
      });
    } else if (mediaType) {
      // covers both "caption changed" and "photo/video replaced"
      const m = msg[mediaType];
      const fileId = Array.isArray(m) ? m[m.length - 1].file_id : m.file_id;
      await api("editMessageMedia", {
        ...target,
        media: {
          type: mediaType,
          media: fileId,
          caption: msg.caption,
          caption_entities: msg.caption_entities,
          show_caption_above_media: msg.show_caption_above_media,
          has_spoiler: msg.has_media_spoiler,
        },
      });
    } else {
      await api("editMessageCaption", {
        ...target,
        caption: msg.caption,
        caption_entities: msg.caption_entities,
      });
    }
  }
}

// "/del" as a reply, or "/del https://t.me/c/123/456" / "/del 456"
async function deleteCopies(msg, arg, env, api) {
  const chatId = String(msg.chat.id);
  let srcId = msg.reply_to_message && msg.reply_to_message.message_id;
  if (!srcId && arg) srcId = Number((arg.match(/(\d+)\/?$/) || [])[1]);
  if (!srcId || !env.STORE) return;

  const s = store(env, chatId);
  const gKey = `g:${srcId}`;
  const srcIds = (await s.get([gKey]))[gKey] || [srcId]; // whole album if part of one
  const keys = srcIds.map((id) => `m:${id}`);
  const found = await s.get(keys);

  const byChat = {};
  for (const k of keys) for (const c of found[k] || []) (byChat[c.chat] ||= []).push(c.id);
  for (const [chat, ids] of Object.entries(byChat)) {
    await api("deleteMessages", { chat_id: chat, message_ids: ids });
  }
  // remove the original post(s) and the /del command itself
  await api("deleteMessages", { chat_id: msg.chat.id, message_ids: [...srcIds, msg.message_id] });
  await s.del([...keys, ...srcIds.map((id) => `g:${id}`)]);
}

// Small key-value store (one Durable Object per source chat) that remembers
// which copy belongs to which original:  m:<srcId> -> [{chat, id}],  g:<srcId> -> album ids
export function store(env, chatId) {
  const stub = env.STORE.get(env.STORE.idFromName(`map:${chatId}`));
  const call = async (op, body) =>
    (await stub.fetch(`https://store/${op}`, { method: "POST", body: JSON.stringify(body) })).json();
  return {
    get: (keys) => call("get", { keys }),
    put: (entries) => call("put", { entries }),
    del: (keys) => call("del", { keys }),
  };
}

export class Store {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const body = await request.json();
    if (op === "get") return Response.json(Object.fromEntries(await this.storage.get(body.keys)));
    if (op === "put") await this.storage.put(body.entries);
    else if (op === "del") await this.storage.delete(body.keys);
    else return new Response("bad op", { status: 400 });
    return Response.json({ ok: true });
  }
}

// One instance per album. Buffers message ids, then sends them with
// copyMessages (keeps the album grouped, no sender name).
export class AlbumBuffer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const { chatId, messageId } = await request.json();
    const ids = (await this.state.storage.get("ids")) || [];
    if (!ids.includes(messageId)) ids.push(messageId);
    await this.state.storage.put({ ids, chatId });
    // restart the timer on every new photo; fires when the album is complete
    await this.state.storage.setAlarm(Date.now() + ALBUM_WAIT_MS);
    return new Response("queued");
  }

  async alarm() {
    const ids = ((await this.state.storage.get("ids")) || []).sort((a, b) => a - b);
    const chatId = await this.state.storage.get("chatId");
    await this.state.storage.deleteAll();
    if (!ids.length || !chatId) return;
    const api = this.api || makeApi(this.env.BOT_TOKEN);

    const results = [];
    for (const dest of parseRoutes(this.env.ROUTES)[chatId] || []) {
      const res = await api("copyMessages", {
        chat_id: dest,
        from_chat_id: Number(chatId),
        message_ids: ids,
      });
      if (res.ok && Array.isArray(res.result)) results.push([dest, res.result]);
    }

    if (this.env.STORE && results.length) {
      const entries = {};
      ids.forEach((id, i) => {
        entries[`m:${id}`] = results
          .filter(([, r]) => r[i])
          .map(([dest, r]) => ({ chat: dest, id: r[i].message_id }));
        entries[`g:${id}`] = ids;
      });
      await store(this.env, chatId).put(entries);
    }
  }
}
