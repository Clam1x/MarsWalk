// Convert the official global 16 px/degree MOLA image to a browser-friendly byte order.
// Sample values, positions and grid spacing are unchanged.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/import-global-routing.mjs path/to/megt90n000eb.img');
const source = await readFile(path);
const sourceHash = createHash('sha256').update(source).digest('hex');
if (source.length !== 5760 * 2880 * 2 || sourceHash !== 'd18d9b9ab8c5516d02e157dd2cde0f1d0d160c21940e953ba22391269a545e7b') throw new Error('Unexpected MOLA source image');
const output = Buffer.from(source);
output.swap16();
const sha256 = createHash('sha256').update(output).digest('hex');
const sourceUrl = 'https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg016/megt90n000eb.img';
const metadata = {
  schemaVersion: 1,
  id: 'mars-routing',
  title: 'All Mars · MOLA 16 px/° routing grid',
  width: 5760,
  height: 2880,
  bounds: {west: 0, east: 360, north: 90, south: -90},
  pixelsPerDegree: 16,
  routing: true,
  encoding: 'int16-le',
  elevationUnit: 'metre',
  radiusKm: 3396,
  noData: -32768,
  sha256,
  parts: [],
  source: {
    title: 'NASA / MGS MOLA MEGDR',
    url: sourceUrl,
    labelUrl: sourceUrl.replace('.img', '.lbl'),
    sha256: sourceHash,
    productVersion: '2.0',
    coordinateSystem: 'IAU2000 planetocentric, east-positive longitude',
    verticalDatum: 'GMM3 areoid',
    processing: 'Exact 16 px/degree global source samples; byte order swapped only. No spatial resampling.',
    note: 'Many bins without altimeter shots contain interpolated values. Grid spacing is not effective obstacle resolution.'
  }
};
const midpoint = output.length / 2;
for (const [file, bytes] of [
  ['mars-routing-north.bin', output.subarray(0, midpoint)],
  ['mars-routing-south.bin', output.subarray(midpoint)]
]) {
  await writeFile(`data/${file}`, bytes);
  metadata.parts.push({file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
}
await writeFile('data/mars-routing.json', JSON.stringify(metadata, null, 2) + '\n');
console.log(`Imported global MOLA: ${output.length} bytes, SHA-256 ${sha256}`);
