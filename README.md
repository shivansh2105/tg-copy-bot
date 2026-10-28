# tg-copy-bot

Telegram bot that copies everything you post in your groups to a channel, **without the "Forwarded from" / sender name**. Albums stay albums. Runs free on Cloudflare Workers (no card, always on).

```
Group A ─┐
         ├──► bot (copyMessage = no sender name) ──► Channel
Group B ─┘
```

## Setup (free)

### 1. Create the bot
1. **@BotFather** → `/newbot` → copy the **token**.
2. `/setprivacy` → pick your bot → **Disable** (so it sees normal group messages).

### 2. Deploy (needs Node.js)
```bash
git clone https://github.com/shivansh2105/tg-copy-bot && cd tg-copy-bot
npx wrangler login                     # free Cloudflare account, opens browser
npx wrangler deploy                    # prints https://tg-copy-bot.<you>.workers.dev
npx wrangler secret put BOT_TOKEN      # paste BotFather token
npx wrangler secret put WEBHOOK_SECRET # any text: letters, digits, _ or -
```
Open `https://tg-copy-bot.<you>.workers.dev/setup?key=<WEBHOOK_SECRET>` → should show `"ok":true`.

### 3. Add the bot to chats
- Add bot to **Group A** and **Group B** (admin recommended).
- Add bot to the **channel** as **admin** with "Post messages".
- Send `/id` in each chat → bot replies with the chat ID (and your user ID).

### 4. Set routes
```bash
npx wrangler secret put ROUTES    # -100GROUP_A=-100CHANNEL,-100GROUP_B=-100CHANNEL
npx wrangler secret put OWNER_ID  # optional: your user ID, only your posts get copied
```
Done. Post in Group A/B → appears in the channel with no sender name.

## Edit & delete
| You do in the source | What happens in the copy |
|---|---|
| Edit text / caption / swap photo | copy is edited the same way (automatic) |
| Reply `/del` to a post | copy **and** original (and the /del message) are deleted |
| `/del <post link>` | same, if you can't reply |
| Delete normally | copy stays (Telegram does not tell bots about deletions) |

The bot needs **Delete messages** permission in the source chat for `/del` to remove the original. Telegram only lets bots delete messages less than 48 h old. Copies made before this feature was deployed can't be edited/deleted by the bot.

## How albums work
Telegram delivers each album photo as a separate message. The bot buffers them per album in a Durable Object (free plan), waits 2 s after the last photo, then sends them together with `copyMessages`.

## Notes
- Text, photos, videos, files, voice, stickers, polls all work.
- Chats with "Restrict saving content" can't be copied (Telegram blocks it).
- A group upgraded to supergroup gets a new ID — run `/id` again.
- Free plan limits are far above normal use.

## Test locally
```
npm test
```
