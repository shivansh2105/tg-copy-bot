# tg-copy-bot

Telegram bot that copies everything you post in your groups to a channel, **without the "Forwarded from" / sender name**. Runs free on Cloudflare Workers (no card, always on).

```
Group A ─┐
         ├──► bot (copyMessage = no sender name) ──► Channel
Group B ─┘
```

## Setup (~10 min, all free)

### 1. Create the bot
1. Open **@BotFather** → `/newbot` → copy the **token**.
2. `/setprivacy` → pick your bot → **Disable** (so it can see normal group messages).

### 2. Deploy on Cloudflare (free)
1. Sign up at https://dash.cloudflare.com (free, no card).
2. **Workers & Pages → Create → Create Worker** → name it → **Deploy**.
3. **Edit code** → delete everything → paste [`worker.js`](worker.js) → **Deploy**.
4. **Settings → Variables and Secrets → Add**:
   | Name | Type | Value |
   |---|---|---|
   | `BOT_TOKEN` | Secret | token from BotFather |
   | `WEBHOOK_SECRET` | Secret | any random text, e.g. `mySecret_123` (letters, digits, `_`, `-` only) |
5. Open in browser: `https://<your-worker>.workers.dev/setup?key=<WEBHOOK_SECRET>` → should show `"ok":true`.

### 3. Add the bot to chats
- Add bot to **Group A** and **Group B** (make it admin to be safe).
- Add bot to the **channel** as **admin** with "Post messages".
- Send `/id` in each group → bot replies with the chat ID and your user ID.
  For the channel: post `/id` in the channel (bot replies there; delete afterwards).

### 4. Set routes
Back in Cloudflare → Variables, add:
| Name | Value |
|---|---|
| `ROUTES` | `-100GROUP_A=-100CHANNEL,-100GROUP_B=-100CHANNEL` |
| `OWNER_ID` | your user ID (optional: only your posts get copied) |

Done. Post anything in Group A/B → appears in channel with no sender name.

## Notes
- Works with text, photos, videos, files, voice, stickers, polls, etc.
- Albums (multi-photo posts) arrive as separate messages.
- Chats with "Restrict saving content" turned on can't be copied (Telegram blocks it).
- A group upgraded to supergroup gets a new ID — run `/id` again if it stops.
- Free plan = 100k requests/day, way more than needed.

## Test locally
```
node test.mjs
```
