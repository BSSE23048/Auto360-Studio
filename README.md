# Auto360 Studio

A photo-based vehicle inspection viewer for sellers who want to present a car's exterior, interior and detail photographs in one shareable workflow.

## Project at a glance

- **Frontend:** React, TypeScript and Vite.
- **Backend:** Supabase Auth/PostgreSQL and a Cloudflare Worker API.
- **Media:** authenticated Cloudinary storage and delivery.
- **Source:** [BSSE23048/Auto360-Studio](https://github.com/BSSE23048/Auto360-Studio).
- **Maintainer:** [Agha Shoaib Zaib](https://github.com/BSSE23048).
- **Status:** implementation present; cloud migration, deployment and device acceptance remain unverified.

The viewer uses real uploaded frames, with separate previews and explicit original-photo inspection. It does not generate missing angles. Hotspots need per-car calibration; the default hotspot registry is empty.

## Local frontend preview

Use Node.js 22 and npm. From the repository root:

```sh
cd auto360-frontend
npm ci
cp .env.example .env.local
npm run dev
```

On Windows, use `Copy-Item .env.example .env.local` instead of `cp`. Fill the public Supabase configuration and Worker URL for an isolated test environment. Browser setup alone does not provision the database, Worker or media service.

`npm run build` checks TypeScript and builds the frontend. In `auto360-frontend/worker`, run `npm ci` and `npm run typecheck`. No automated viewer test suite is configured yet.

## Demonstration and screenshots

Use a car/photo set you have permission to show. Demonstrate rotation, missing-frame feedback, detail inspection, an explicit original download and the public/draft boundary. Capture mobile and desktop screenshots only after the actual workflow passes. No live demo or screenshots are claimed by this documentation update.

## Configuration and release notes

The operational instructions below describe provider setup, migration risks and acceptance gates. Preserve originals and backups; do not run legacy and replacement cleanup Workers concurrently.


Existing React/Supabase application with a Cloudflare Worker API and **Cloudinary Free** storage. No dependencies were added for this migration. Commands, builds, cloud operations and migrations have **not** been executed or verified by the implementation agent.

## Cloudinary configuration

1. Create a dedicated Cloudinary Free product environment. Obtain its **cloud name, API key and API secret**. The Worker needs Upload API signing/destroy permissions and Admin API resource/preset/usage reads. Keep these credentials in Worker secrets, never Vite variables.
2. Create the **signed** upload preset `auto360_signed_raw`. Leave transformations, eager transformations, output format, folder/asset-folder rules, eval hooks, add-ons and access control overrides empty. Do not enable unsigned uploads. The Worker checks the preset and signs fixed `authenticated` delivery, `overwrite=false`, `backup=false`, deterministic random-session IDs and a raw-only `.a360` allowed extension.
3. Verify that your account permits **authenticated raw uploads and private raw download API delivery**. If it does not, this implementation fails closed: do not change assets to public/unlisted or purchase a plan automatically. No premium token-auth/CDN feature is assumed.
4. Keep the Free plan. Its documented ceilings currently include 10 MB raw/image files, 25 MP images and 500 Admin requests/hour. This app defaults to 10,000,000 original bytes, 25 MP, a 2 GB application storage budget, and 10 MiB worst-case reservation per signed raw asset. Confirm the account raw-file maximum is no larger than `storage_budget.cloudinary_raw_ceiling`. A different/larger provider ceiling requires increasing that reservation **before** issuing signatures. App-original limits can be lowered independently. [Provider limits](https://cloudinary.com/pricing/compare-plans)

## Existing database and R2 cutover — important

- Apply **only** `auto360-frontend/supabase/migrations/004_cloudinary_storage.sql` after existing migrations 001–003. Do not rerun or edit applied migrations. The new migration preserves listing IDs, media IDs, existing keys and ownership policies. Replacement updates existing media rows rather than changing their IDs. Empty installations receive the 2 GB app budget; existing populated installations retain their current budget so migration does not silently remove their headroom. Replacements temporarily count both old and new assets.
- **Existing R2 bytes cannot be moved by a SQL migration.** Before cutover, export/back up all original objects and identify their listing/slot mappings. Disable the old Worker and its cron during the maintenance window: its cleanup code does not understand Cloudinary jobs. Do not run old/new Workers concurrently against this database.
- Existing rows remain explicitly marked `r2`. The new Worker refuses to pretend those objects exist in Cloudinary and returns a migration-required error for them. Restore them through the existing photo wizard from your exported originals, into the same slots; IDs remain stable and new previews are generated. The old R2 keys remain in the cleanup queue. Large originals over the Free-plan ceiling cannot migrate unchanged; retain their backups and do not reduce their quality silently.
- This release does **not** automate legacy byte transfer or guarantee zero-downtime cutover. If you already have live R2 galleries and cannot schedule/export/restore them, **do not deploy the replacement yet**. Keep your existing service until a separate authenticated transfer procedure is arranged.
- After independently deleting the old R2 objects, an administrator can call `public.finish_gc` for the corresponding **R2-only** queue IDs in the Supabase SQL editor. Never release those jobs before confirming deletion. The Cloudinary cron never deletes or releases legacy R2 objects. Do not delete the old bucket before backups/restoration are confirmed.

## Upload and delivery security

The browser hashes each original, creates separate 960px JPEG previews and 240px thumbnails, and asks the authenticated Worker to reserve storage. Unsupported browser decoders can upload the raw original alone; the existing compatible-copy action creates a separate preview without altering the original. The Worker verifies stored bytes through Cloudinary's authenticated Admin and download APIs, including byte counts, SHA-256, format signatures and readable dimensions, before committing media. Hash or format mismatch rejects the file. Originals remain raw; no Cloudinary image transformation, conversion or enhancement is requested. Container validation is not a full image decoder or malware scanner. [Raw storage](https://cloudinary.com/documentation/upload_parameters)

Cloudinary upload signatures last approximately **one hour**, even though application finalization expires after 15 minutes. The signature covers fixed parameters; **file content and resource_type are not signed**. The `.a360`-only allowed format rejects image/video-type replay; finalization only accepts authenticated raw assets at server-chosen IDs. Signed presets cannot enforce per-file byte limits. Reservations therefore cover the provider's whole raw-file ceiling for each issued signature, including previews, rather than trusting declared file sizes. Invalid/abandoned files keep those reservations until cleanup. Completion releases excess reserved bytes only after immutable, `overwrite=false` assets are verified. [Signing](https://cloudinary.com/documentation/upload_images) · [Preset limits](https://cloudinary.com/documentation/upload_presets)

All Cloudinary assets stay authenticated, even after publication. Browsers receive only Worker media routes. The Worker checks owner access or current publication status before delivery or an internal cache lookup. Provider download signatures expire after 60 seconds and are never sent to the browser. No permanent signed CDN URLs are exposed. Private-download delivery can consume additional Cloudinary bandwidth; public cache misses and verification downloads count too. Unpublishing blocks subsequent Worker access but cannot revoke already downloaded files, in-flight responses or a visitor's saved copy. CDN invalidation is asynchronous, not a revocation guarantee. [Private delivery](https://cloudinary.com/documentation/control_access_to_media)

Cleanup runs every 15 minutes, handles known signed namespaces, verifies deletion, and retains failed jobs/accounting. It waits at least 24 hours beyond the upload signature/finalization window before deleting replaceable assets so a still-valid signature cannot resurrect a released object. Credentials used outside this app can create assets outside its tracked namespaces; inspect the provider dashboard for those. Admin requests are additionally limited to six/minute for this app; 429 responses retain reservations rather than bypass verification.

## Usage controls and limitations

The UI reports **application-tracked asset bytes**, reservations and cleanup backlog. Those are not Cloudinary's credits or a provider bill. The Worker checks account credit usage at most hourly and pauses new signatures at 80% of the reported credit allowance; stale/unavailable or unrecognized usage data blocks signing. Usage may lag and bandwidth continues during delivery, so this is not a hard credit/billing cap. Cloudinary Free combines storage, transformations and bandwidth in its credit allowance. Monitor the provider dashboard; no paid feature or automatic upgrade is enabled. [Credit accounting](https://cloudinary.com/documentation/billing_and_plans)

Originals with unsupported containers, unreadable dimensions, too many pixels or excessive bytes are rejected with an explanation. HEIC/HEIF files supported as raw originals may still need a user-supplied compatible preview and a compatible app for original viewing. No original is downloaded on gallery opening. Full-quality inspection/zoom and downloads require explicit action.

## Manual configuration and PowerShell

Retain Supabase Auth settings and existing URLs. `worker/wrangler.toml` retains Supabase URL, frontend origin, allowed origins and cron; its R2 binding is removed. Frontend variables remain `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`. No public Cloudinary variable is required.

First perform the maintenance/export steps above and apply migration 004 manually in Supabase SQL Editor. Then run these commands yourself. No installation is needed if existing project dependencies are already installed.

```powershell
Set-Location .\auto360-frontend\worker
npx wrangler login
npx wrangler secret put CLOUDINARY_CLOUD_NAME
npx wrangler secret put CLOUDINARY_API_KEY
npx wrangler secret put CLOUDINARY_API_SECRET
# Only if these existing Worker secrets have not already been configured:
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SUPABASE_ANON_KEY
npm run typecheck
npm run deploy
Set-Location ..
npm run build
Set-Location worker
npx wrangler pages deploy ..\dist --project-name auto360-studio --branch main
```

If dependencies are absent, run `npm install` manually in `auto360-frontend` and `auto360-frontend/worker` before the commands above. Never put the service-role key or Cloudinary API secret in `.env.local` or any `VITE_` variable. `.dev.vars.example` contains placeholders only.

## Manual acceptance checks — not run

- Register/login/logout; create/edit your listing; reject another user's listing and session IDs.
- Upload JPEG, PNG, WebP and supported HEIC/AVIF; compare downloaded SHA-256 with the source; try oversized files, invalid contents and excessive dimensions. Verify no original request on initial gallery opening.
- Alter signed public ID, folder, preset, overwrite/type parameters; replay at image/video endpoints with the raw-only extension; all must reject. Try oversize raw uploads and mismatched hashes; finalization must reject and preserve cleanup reservations.
- Open guessed unsigned Cloudinary URLs for drafts: they must fail. A malformed preset, missing private-raw capability or unavailable usage/Admin API must stop uploads, not fall back to public delivery.
- Replace/remove photos; inspect quota overlap and delayed cleanup. Let an upload expire; attempt replay before and after signature expiry. Verify actual objects disappear before reservations are released.
- Publish a complete gallery; view it without login and share `/car/{slug}` on WhatsApp. Unpublish and retry the **Worker** media URL, including an edge-cache hit: access must fail. Test explicit original inspection/zoom and format fallback.
- Verify legacy R2 rows/IDs survive migration, replacement retains the existing media ID, and old queue entries are never falsely reported as Cloudinary-deleted.


## Final release preparation (static review only)

This pass adds mobile spacing/safe-area/focus refinements, lazy viewer loading with a retry boundary, offline feedback, cancellable public-manifest reads, native sharing/copy fallback, optional public seller WhatsApp contact, publication guidance and metadata-only photo-position correction. No runtime, cloud or device checks were executed.

**Apply new migration 005_photo_slot_assignment.sql after 001–004**, in Supabase SQL Editor, before deploying this Worker. Do not rerun applied migrations. Its service-role-only RPC checks ownership and allowed capture slots, rejects active uploads, moves/swaps metadata atomically and unpublishes the listing. Original IDs/keys/bytes and storage accounting stay unchanged. There are no new secrets or dependencies.

For a fresh installation, apply migrations 001 through 005 in order. Enable Supabase email/password Auth and confirmation, set the Site URL to your Pages origin, and allow its auth redirect URL. Configure the existing Vite Supabase URL/anon key/Worker URL through Pages environment settings. Configure Worker secrets and the reviewed **signed** Cloudinary preset using the earlier sections; never use an unsigned preset or public raw delivery fallback.

The static HTML now includes generic Open Graph metadata. Per-car crawler previews/images require server-rendered HTML or a Pages Function that reads only published listings; this release does not pretend client-side metadata updates work for WhatsApp crawlers. No seller image is embedded in generic metadata. Hotspots still require calibrated per-car coordinates; panorama/transition capture and 36-frame database support remain outside the existing manifest.

Photo uploads show indeterminate save/verification progress, not invented transfer percentages. Existing originals/previews and quota/credit checks remain in place. Account capabilities and limits must be confirmed in the Cloudinary dashboard. Monitor credits, bandwidth, Admin API usage, application reservations and cleanup backlog separately.

### Manual release checklist — not run

- Register, confirm email, log in/out; create, edit, resume and delete a listing.
- Upload, replace and remove originals; try supported/unsupported formats, oversize files and quota exhaustion. Compare a downloaded original with its source. No original should load on initial gallery opening.
- Move into an empty photo slot and swap occupied slots. Confirm unchanged media IDs/bytes/storage usage, blocked reassignment during pending uploads, automatic unpublishing, and rejection for another seller’s listing.
- Rotate across 0 degrees both ways; open interior/part photos and calibrated hotspots, return to the previous angle, inspect/download originals and close during loading.
- Publish, open the stable public URL while logged out, share/copy it and send a vehicle-specific WhatsApp inquiry. Confirm the phone is optional and only shown from published data.
- Unpublish and request both cached public media and its manifest again: access must fail. Another user and anonymous users must not access draft endpoints. Previously downloaded files cannot be remotely revoked.
- Test 320/360/375/390/430px layouts, portrait/landscape, keyboard focus, reduced motion, offline/retry and slow loading on real iPhone Safari and Android Chrome. Test vertical scrolling before enabling pinch/pan.
- Complete checks before deployment; a successful build alone does not verify cloud permissions or real devices.

From the repository root, run manually (existing dependencies assumed):

```powershell
Set-Location .\auto360-frontend
npm run build
Set-Location .\worker
npm run typecheck
# After applying migration 005 and completing acceptance checks:
npm run deploy
npx wrangler pages deploy ..\dist --project-name auto360-studio --branch main
```

For local acceptance testing, run `npm run dev` from `auto360-frontend`. Configure URLs/origins and secrets manually using the earlier setup section. No secret values were read or added to this repository.
