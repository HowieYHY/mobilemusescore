# PocketScore usage counter (owner only)

A small Cloudflare Worker with a D1 database. The app sends it one anonymous heartbeat per visit
(`app/src/usage.ts`); the owner reads the numbers inside PocketScore by tapping the version line on the
start screen seven times and typing the key. See the *Usage counter* row in `docs/DEVELOPMENT.md`.

Stored per visit: a random install id, a random visit id, app version, installed app or browser tab,
seconds in front, seconds of playing. Not stored: IP address, score names, files, notes.

## One-time setup (free Cloudflare account)

Run these in this folder (`tracker/`):

```
npx wrangler login
npx wrangler d1 create pocketscore-usage
```

Paste the `database_id` it prints into `wrangler.toml`, then:

```
npx wrangler d1 execute pocketscore-usage --remote --file=schema.sql
npx wrangler secret put STATS_KEY        # type a long random key (32+ characters); keep a copy in your password manager
npx wrangler deploy
```

`deploy` prints the Worker's address (`https://pocketscore-usage.<you>.workers.dev`). Then:

1. Put it in `app/.env.production` as `VITE_USAGE_URL=https://pocketscore-usage.<you>.workers.dev`
   (no trailing slash; not secret, so it may be committed). Without it the app sends nothing.
2. Bump the version, `npm run build` in `app/`, `bash scripts/deploy-pages.sh`.
3. Open the live app, tap the version line on the start screen 7 times, type the key.

## Notes

- `TZ_OFFSET_HOURS` in `wrangler.toml` sets where a "day" starts (8 = Singapore).
- The key is only a Worker secret. To change it, run `wrangler secret put STATS_KEY` again.
- The Reso website's frozen copy of PocketScore is built without the address, so it sends nothing.
- To look at the raw rows: `npx wrangler d1 execute pocketscore-usage --remote --command "SELECT * FROM sessions ORDER BY started DESC LIMIT 20"`.
- Free-plan limits (D1 and Workers) are far above a few thousand visits a day. Rows are small; delete
  old ones with `DELETE FROM sessions WHERE started < <ms>` if it ever matters.
