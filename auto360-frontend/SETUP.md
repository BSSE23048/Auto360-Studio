# Auto360 cloud setup

> **Superseded for storage:** use the repository [README](../README.md) for the Cloudinary migration and current deployment steps. The R2 instructions below describe the previous release only; do not follow them for the new Worker. Never run old and new cleanup Workers concurrently against the migrated database.

Nothing has been installed, tested or deployed by the implementation agent.

## Configure manually

1. Create a Supabase project on the free plan. In its SQL editor run `supabase/migrations/001_showrooms.sql`, `002_atomic_operations.sql`, then `003_storage_reporting.sql`, once each in order. Keep email confirmation enabled. Set Auth → URL Configuration → Site URL to your Pages origin; add `https://YOUR_PROJECT.pages.dev/**` and, for local use, `http://localhost:5173/**` to redirect URLs. Enable email/password authentication. Supabase's development email service has sending restrictions; configure your own SMTP provider if you need broader delivery. No mail provider is provisioned here.
2. In Cloudflare create **one private R2 Standard** bucket named `auto360-originals`. Leave r2.dev public access, custom public domains, and public bucket access disabled. Do not add an automatic deletion lifecycle rule: cleanup is coordinated with database accounting. This app uses a Worker binding, not browser R2 credentials or public bucket CORS.
3. Create a Pages project (Direct Upload, production branch `main`). Choose its permanent name before configuring URLs. Edit `worker/wrangler.toml`: Supabase URL, exact Pages origin, allowed origins and bucket name. Add `http://localhost:5173` to `ALLOWED_ORIGINS` only if needed. Do not include `/*` or trailing `/` in origins. Pages preview deployment origins are denied unless explicitly added.
4. Set Worker secrets using the commands below. `SUPABASE_SERVICE_ROLE_KEY` belongs only in Worker secrets. `SUPABASE_ANON_KEY` is the Supabase public anon key. Never put the service-role key in a `VITE_` variable.
5. Copy `.env.example` to `.env.local`. Enter the Supabase project URL, **public anon key**, and deployed Worker URL. Vite embeds these public settings at build time. When all three are present, existing screens use cloud storage and require authentication. Without configuration, local drafts still work. Local drafts are deliberately not uploaded automatically.
6. Deploy the Worker and Pages manually. Set Supabase password minimum length to at least 8. Keep Cloudflare on free plans; do not enable Workers Paid, Images, resizing, R2 Infrequent Access or other paid features for this app. The code does not purchase or activate plans. Check current account quotas/billing settings in the provider dashboards yourself.

## PowerShell (run yourself)

Requires an installed Node.js version supported by the selected Vite/Wrangler releases. Replace placeholders before running.

```powershell
Set-Location "C:\Users\MAF Tech\OneDrive\Pictures\Documents\GitHub\Auto360-Studio\auto360-frontend"
Copy-Item .env.example .env.local
notepad .env.local
notepad worker\wrangler.toml
npm install
Set-Location worker
npm install
npx wrangler login
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SUPABASE_ANON_KEY
npm run typecheck
npm run deploy
Set-Location ..
```

After entering the deployed Worker URL in `.env.local`:

```powershell
npm run build
Set-Location worker
npx wrangler pages deploy ..\dist --project-name YOUR_PAGES_PROJECT --branch main
Set-Location ..
```

Optional local frontend (against your deployed API, with localhost allowed):

```powershell
npm run dev
```

## Limits and lifecycle

- Defaults: **8,000,000,000 bytes global**, **500,000,000/account**, **250,000,000/listing**, **20,000,000/original**, **1,048,576/preview**, 10 listings/account, 3 simultaneous uploads/account. Required/optional slots cap each listing at 38 photos (24-frame) or 62 photos (48-frame). R2 storage elsewhere in your account is outside this app's accounting; leave headroom for it.
- Change limits in the single `public.storage_budget` row using the Supabase SQL editor. The migration caps global capacity at 8 GB and original buffers at 20 MB. Lowering limits blocks new reservations but does not delete existing files. Preview bytes and replacement overlap count toward the budget. Storage quotas do not cap request traffic or guarantee zero billing; keep the service plans free and monitor usage.
- Original upload bodies are byte-preserving; Worker file signatures, exact streamed sizes and SHA-256 are checked. R2 validates the supplied SHA-256. Completion checks stored object metadata and lengths. This is container/signature validation, not a full image decoder, malware scanner or proof that photos show the stated car.
- Previews are separate JPEGs generated in the browser, up to 960 pixels and 1 MiB. Unsupported HEIC files stay intact; the owner can supply a compatible copy **of the same photograph** for its preview. Preview-generation failures never discard the original. Every required position must have a preview before publishing. The operating system's file picker may itself convert files before the browser receives them; choose originals from Files where necessary.
- Upload sessions expire after 15 minutes and require both a current owner session and a random per-upload token. Requests are size bounded; reservations are serialized in PostgreSQL. Partial upload retries create a new session; successful originals are not overwritten in place. Replacements retain the previous original until the new media transaction completes.
- A cron runs every 15 minutes. Removed/replaced objects are retried through the persistent cleanup queue. Abandoned uploads retain their reserved capacity for at least 24 hours after expiry/cancellation to allow in-flight writes to settle; this is deliberately conservative. Completed media sizes are exact; pending reservations/cleanup are reported separately. Deleting a photo automatically unpublishes its listing.
- Public JSON is not cached. Public image authorization checks publication **before** reading the internal edge cache. R2 remains private. Browser responses use `no-store`; unpublishing blocks subsequent access, but cannot revoke a visitor's saved copy. Original downloads are public only while the listing is published.
- Public requests are limited per hashed IP/minute; private requests per verified user/minute. These app-level limits use PostgreSQL and are not DDoS protection. Use Cloudflare's available free security controls for public abuse. The cleanup batch is bounded for Worker subrequest limits.
- Existing original downloads are fetched only on explicit action. Owner and public viewers initially use previews. Database writes cannot be made directly with the browser anon key; owner read RLS and Worker-only mutation RPCs enforce boundaries. Do not manually remove Auth users until their listings and queued storage have been deleted; foreign keys intentionally prevent orphaning files.

## Manual acceptance checks (unverified)

Register/confirm/login/logout; create and reopen a draft; upload JPEG/HEIC; add a compatible preview; replace/remove photos; publish a complete listing; open `/car/slug` in an unauthenticated browser; unpublish and retry the media URL; try another account's listing IDs; try altered signatures, excessive sizes and an expired upload token; temporarily lower quotas and confirm reservation rejection; confirm the scheduled cleanup releases storage after deleting files. No cloud credentials or deployment are included in this repository.
