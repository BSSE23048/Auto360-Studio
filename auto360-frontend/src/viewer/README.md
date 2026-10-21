# Photo viewer integration

`CarViewer` serves authenticated owner previews and public manifests. It accepts 24, 36 or 48 configured exterior frames; the existing capture/database schema still supports only 24/48. It skips missing previews and retains the last decoded frame while loading. Originals are requested only from the existing Worker endpoint after an explicit inspection action.

Preview fetching is sequential: selected image, neighbours, remaining exterior images. Cache is limited to 48 compressed previews / 16 MiB and released when leaving the viewer. Inspection previews load on demand. Original dialogs hold one original, cancel pending requests on close and release their object URL. Authorization remains enforced by the Worker; already downloaded bytes cannot be revoked remotely.

Touch zoom is explicitly enabled (or activated with a double tap) to let ordinary vertical page scrolling work. Once enabled, pinch and pan use the image's contain bounds. Original zoom stops at actual CSS pixels, without resampling the file. Browser/device memory, display density and format support still apply.

Configure `LISTING_HOTSPOTS` in `CarViewer.tsx` by owner listing ID and public slug, or supply its `hotspots` prop from trusted listing configuration. Calibrate normalized x/y coordinates on the real photograph and list only exact frame angles where the part is visible. Missing target photographs disable the marker. No generic coordinates are assumed across different cars. Backend persistence/editor support for seller-authored hotspots is not present.

The existing manifest provides front/rear interior photographs, not separate dashboard/steering/console galleries, captured part-transition sequences, or a panorama projection declaration. These require capture/schema extensions; this viewer does not fabricate them. Interior originals can be inspected fullscreen as real photographs.

Manual acceptance checks (not run by the implementation agent):

- Owner drafts require login; anonymous published galleries load; unpublished endpoints reject new requests.
- Rotate both directions across 0°, rapidly swipe on a slow connection and confirm the displayed label follows the decoded photo.
- Open inspection areas and return to the same exterior angle; check missing-photo labels.
- At 320/375/390/430px, test vertical page scroll, enable touch zoom, pinch, double tap, pan boundaries, reset and orientation changes on iOS and Android.
- Inspect an original, check actual-pixel zoom and download, close during loading, and retry after a network error.
- Confirm network traffic loads no originals before explicit inspection; confirm keyboard arrows, focus restoration, screen-reader labels and reduced-motion behavior.
- Test calibrated hotspot alignment after resize/zoom and verify every target and visibility angle.

From the repository root in PowerShell, run manually:

```powershell
Set-Location .\auto360-frontend
npm run build
npm run dev
```

No dependencies, migrations or cloud secrets were added. Build, device tests and deployment remain unverified.
