/* Package Smoke as a universal macOS app.
 *
 * The tricky part: we ship one ffmpeg and one ffprobe per architecture in
 * vendor/bin. Those are single-arch Mach-O files that appear, byte identical,
 * in both the arm64 and the x64 build. @electron/universal refuses to merge a
 * Mach-O it has not been told about, so they have to be declared through
 * x64ArchFiles. The CLI cannot express that, hence this script.
 *
 * The npm ffmpeg-static / ffprobe-static copies are excluded outright: they
 * would hit the same check and we never run them in a packaged build anyway.
 */
const packager = require('@electron/packager');
const path = require('path');

async function main() {
  const version = require('./package.json').version;

  const appPaths = await packager({
    dir: __dirname,
    name: 'Smoke',
    platform: 'darwin',
    arch: 'universal',
    out: path.join(__dirname, 'dist'),
    overwrite: true,
    appBundleId: 'com.sxv.smoke',
    appVersion: version,
    icon: path.join(__dirname, 'assets', 'icon.icns'),
    extendInfo: path.join(__dirname, 'build-extra.plist'),
    prune: true,
    ignore: [
      /^\/dist/,
      // the raw .env carries the account key; build-dmg.sh copies a trimmed one
      /^\/\.env$/,
      /^\/extension/,
      /\.log$/,
      /build-extra\.plist/,
      /^\/assets\/mark-source\.png/,
      /^\/assets\/Smoke\.iconset/,
      // we run vendor/bin instead; these would also break the universal merge
      /node_modules\/ffmpeg-static/,
      /node_modules\/ffprobe-static/,
    ],
    osxUniversal: {
      // identical in both builds by design, so take them as-is
      x64ArchFiles: '**/vendor/bin/*',
    },
  });

  console.log(appPaths[0]);
}

main().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
