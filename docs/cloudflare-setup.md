# Cloudflare Setup — Step by Step

Goal: bring the Flickd content backend online at `flickd.tangible.cloud`. Three components to deploy: **Pages** (static JSON), **share-api Worker** (KV-backed list sharing), **daily-ai Worker** (R2-backed cron-generated picks).

> **Heads-up about path conflicts:** if `flickd.tangible.cloud` already serves your existing app on the paths `/content/*`, `/api/share*`, or `/share/*`, the Worker routes below will pre-empt them. If that's a problem, see [Appendix A: using a different subdomain](#appendix-a-using-a-different-subdomain).

Everything below assumes you're on Windows in PowerShell.

---

## 0. Prerequisites (one-time)

```powershell
npm install -g pnpm
npm install -g wrangler
wrangler login          # opens browser → authorise with your Cloudflare account
```

Confirm:
```powershell
wrangler whoami
```
You should see your Cloudflare email and account ID. Note the **account ID** — you may need it later.

Also confirm:
- You own the zone `tangible.cloud` on Cloudflare (DNS dashboard shows it).
- `flickd.tangible.cloud` resolves through Cloudflare (orange cloud / proxied).

---

## 1. Push `flickd-content` to GitHub

The repo is already initialised locally with one commit. You need to:

1. Create a new **private** GitHub repo named `flickd-content` (or whatever you like). Don't initialise it with a README — it should be empty.
2. From the local folder, link and push:

```powershell
cd "C:\Users\reser\Workspaces\Media Remote\flickd-content"
git remote add origin https://github.com/<your-username>/flickd-content.git
git push -u origin main
```

> Cloudflare Pages will rebuild on every push, so commits to `main` ARE deploys. Keep that in mind.

---

## 2. Create the Pages project

This serves the static JSON in `content/`.

### 2a. Connect the repo

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Authorise GitHub if you haven't, pick `flickd-content`.
3. Project name: `flickd-content` (keeps URLs predictable).
4. Production branch: `main`.

### 2b. Build settings

You're not building anything — you're just serving the `content/` folder as static files. So:

- **Framework preset:** `None`
- **Build command:** leave blank
- **Build output directory:** `content`

Click **Save and Deploy**. The first build takes ~30 seconds.

Once it goes green, you'll get a URL like `https://flickd-content.pages.dev`. Visit:
- `https://flickd-content.pages.dev/manifest.json` — should return the seed manifest.
- `https://flickd-content.pages.dev/awards/oscars-2025.json` — should return the seed Oscars 2025 JSON.

If those work, Pages is good.

### 2c. Attach to `flickd.tangible.cloud`

Pages project → **Custom domains** → **Set up a custom domain** → enter `flickd.tangible.cloud`.

Cloudflare will offer to add the right CNAME automatically. Accept.

> If `flickd.tangible.cloud` already serves something else, you'll get a warning. Either:
> - Remove the existing thing (if you're replacing it), or
> - Use a different subdomain (see [Appendix A](#appendix-a-using-a-different-subdomain)).

Wait ~30 seconds for SSL provisioning. Then:
```
https://flickd.tangible.cloud/manifest.json
https://flickd.tangible.cloud/awards/oscars-2025.json
```
should serve.

> **Note on path layout:** the app fetches `/content/manifest.json`, but Pages' build output is `content/` itself, so the file lives at `/manifest.json` on Pages — without the `/content/` prefix. You have two choices:
> 1. **Move the build output up:** leave files where they are and change the app's base URL. **Recommended.** Easier than redirects.
> 2. **Add a Pages function** that rewrites `/content/*` → `/*`. More moving parts.
>
> Path layout choice tells you what to set as `FLICKD_BACKEND_BASE_URL`. See [step 5b](#5b-set-the-android-backend-url).

---

## 3. Create the R2 bucket (for the daily AI list)

```powershell
cd "C:\Users\reser\Workspaces\Media Remote\flickd-content\worker\daily-ai"
wrangler r2 bucket create flickd-daily
```

Output: `Created bucket flickd-daily`.

No other config — `wrangler.toml` already references `bucket_name = "flickd-daily"`.

---

## 4. Create the KV namespace (for shared lists)

```powershell
cd "C:\Users\reser\Workspaces\Media Remote\flickd-content\worker\share-api"
wrangler kv namespace create FLICKD_SHARE
```

Output looks like:
```
🌀 Creating namespace with title "share-api-FLICKD_SHARE"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "FLICKD_SHARE"
id = "abcd1234ef..."
```

Copy the `id`. Open `worker/share-api/wrangler.toml` and replace `REPLACE_WITH_KV_NAMESPACE_ID` with that id. Commit + push:

```powershell
cd "C:\Users\reser\Workspaces\Media Remote\flickd-content"
git add worker/share-api/wrangler.toml
git commit -m "chore: bind share-api KV namespace"
git push
```

---

## 5. Configure secrets for the daily-ai Worker

The cron Worker needs two API keys to function. They never enter source.

### 5a. Gemini API key (free)

1. Visit https://aistudio.google.com/apikey → **Create API key** → copy.
2. Set it on the Worker:

```powershell
cd "C:\Users\reser\Workspaces\Media Remote\flickd-content\worker\daily-ai"
wrangler secret put GEMINI_API_KEY
# paste when prompted, press Enter
```

### 5b. TMDB key

You already have one for the Android app. Reuse it:

```powershell
wrangler secret put TMDB_API_KEY
# paste when prompted
```

---

## 6. Deploy both Workers

```powershell
cd "C:\Users\reser\Workspaces\Media Remote\flickd-content\worker\share-api"
pnpm install
wrangler deploy
```

Output ends with something like:
```
Uploaded flickd-share-api (1.23 sec)
Published flickd-share-api (0.42 sec)
  https://flickd-share-api.<your-account>.workers.dev
Current Deployment ID: ...
```

Then:
```powershell
cd "C:\Users\reser\Workspaces\Media Remote\flickd-content\worker\daily-ai"
pnpm install
wrangler deploy
```

Both Workers now exist. They're already configured (in `wrangler.toml`) to bind to these routes:
- `flickd.tangible.cloud/api/share` → share-api
- `flickd.tangible.cloud/api/share/*` → share-api
- `flickd.tangible.cloud/content/daily/*` → daily-ai

Cloudflare auto-creates these routes from the `routes` array in `wrangler.toml` when you deploy.

---

## 7. Verify the share-api Worker

From any terminal (you can use PowerShell):

```powershell
# Create a share
$body = '{"title":"Halloween picks","items":[{"tmdbId":12345,"type":"MOVIE"}]}'
$resp = Invoke-RestMethod -Method POST `
  -Uri "https://flickd.tangible.cloud/api/share" `
  -ContentType "application/json" `
  -Body $body
$resp
# → code: ABC234... expiresAt: ...

# Read it back
Invoke-RestMethod "https://flickd.tangible.cloud/api/share/$($resp.code)"
```

If both calls return JSON, the share-api Worker is wired up end-to-end.

---

## 8. Trigger the daily-ai Worker manually (so the rail has data)

The cron fires once a day at 06:00 UTC. To populate `/content/daily/latest.json` *now*:

```powershell
cd "C:\Users\reser\Workspaces\Media Remote\flickd-content\worker\daily-ai"
wrangler triggers --schedule
```

If that command isn't available in your wrangler version, alternative:

```powershell
wrangler dev --test-scheduled
# in a second terminal:
curl "http://localhost:8787/__scheduled?cron=0+6+*+*+*"
# then in the first terminal, Ctrl+C
wrangler deploy   # re-deploy so the test trigger is the deployed version
```

Then check:
```
https://flickd.tangible.cloud/content/daily/latest.json
```

You should see today's themed list with ~10 items.

> If the file is empty or 404, run `wrangler tail flickd-daily-ai` and trigger again — you'll see Gemini/TMDB errors live.

---

## 9. Turn on the feature flags

Everything is deployed but the app still has all flags off. Edit `content/feature-flags.json`:

```json
{
  "schemaVersion": 1,
  "flags": {
    "enableDailyRail": true,
    "enableSharedLists": true,
    "enableRemoteAwards": true
  },
  "manifestCacheSeconds": 300
}
```

Rebuild the manifest and push:
```powershell
cd "C:\Users\reser\Workspaces\Media Remote\flickd-content"
node scripts/build-manifest.mjs
git add content/feature-flags.json content/manifest.json
git commit -m "chore: enable content backend feature flags"
git push
```

Pages rebuilds in ~30s. The Android app picks up new flags on next launch (or within 5 minutes for an open session, because of the manifest cache TTL).

---

## 10. Done. Sanity-check on the phone

1. Force-close and re-open the Flickd app.
2. **Home screen** should now have a "Today's Picks" rail between "Trending This Week" and "New Movies".
3. **Awards screen** — the seed Oscars 2025 + 2026 should still render. Modify a title in the admin (next guide) and the change should appear within 5 minutes of a manifest revalidation.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `https://flickd.tangible.cloud/manifest.json` returns 404 | Pages build output isn't pointed at the right folder | Pages project → Settings → Build → set output to `content` |
| Share API returns 429 | Per-IP rate limit (default 10/hour) | Bump `RATE_LIMIT_PER_HOUR` in `worker/share-api/wrangler.toml`, redeploy |
| Daily list is empty | Gemini returned titles TMDB couldn't resolve | `wrangler tail flickd-daily-ai`, then manually trigger; if persistent, edit the prompt in `worker/daily-ai/src/prompts.ts` |
| Android app doesn't show the daily rail | Feature flag off, OR app's `FLICKD_BACKEND_BASE_URL` doesn't match where Pages serves the JSON | Set `FLICKD_BACKEND_BASE_URL` in `android/local.properties` and rebuild |
| `wrangler deploy` says "Route already in use" | Another Worker already binds that route | Cloudflare dashboard → Workers Routes → delete the conflicting one |

`wrangler tail <worker-name>` is your best friend — streams live logs.

---

## Appendix A: using a different subdomain

If you can't host the content backend at `flickd.tangible.cloud` because something else lives there:

1. Pick a new subdomain, e.g. `content.flickd.tangible.cloud`.
2. Cloudflare DNS → add a CNAME `content.flickd.tangible.cloud → flickd-content.pages.dev`, proxied (orange cloud).
3. Edit both `wrangler.toml` files — change every `flickd.tangible.cloud` to `content.flickd.tangible.cloud`.
4. Update the Android `BuildConfig.FLICKD_BACKEND_BASE_URL` accordingly: add to `android/local.properties`:
   ```
   FLICKD_BACKEND_BASE_URL=https://content.flickd.tangible.cloud/
   ```
   Rebuild the app (`:app:assembleDebug`).
5. Update the App-Link intent filter host in `android/app/src/main/AndroidManifest.xml` (`flickd.tangible.cloud` → new host) and rebuild.
6. Update `ShareDeepLinkUtils.parseRouteFromUri` to recognise the new host (or generalise the host check to match a list).
