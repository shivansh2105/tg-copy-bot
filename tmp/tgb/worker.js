var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var TG = "https://api.telegram.org/bot";
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const api = makeApi(env.BOT_TOKEN);
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
        allowed_updates: ["message", "channel_post"],
        drop_pending_updates: true
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
  }
};
function makeApi(token) {
  return async (method, body) => {
    const r = await fetch(`${TG}${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!j.ok) console.log(method, "failed:", j.description);
    return j;
  };
}
__name(makeApi, "makeApi");
function parseRoutes(str = "") {
  const routes = {};
  for (const pair of str.split(/[,\n;]+/)) {
    const [src, dst] = pair.split("=").map((s) => (s || "").trim());
    if (!src || !dst) continue;
    (routes[src] ||= []).push(dst);
  }
  return routes;
}
__name(parseRoutes, "parseRoutes");
async function handleUpdate(update, env, api) {
  const msg = update.message || update.channel_post;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();
  if (/^\/id(@\w+)?$/i.test(text)) {
    await api("sendMessage", {
      chat_id: msg.chat.id,
      text: `Chat ID: ${chatId}
Your user ID: ${msg.from ? msg.from.id : "n/a (channel)"}`
    });
    return;
  }
  const dests = parseRoutes(env.ROUTES)[chatId];
  if (!dests) return;
  if (env.OWNER_ID && msg.chat.type !== "channel") {
    const owners = env.OWNER_ID.split(",").map((s) => s.trim());
    const fromOwner = msg.from && owners.includes(String(msg.from.id));
    const anonAdmin = msg.sender_chat && String(msg.sender_chat.id) === chatId;
    if (!fromOwner && !anonAdmin) return;
  }
  if (text.startsWith("/")) return;
  if (msg.media_group_id && env.ALBUMS) {
    const key = `${chatId}:${msg.media_group_id}`;
    const stub = env.ALBUMS.get(env.ALBUMS.idFromName(key));
    await stub.fetch("https://album/add", {
      method: "POST",
      body: JSON.stringify({ chatId, messageId: msg.message_id })
    });
    return;
  }
  for (const dest of dests) {
    await api("copyMessage", {
      chat_id: dest,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id
    });
  }
}
__name(handleUpdate, "handleUpdate");
var ALBUM_WAIT_MS = 2e3;
var AlbumBuffer = class {
  static {
    __name(this, "AlbumBuffer");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const { chatId, messageId } = await request.json();
    const ids = await this.state.storage.get("ids") || [];
    if (!ids.includes(messageId)) ids.push(messageId);
    await this.state.storage.put({ ids, chatId });
    await this.state.storage.setAlarm(Date.now() + ALBUM_WAIT_MS);
    return new Response("queued");
  }
  async alarm() {
    const ids = (await this.state.storage.get("ids") || []).sort((a, b) => a - b);
    const chatId = await this.state.storage.get("chatId");
    await this.state.storage.deleteAll();
    if (!ids.length || !chatId) return;
    const api = this.api || makeApi(this.env.BOT_TOKEN);
    for (const dest of parseRoutes(this.env.ROUTES)[chatId] || []) {
      await api("copyMessages", {
        chat_id: dest,
        from_chat_id: Number(chatId),
        message_ids: ids
      });
    }
  }
};
export {
  AlbumBuffer,
  worker_default as default,
  handleUpdate,
  makeApi,
  parseRoutes
};
//# sourceMappingURL=worker.js.map
