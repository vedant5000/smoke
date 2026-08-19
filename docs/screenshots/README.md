# Screenshots and demos

These are composed, not captured.

Two reasons. Smoke marks its own windows as protected content, so macOS leaves
them out of every screen recorder and `screencapture` returns a frame with the
app missing. And pointing a camera at a real session would put somebody's actual
desktop, files and browser tabs into a public repo.

So the scripts here load the **real** renderer pages in headless Chrome with
`src/demo-bridge.js` standing in for Electron's preload bridge, laid over a
synthetic desktop drawn in `src/desktop.html`. Same markup, same CSS, same code
paths as the running app. Every number, window title and thumbnail is invented.

```bash
./docs/screenshots/shoot.sh          # the stills
python3 docs/screenshots/make-gif.py # the animated demo
```

Both need Google Chrome and Pillow (`python3 -m pip install Pillow`).

The bridge is injected into a **copy** of `renderer/` in a temp directory. The
shipping app never carries it.

## Stills

| File | What it shows |
| --- | --- |
| `hero.png` | Studio with a take loaded, over the mock desktop |
| `recorder.png` | The recorder panel and its source picker |
| `recording.png` | A take in progress: recording bar and camera bubble |
| `studio.png` | The editor close up |
| `publish.png` | The finished publish panel with share, embed and MP4 links |
| `setup.png` | The first run credential screen |

## Demo

| File | What it shows |
| --- | --- |
| `demo.gif` | Desktop, panel, countdown, recording, Studio, published link |

## Things that bite when regenerating these

- **Chrome enforces a minimum window width**, well above the 392px recorder
  panel. Screenshotting a narrow page directly lays it out wider and crops it,
  which is why every window is composed inside an iframe at its exact size in
  `src/compose.html` rather than shot on its own.
- **Virtual time outruns media.** Chrome's `--virtual-time-budget` races ahead
  of video decoding and seeking, so a real `<video>` in the Studio preview
  photographs as an empty frame. The bridge feeds Studio an `<img>` carrying the
  handful of video properties it touches, which decodes once and always draws.
- **A canvas `captureStream` never composites** under headless, so the camera
  bubble came out empty. The bridge paints the stand in as the video element's
  background instead, where the existing `clip-path` rounds it correctly.
- **The countdown runs to zero** long before the shot lands, because its
  `setInterval` fires on virtual time. The bridge neuters it so the number can
  be parked on 3, 2 or 1.
- **Unquoted `url()` in CSS ends at the first `)`.** The fake source thumbnails
  are base64 SVG data URIs for that reason; percent encoding leaves the
  parentheses of an `rgba()` colour intact and breaks the background image.

`src/avatar.html` is an illustrated stand in for the camera feed, deliberately
not a photograph of a real person.
