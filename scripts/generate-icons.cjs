// Rebuild resources/icons/icon.png, icon.ico and icon.icns from source.png.
//
// Cross-platform: Electron's nativeImage resizes, and the ICO/ICNS containers
// are written here (PNG payloads, no iconutil or ImageMagick). From the repo
// root, after npm ci:
//
//   npm run icons
//
// Commit the three generated files with source.png.
const { app, nativeImage } = require('electron');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'resources', 'icons');
const source = path.join(dir, 'source.png');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** [OSType, pixel size]. Retina types repeat the same pixel buffer. */
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32],
  ['icp6', 64],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
];

function writeIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  const entries = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

function icnsChunk(type, png) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 4, 'ascii');
  head.writeUInt32BE(8 + png.length, 4);
  return Buffer.concat([head, png]);
}

function writeIcns(images) {
  const body = Buffer.concat(images.map(({ type, png }) => icnsChunk(type, png)));
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

app.disableHardwareAcceleration();

app
  .whenReady()
  .then(async () => {
    const src = nativeImage.createFromPath(source);
    if (src.isEmpty()) throw new Error(`Could not read ${source}`);
    const png = (size) => src.resize({ width: size, height: size, quality: 'best' }).toPNG();
    const rendered = new Map([16, 24, 32, 48, 64, 128, 256, 512, 1024].map((s) => [s, png(s)]));
    for (const [size, buf] of rendered) {
      if (buf.length < 32) throw new Error(`Resize to ${size} produced an empty PNG`);
    }
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'icon.png'), rendered.get(1024));
    await writeFile(
      path.join(dir, 'icon.ico'),
      writeIco(ICO_SIZES.map((size) => ({ size, png: rendered.get(size) }))),
    );
    await writeFile(
      path.join(dir, 'icon.icns'),
      writeIcns(ICNS_TYPES.map(([type, size]) => ({ type, png: rendered.get(size) }))),
    );
    app.exit(0);
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  });
