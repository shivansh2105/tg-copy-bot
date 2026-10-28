// Telegram "copy without sender" bot for Cloudflare Workers (free plan).
//
// Copies every post from source groups/channels to a destination chat using
// copyMessage, so there is NO "Forwarded from <name>" header.
//
// Environment variables (Cloudflare dashboard -> Worker -> Settings -> Variables):
//   BOT_TOKEN       (secret)  token from @BotFather
//   WEBHOOK_SECRET  (secret)  any random string, letters/digits/_/- only
//   ROUTES                    source=destination pairs, comma separated
//                             e.g.  -1001111111111=-1009999999999,-1002222222222=-1009999999999
//                             repeat a source to send it to several destinations
//   OWNER_ID        (optional) your Telegram user id(s), comma separated.
//                             If set, only posts from these users are copied
//                             (anonymous-admin posts in the group are also allowed).

const TG = "https://api.telegram.org/bot";

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
        allowed_updates: ["message", "channel_post"],
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
  const msg = update.message || update.channel_post;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();

  // /id -> tells you the chat id and your user id (works even before ROUTES is set)
  if (/^\/id(@\w+)?$/i.test(text)) {
    await api("sendMessage", {
      chat_id: msg.chat.id,
      text: `Chat ID: ${chatId}\nYour user ID: ${msg.from ? msg.from.id : "n/a (channel)"}`,
    });
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

  if (text.startsWith("/")) return; // don't copy bot commands

  for (const dest of dests) {
    await api("copyMessage", {
      chat_id: dest,
      from_chat_id: msg.chat.id,
      message_id: msg.message_id,
    });
  }
}
