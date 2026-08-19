# Smoke internals

How Smoke is put together, and every hard won detail behind it. If you are just
installing or using it, read the [README](../README.md) instead. This file is
for changing the code.

Screen and camera recorder that publishes straight to Bunny.net Stream and hands you the URL.
Loom's flow, Tella's editing, your own storage, Cue's design language.

It is a **separate app from Cue**. Cue (the notch notifier and teleprompter) is untouched and keeps
running on its own. The two talk over Cue's existing localhost listener, nothing more.

---

## What it does

**Pick exactly what gets recorded**
- Any screen, any window, picked from a Cue-styled grid with live thumbnails
- **Region select** — drag a box anywhere, macOS screenshot style, with thirds guides and a live pixel readout
- **A single Chrome tab** — via the companion extension, since only the browser itself can hand out a
  tab-only stream that follows scrolling and excludes every other window
- Camera on its own, or screen plus camera

**A camera bubble you actually move**
- Floating, always on top, draggable from anywhere on it, circle or rounded
- Hover anywhere over it for the controls: size, shape, mirror, resize, hide. Scroll over it to resize
  fluidly, or press and drag the resize button and the main process follows your cursor
- It only exists while the recorder panel is open or a take is running, and it is destroyed (not
  hidden) on quit, so it never strands itself in a corner holding your camera
- **Editable later** (default) — the bubble is hidden from the capture, recorded as its own track, and
  its position over time is logged so Studio can either replay the path you dragged or let you override it
- **Burn in live** — Loom style, baked in exactly where you put it

**Hide what should not be on camera**
- `Hide my cursor` removes the mouse pointer from the recording entirely
- Cue's teleprompter is content-protected, so it never appears in a capture. Combine the two and you can
  scroll your script mid-take with the mouse while the recording sees neither the panel nor the pointer.
- The Smoke control bar and countdown are content-protected too

**Studio, after the take**
- Trim, live canvas preview that mirrors the ffmpeg output exactly
- Camera layouts: bubble, side by side, full, off. Drag to reposition, slider to resize
- Zoom segments with eased in and out, aimed by clicking the preview
- **19 background presets** — 3 solids and 16 multi-stop diagonal gradients (Periwinkle, Nightfall,
  Violet Haze, Plum, Dusk, Ocean, Deep Sea, Aurora, Mint, Ember, Sunset, Mango, Rose, Steel, Graphite,
  Linen), plus padding and corner rounding. Edit or add your own in `renderer/backgrounds.js`; the
  picker, the canvas preview and the ffmpeg render all read that one list.
- Blur boxes over anything private
- Output at 1080p, 1440p, 720p, square or vertical

**Publish**
- Renders with ffmpeg, uploads to Bunny, waits for the encode, copies the share link
- Or save an MP4 locally instead

---

## Setup

On a Mac that has never had Smoke on it, one command does everything:

```bash
bash setup.sh
```

It installs dependencies, fetches the ffmpeg binaries, creates the local signing identity, and builds
the app into `/Applications`. See **SETUP.md** for the walkthrough written for someone installing it
for the first time.

To run from source instead:

```bash
npm install
bash vendor-binaries.sh
npm start
```

macOS will ask for **Screen Recording**, **Camera** and **Microphone** the first time. Screen Recording
needs a restart of the app after granting. In development the permission belongs to *Electron*; once
packaged it belongs to *Smoke*.

The tray icon is the entry point: **click** to open the recorder, **right click** for the menu.
Global shortcut: `Cmd+Shift+9`.

### Credentials

**Smoke asks for these on first launch.** There is nothing to configure by hand and nothing to copy
between machines. The setup screen takes a **library ID** and a **Stream API key**, both of which sit
on one page in the Bunny dashboard (Stream, your library, the API tab).

The pair is checked against Bunny *before* it is saved, so a wrong paste fails on the screen built to
explain it rather than at the end of someone's first recording. Change them later from the tray menu:
**Change Bunny credentials**.

Saved to `~/Library/Application Support/smoke/.env`, which is read **before** any bundled or
project-root `.env`, so what you entered always wins over a stale copy that happened to be packaged at
build time.

Only two values are required:

| Variable | Required | Notes |
| --- | --- | --- |
| `BUNNY_LIBRARY_ID` | yes | The number, e.g. `123456` |
| `BUNNY_STREAM_API_KEY` | yes | The **library's** key, not the account key |
| `BUNNY_CDN_HOSTNAME` | no | Discovered automatically, see below |
| `BUNNY_ACCOUNT_API_KEY` | never | Not read at runtime, must not ship anywhere |

The CDN hostname is optional because share and embed links run through `iframe.mediadelivery.net` and
only need the library ID. It is discovered from any existing video's `thumbnailUrl`, and for a library
too empty to have one, it is learned on the first publish. It only enables the direct MP4, HLS and
thumbnail links, so **treat it as nullable everywhere**; `urls()` returns `null` for those three rather
than building `https://undefined/...`.

A project-root `.env` still works and is handy in development. It is gitignored, and `build.sh` copies
it into your own bundle. `build-dmg.sh` does **not** bundle credentials unless you pass
`--with-credentials`, because a shared disk image is the easiest way to leak a key by accident.

Make a library dedicated to Smoke so nothing mixes with your other Bunny content. Theme its player to
the Cue accent and turn referrer blocking **off**, so links work when pasted into email, a funnel
builder, or anywhere else.

---

## Chrome extension (tab capture)

A native app can capture the Chrome *window* but not a single *tab*. This extension covers that case
and publishes to the same Bunny library.

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → choose `~/Desktop/Smoke/extension`
3. Open the popup → **Bunny settings** → paste library id, stream key and CDN hostname → Save

Then click the extension on any tab and hit record. Audio is routed back to your speakers while
capturing, so you still hear the tab.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run normally |
| `npm run dev` | Run with renderer logs piped to the terminal. Content protection stays **on** |
| `npm run dev -- --noprotect` | Also disable content protection, only for screenshotting the UI. Never record with this |
| `npm run selftest` | Records 6 seconds, renders with a zoom and gradient, publishes to Bunny, prints the URL, quits |

`npm run selftest -- --keepopen` records and leaves Studio open without publishing.

---

## How it is put together

```
main/
  main.js       app lifecycle, tray, IPC, display-media handler
  windows.js    every window, and which ones are content-protected
  capture       (in main.js) desktopCapturer + getDisplayMedia bridge
  render.js     ffmpeg filter graph: crop, zoom, layouts, masks, blur, background
  bunny.js      create video, streamed upload with progress, poll encode, build URLs
  config.js     .env loading and user settings
  selftest.js   end to end check
preload/bridge.js   the whole renderer API surface
renderer/
  cue.css       design tokens lifted from Cue
  control.html  recorder panel      engine.js  capture engine
  camera.html   floating bubble     region.html  region overlay
  recbar.html   recording bar       countdown.html
  studio.html   editor              studio.js  preview compositor
extension/      MV3 tab capture
```

### Things worth knowing before you change it

- **The control window keeps running while hidden.** It owns the MediaRecorder for the whole take;
  the floating bar just relays actions to it through main. Do not destroy it on hide.
- **Chunk writes must stay ordered and be drained before stopping.** Reading a Blob is async, so
  chunks can reach main out of order or after the file is closed. `engine.js` keeps a promise chain per
  recorder and `stop()` awaits it. Files are opened with the append flag as a second line of defence.
  Getting this wrong silently truncates recordings to the last chunk.
- **MediaRecorder WebM has no duration.** Every recording is stream-copy remuxed on stop, which is
  near instant and fixes both seeking and probing.
- **`color=` sources in ffmpeg are infinite.** Any overlay that uses one as its base needs `shortest=1`
  and the output needs an explicit `-t`, or the render never finishes. Every generated or `-loop 1`
  input is bounded with `-t` for the same reason.
- **Do not use ffmpeg's `gradients` filter.** It deadlocks the moment its output is overlaid with a real
  video input: no frames, no CPU, no error, forever. Bisected and confirmed. Gradients are baked to a
  cached PNG with `geq` instead (a few milliseconds) and fed in as a looped image, which is both
  reliable and much faster.
- **`zoompan` has no `t` variable**, it has `in_time`, and times are relative to the trimmed clip
  because `-ss` rebases timestamps.
- **`border-radius` does not clip a `<video>`**, because it is its own compositing layer. The camera
  bubble uses `clip-path`.
- **A shadow that reaches the edge of a transparent window is clipped into a hard rectangle.** The
  bubble keeps a 14px transparent margin (`CAM_MARGIN`) wider than the shadow can travel, and the
  window is sized to bubble + margin so the visible circle still matches the requested size.
- **Content protection is deliberately not tied to `--dev`.** It was, and it silently put the recording
  bar into real recordings. Only `--noprotect` disables it now.
- **`cursor: 'never'` works even though `getSettings()` reports `"always"`.** The metadata lies; the
  pixels do not. Verified by diffing captured frames.
- **`.seg` is a segmented control in `cue.css`.** Do not reuse that class name for anything positioned.

### The Cue integration

One additive route was added to `~/Desktop/Cue/main.js`:

```js
if (req.method === 'POST' && req.url === '/prompter') { showPrompter(); ... }
```

Nothing else in Cue changed. Backup of the source and the packaged app:
`~/Desktop/Cue-backup-20260730-203446`. After editing Cue you must run `bash ~/Desktop/Cue/build.sh`,
because `/Applications/Cue.app` is a frozen snapshot.

Smoke works fine if Cue is not installed; the teleprompter button just reports that it is not running.

---

## Packaging

```bash
bash build.sh
```

Packages `Smoke.app`, installs it to `/Applications`, drops an alias on the Desktop, and restarts it.
**A packaged app is a frozen snapshot, so code edits do nothing until you rerun this.**

The build strips `ffprobe-static`'s Linux and Windows binaries (~335MB of dead weight) and copies
`.env` into the bundle so credentials travel with the app but never with the repo.

Icons are generated from `assets/mark-source.png`:

```bash
bash assets/make-icons.sh
```

That produces `icon.icns` (cream rounded tile, black mark, transparent corners) and the menubar
template pair. Menubar icons must be a black shape plus alpha; macOS tints them for light and dark.

Two ffmpeg alpha traps worth remembering: `overlay` flattens the alpha of its base, so the rounded
corners are applied with `alphamerge` **after** compositing, and the PNG must be written with
`-pix_fmt rgba` or the transparent surround bakes to opaque black.

### Camera behaviour, in one place

| Where | What you can do |
| --- | --- |
| On screen, before or during a take | Drag it anywhere, scroll to resize, hover for size / shape / mirror / hide |
| In Studio, after the take | Switch layout (Bubble, Side by side, Full, Off), circle or rounded, drag to reposition, resize with the slider, or replay the exact path you dragged it along while recording |

In the default **Editable later** mode the bubble is hidden from the capture and recorded as its own
track, which is what makes all of the Studio options possible. **Burn in live** bakes it in where you
put it and gives up that flexibility in exchange for a faster publish.

### Screen Recording permission keeps coming back

macOS ties Screen Recording permission to an app's **code signature**. An ad-hoc signature is derived
from the app's contents, so every rebuild produces a different one, macOS decides it is a different
app, and the grant you just gave is discarded. That is why it can reappear after four rebuilds in a row.

The fix is a stable local signing identity, created once:

```bash
bash make-signing-cert.sh
bash build.sh
```

`build.sh` then signs inside out (helpers and frameworks first, then the bundle) with that identity,
which produces a designated requirement of `identifier "com.sxv.smoke" and certificate leaf = H"..."`.
Neither half changes on rebuild, so the permission sticks. Verify with:

```bash
codesign -d -r- /Applications/Smoke.app     # should not mention cdhash
```

The certificate is self-signed, `CA:false`, and deliberately **not** added to the system trust store,
so it can sign this app and nothing else. Delete "Smoke Local Signing" in Keychain Access to remove it.
If the identity is missing, `build.sh` falls back to ad-hoc and warns you.

To clear stale entries from earlier ad-hoc builds: `tccutil reset ScreenCapture com.sxv.smoke`.

### Studio window

It is frameless, so it carries its own controls in the title bar: minimise, close, and `Cmd+W`.
Closing **destroys** the window rather than hiding it, so the next take opens a clean editor. Reusing
it meant the previous take's trim, zooms, blurs and background bled into the next recording.

Once a publish finishes, the overlay's button becomes **Done, close Studio**, because at that point
dismissing the overlay back to an editor you are finished with is not what you want. Closing while a
render or upload is still running asks first.

Any progress callback that reaches a closed window goes through `safeSend()`, which checks
`isDestroyed()` first. Without it, closing Studio mid-render threw "Object has been destroyed" and
Electron showed a JavaScript error dialog. There are also `uncaughtException` / `unhandledRejection`
handlers so nothing else surfaces that dialog to you.

### If the camera bubble is black

Another app is holding the camera and handing back a stream that looks healthy (correct resolution,
frames arriving) where every pixel is black. Smoke samples the actual picture every 1.5s and shows
**"Camera is black - another app is probably using it"** rather than recording a black disc and
letting you find out afterwards. Quit whatever else has the camera (Brave, Slack, Safari and Chrome
all grab it) and it recovers on its own.

## Layouts, framing and crop

Both layers are just a **rect on the canvas plus an optional crop of their own source**. A layout
preset only sets those rects, which is why you can keep dragging and resizing afterwards without
leaving the preset. `renderer/layouts.js` holds the presets and the rect maths, and both the canvas
preview and the ffmpeg render resolve through it, so they cannot drift apart.

**Presets** (Layout tab): Screen only, Camera bubble (right or left), Side by side (either side),
Overlap, TV presenter, TV inset, Camera only. Camera size S/M/L rescales free-floating cameras around
their own centre; a side or TV panel is meant to fill, so it ignores the size.

**Direct manipulation**: click either layer on the preview to select it, then drag to move or pull one
of the eight handles to resize. A circular camera keeps itself square while you resize.

**Crop**:
- **Crop screen** trims the screen recording after the fact. It composes with the region you may have
  picked before recording, since both are normalised against the source.
- **Reframe camera** crops the camera source, which is how you tighten onto your face or make a wide
  webcam into a portrait panel.

Both have a reset button once set, and the camera keeps covering its rect afterwards, so cropping
reframes rather than letterboxes.

Add your own preset by appending to `LAYOUTS` in `renderer/layouts.js` — the picker, the preview and
the renderer all pick it up with no further changes.

## Backgrounds

31 presets in one picker: 3 solids, 16 linear gradients, and 12 **mesh gradients**. A mesh blends
several colour points by inverse-distance weighting, which reads much softer than a straight ramp.
The identical weighting runs in the preview (computed small and scaled up) and in the bake, so a mesh
looks the same in Studio as it does in the finished file.

Padding insets both layers; **Corners** rounds the screen plate and is stored as a fraction of the
canvas width, so a setting looks the same at 720p and 1440p. There are Square / Rounded / Soft presets
next to the slider. The old slider topped out at 48px on a 1920 canvas, a 2.5% corner, which is why it
looked like it did nothing.

## Hiding things

The Blur tab has three styles and a strength slider:

| Style | What it does |
| --- | --- |
| Blur | Repeated box blur. Radius scales with the region and the strength setting |
| Pixelate | Downsamples to blocks and scales back with nearest neighbour |
| Solid | Fills the region flat |

Strength matters: the original fixed radius only softened text rather than removing it. Verified
against a 16px grid, every style at default strength leaves nothing recoverable. For genuinely
sensitive material prefer **Pixelate** or **Solid**, because a blur can sometimes be reversed.

In the preview the region is copied to an offscreen buffer before the effect is applied, so it cannot
sample its own surroundings. Filtering the canvas onto itself was what left a soft, still-readable edge.

## Giving Smoke to someone else

```bash
bash vendor-binaries.sh    # once: fetch both ffmpeg/ffprobe architectures
bash build-dmg.sh          # produces dist/Smoke-<version>.dmg
```

The DMG holds a **universal** app that runs on Apple Silicon and Intel. Both binary slices ship in
`vendor/bin` and `main/render.js` picks the matching one from `process.arch` at runtime, which also
does the right thing under Rosetta.

Three things the recipient needs to know, and the disk image says so in a READ ME FIRST:

1. **Gatekeeper will refuse the first launch**, saying "Apple cannot check it for malicious software".
   The app is signed with a private certificate rather than through Apple's paid developer programme.

   **On macOS 15 and later the right click then Open trick no longer works** and that dialog has no
   "Open Anyway" button. The reliable fix is to strip the quarantine flag, which is what actually
   blocks it:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Smoke.app
   ```

   Verified end to end: a freshly quarantined copy is rejected by `spctl`, and after that command it
   launches normally with its signature still valid. The only way to remove this step entirely is
   notarisation, which needs a paid Apple Developer account.
2. **It is a menubar app**, with no Dock icon.
3. **Screen Recording needs a restart** after being granted.

The DMG carries the Bunny **library id, stream key and CDN hostname**, so it records and publishes
with no setup. Anything recorded on the other Mac uploads into this same library.

`build-dmg.sh` copies only those three lines. The **account key is deliberately stripped**: it can
create and delete entire video libraries, the app never reads it, and it has no business leaving this
machine. The raw `.env` is also excluded from packaging so it cannot ride along a second time.

The stream key is still a real credential, so send the file directly to the person who should have it
rather than putting it anywhere public. To ship without any key, delete `.env` before building; the app
then reports Bunny as not configured.

## Audio

The microphone is recorded to its own file (`mic.webm`), separate from system audio. Mixing them at
capture made it impossible to clean up the voice later without also gating and compressing whatever
music or video was playing.

**Capture is deliberately raw.** Chrome's `echoCancellation`, `noiseSuppression` and `autoGainControl`
are tuned for phone calls: they band-limit toward telephony bandwidth and dull consonants, which is
what made early recordings sound muffled. All three are off, and audio is captured at 192kbps.
Echo cancellation remains available as an opt-in for anyone recording on speakers, where it is the only
thing stopping the mic re-recording the system audio.

Cleanup happens at export, in the **Audio** tab:

| Setting | What it does |
| --- | --- |
| Off | The microphone exactly as recorded |
| Clean up | Highpass, lowpass, FFT denoise, gentle compression, loudness normalisation |
| Studio | The above plus a noise gate that removes breathing between phrases, stronger compression, de-essing and a presence lift |

Measured on a test take, isolated from system audio:

| | speech | gap between phrases | separation |
| --- | --- | --- | --- |
| off | −27.1 dB | −53.3 dB | 26 dB |
| clean | −7.9 dB | −40.2 dB | 32 dB |
| studio | −7.2 dB | −62.3 dB | **55 dB** |

Studio lifts the voice 20 dB while pushing the gaps down 9 dB, which is what removes breathing.
Voice and system levels are separate sliders and are mirrored in the preview, though the cleanup chain
itself only runs at export.

## Timeline

The recording is a list of **segments** in source time. One segment is a plain trim; more than one
means something was cut out of the middle.

- **Waveform** is extracted once per recording by decoding the audio to 8kHz mono and reducing it to
  peak pairs. Far cheaper than decoding in the renderer.
- **Zoom** from 100% to 6000%, anchored on the cursor. Scroll to move along the timeline, Cmd-scroll
  to zoom. The ruler picks a sensible tick interval for the visible span.
- **Split** (`S`) divides the piece under the playhead. **Remove** (`Delete`) deletes the selected
  piece. Removed regions show as hatched gaps, and playback skips them, so the preview matches the
  export without rendering anything.
- Export renders each surviving segment through the full composite and concatenates them with a stream
  copy. Verified: 8s with 3s removed produces 5.02s.
