# Setting Smoke up on your Mac

Smoke is a screen and camera recorder. It records, lets you edit, uploads to
your Bunny.net Stream library, and hands you a share link.

This guide gets it running from scratch. It takes about ten minutes, most of
which is waiting for downloads.

---

## Before you start

You need three things.

**A Mac.** Smoke is macOS only. Apple Silicon or Intel both work.

**Node.js.** Check by opening Terminal and running `node -v`. If you get a
version number you are fine. If you get "command not found", install it from
[nodejs.org](https://nodejs.org) (take the LTS option) or run
`brew install node` if you have Homebrew.

**A Bunny.net account** with a Stream video library. Free trial is fine.
You will paste two values from it in step 3.

---

## 1. Get the code

```bash
git clone https://github.com/vedant5000/smoke.git ~/Desktop/Smoke
cd ~/Desktop/Smoke
```

If `git clone` asks you to sign in, use your GitHub account. The repo is
private, so your account has to have been given access to it first.

---

## 2. Run the setup script

```bash
bash setup.sh
```

That is the whole install. It will:

- install the dependencies
- download ffmpeg and ffprobe (about 250MB, this is the slow part)
- create a local signing certificate
- build Smoke and put it in your Applications folder

The signing certificate is worth understanding, because it looks alarming and
is not. macOS ties Screen Recording permission to an app's signature. Without a
stable one, every rebuild looks like a brand new app to macOS and it throws
away the permission you granted, so you get asked again and again. The script
creates a self signed certificate that only ever signs this app. It is not
added to your system's trust store and it cannot vouch for anything else. You
can delete it any time from Keychain Access by searching "Smoke Local Signing".

---

## 3. Open Smoke and connect Bunny

Smoke lives in the **menubar**, not the Dock. Look for the mark up near the
clock. There is no Dock icon and no window until you click it.

On first launch it asks for two values:

- **Video library ID**, a number like `717099`
- **Stream API key**

Both are on one page. Go to [dash.bunny.net](https://dash.bunny.net), open
**Stream**, pick your video library, and open its **API** tab. Copy both from
there.

Use the library's own API key, not your account API key. They are different
things and the account key will be rejected.

Smoke checks the pair with Bunny before saving, so if something is wrong you
find out immediately rather than at the end of your first recording.

You can change these later from the menubar icon: right click, then
**Change Bunny credentials**.

### If you want your recordings in the same library as Vedant's

Use the library ID and key from his library instead of your own. Everything
else is identical. Ask him for them directly, and do not put them in a file
that gets committed.

---

## 4. Grant the macOS permissions

The first time you record, macOS asks for Screen Recording, Camera and
Microphone.

**Screen Recording needs one extra step that catches everyone out.** After you
grant it, you have to **quit Smoke and open it again**. macOS only applies that
particular permission when the app restarts. Until you do, the source list
comes up empty and the Start button stays disabled.

If it happens, that is what it is. Quit from the menubar icon, reopen, done.

Settings live at: System Settings > Privacy & Security > Screen & System Audio
Recording.

---

## Using it

Click the menubar mark to open the recorder panel.

- Pick a screen, a window, or drag out a region
- Camera bubble is draggable, scroll over it to resize
- Record, then Studio opens automatically for trimming, zooms, blurs, layouts
  and backgrounds
- Publish uploads to Bunny and copies the share link to your clipboard

Full feature detail is in `README.md`.

---

## After you change any code

```bash
bash build.sh
```

The app in your Applications folder is a frozen copy of the code. Editing files
does nothing until you rebuild. This trips people up constantly.

To run it straight from source without installing, use `npm run dev`, which
also pipes the app's console output into your terminal.

---

## When something goes wrong

**"Apple cannot check it for malicious software"**
Only applies to an app someone sent you, not one you built yourself. If you hit
it, run `xattr -dr com.apple.quarantine /Applications/Smoke.app`. On macOS 15
and later the old right click then Open trick no longer exists, so this command
is the fix.

**The source list is empty, Start is greyed out**
Screen Recording permission. Grant it, then quit and reopen Smoke. See step 4.

**The camera bubble is black**
Another app is holding your camera. Chrome, Slack, Zoom and Safari all grab it
and do not let go. Quit whichever one had it, then reopen Smoke.

**Publishing fails or hangs**
Check the credentials first: menubar icon, right click, Change Bunny
credentials. Re-enter them and Smoke will re-check them against Bunny.

**A rebuild lost the Screen Recording permission**
The signing certificate is missing. Run `bash make-signing-cert.sh`, then
`bash build.sh`, then grant the permission once more. It will stick after that.

**Everything is broken and you want to start over**
```bash
rm -rf node_modules vendor/bin
bash setup.sh
```
This does not touch your Bunny credentials, which live outside the project at
`~/Library/Application Support/smoke/.env`.
