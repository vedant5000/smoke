# Smoke

macOS menubar screen and camera recorder. Records, edits in a Studio window,
publishes to Bunny.net Stream, returns a share link. Electron, no build step
for the renderer, plain HTML/CSS/JS.

**`README.md` is the source of truth.** It documents every hard won gotcha in
this codebase. Read the relevant section before changing anything in that area,
because most of the non obvious code is non obvious for a recorded reason.

## Layout

| Path | What it is |
|---|---|
| `main/main.js` | app lifecycle, tray, all IPC handlers |
| `main/windows.js` | every BrowserWindow, content protection, camera bubble geometry |
| `main/config.js` | credentials, user settings, paths |
| `main/bunny.js` | Bunny Stream API: validate, create, upload, poll, links |
| `main/render.js` | ffmpeg composition, voice chain, waveform, segment rendering |
| `renderer/setup.html/.js` | first run credential screen |
| `renderer/control.html` | recorder panel, owns the MediaRecorder |
| `renderer/studio.html/.js` | editor: timeline, zooms, blurs, layouts, publish |
| `renderer/layouts.js` | shared by the canvas preview AND main/render.js |
| `preload/bridge.js` | the only renderer to main surface |
| `extension/` | Chrome MV3 extension for true single tab capture |

## Running it

```bash
npm run dev        # from source, content protection off, renderer console in terminal
npm run selftest   # records 6s, renders, publishes, prints the URL
bash build.sh      # package to /Applications/Smoke.app
bash setup.sh      # full first time install on a new Mac
```

**A packaged app is a frozen snapshot. Rerun `build.sh` after any code edit.**
Editing files and relaunching the installed app does nothing. This is the most
common way to waste twenty minutes here.

## Credentials

Never hardcode them and never commit them. The app asks on first launch and
saves to `~/Library/Application Support/smoke/.env`, which `config.js` reads
before anything else so a saved value always beats a bundled one.

`config.saveBunny()` writes that file and mutates the exported `bunny` object in
place. In place matters: `bunny.js` reads those properties at call time, so an
existing `require()` sees new credentials without a restart.

Only `BUNNY_LIBRARY_ID` and `BUNNY_STREAM_API_KEY` are required.
`BUNNY_CDN_HOSTNAME` is optional and discovered automatically from any video's
`thumbnailUrl`; it only enables the direct MP4/HLS/thumbnail links, so treat it
as nullable everywhere. `BUNNY_ACCOUNT_API_KEY` is never read at runtime and
must never be written into any bundle.

## Things that will bite you

- **Content protection must never be tied to `--dev`.** It was once, and the
  recording bar ended up inside real recordings. Only `--noprotect` disables it.
- **Never leave an HTTP call without a timeout.** A publish once hung for 12
  minutes at 0% CPU because a response never arrived.
- **The camera bubble is destroyed, never hidden.** A hidden one keeps holding
  the camera and strands itself in a corner.
- **ffmpeg's `gradients` filter deadlocks** when overlaid with a real video
  input. Bake to a cached PNG with `geq` instead.
- **`layouts.js` is shared** between preview and render so they cannot drift.
  Change it in one place only.
- Progress sent to a destroyed Studio window throws. Everything goes through
  `safeSend()`.

Full list, with the reasoning, is in `README.md`.
