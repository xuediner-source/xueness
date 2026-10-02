// Render the existing vector mark into Windows/macOS/browser assets.
// Optional argument: a folder containing node_modules/sharp.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireSharp = createRequire(resolve(process.argv[2] ?? root, 'package.json'));
const sharp = requireSharp('sharp');
const source = await readFile(resolve(root, 'webapp/public/xueness-icon.svg'));
const png = size => sharp(source, { density: 384 }).resize(size, size).png().toBuffer();
await writeFile(resolve(root, 'webapp/public/icon_512@2x.png'), await png(512));
await writeFile(resolve(root, 'webapp/public/apple-touch-icon.png'), await png(180));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(png));
const directory = Buffer.alloc(6 + 16 * sizes.length);
directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
sizes.forEach((size, index) => {
  const entry = 6 + 16 * index;
  directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(images[index].length, entry + 8); directory.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
});
await writeFile(resolve(root, 'webapp/public/favicon.ico'), Buffer.concat([directory, ...images]));
console.log('Rendered monochrome app icons at 16–512px.');
