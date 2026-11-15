import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { imageryLayers, tileUrl, visibleTiles } from '../src/imagery.js';

// Rebuild a planet-wide offline overview. Higher zoom tiles load on demand.
const selections = { viking: [0,1,2], ctx: [0,1,2], hirise: [0,1,2] };
const queue = [];
for (const [layer, levels] of Object.entries(selections)) {
  const bounds = imageryLayers[layer].coverage;
  for (const zoom of levels) queue.push(...visibleTiles(layer,bounds,{x:0,y:0,w:1000,h:1000},{width:1000,height:1000},zoom).map(tile=>({layer,...tile})));
}
await rm(join('data','imagery'),{recursive:true,force:true});
const files = {};
let cursor = 0;
async function worker() {
  while (cursor < queue.length) {
    const tile = queue[cursor++], spec = imageryLayers[tile.layer];
    let saved = false;
    for (let attempt=0;attempt<3&&!saved;attempt++) {
      try {
        const response = await fetch(tileUrl(tile.layer,tile.zoom,tile.row,tile.col),{signal:AbortSignal.timeout(30000)});
        if (response.status===404) break;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const ext=bytes[0]===0xff&&bytes[1]===0xd8?'jpg':bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47?'png':null;
        if (!ext) throw new Error('Unexpected image data');
        const name=`${tile.key}.${ext}`,path=join('data','imagery',name);
        await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);files[tile.key]=name;saved=true;
      } catch(error) { if(attempt===2) console.warn(`${tile.key}: ${error.message}`); }
    }
  }
}
await Promise.all(Array.from({length:6},worker));
const sources={
  viking:{title:'NASA Mars Trek Viking VIS global color mosaic',url:'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/WMTSCapabilities.xml'},
  ctx:{title:'Caltech Murray Lab Global CTX Mosaic V01, served by Esri',url:'https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer?f=pjson'},
  hirise:{title:'NASA HiRISE sparse global image mosaic, served by Esri',url:'https://astro.arcgis.com/arcgis/rest/services/OnMars/HiRISE/MapServer?f=pjson'}
};
for(const [key,layer] of Object.entries(imageryLayers)){sources[key].coverage=layer.coverage;sources[key].nativeResolution=layer.nativeResolution;}
await writeFile('data/imagery-index.json',JSON.stringify({schemaVersion:1,files:Object.fromEntries(Object.entries(files).sort()),sources},null,2)+'\n');
console.log(`Saved ${Object.keys(files).length}/${queue.length} global imagery overview tiles`);
