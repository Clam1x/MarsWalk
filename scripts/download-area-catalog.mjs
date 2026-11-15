// Download the official DTM footprint catalogue for the planet-scale preview.
// An explicit date range prevents the USGS API from emitting an empty-date cursor.
import {createWriteStream} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {once} from 'node:events';

const collections={ctx:'mro_ctx_controlled_usgs_dtms',hirise:'mro_hirise_socet_dtms'};
const source=process.argv[2],collection=collections[source];
if(!collection)throw new Error('Pass ctx or hirise');
await mkdir('work',{recursive:true});
const output=createWriteStream(`work/area-${source}.jsonl`);
const ids=new Set();
const url=new URL('https://stac.astrogeology.usgs.gov/api/search');
url.searchParams.set('collections',collection);
url.searchParams.set('limit','500');
url.searchParams.set('datetime','1900-01-01T00:00:00Z/2100-01-01T00:00:00Z');
// Keep properties in the API response: its pagination cursor needs datetime.
url.searchParams.set('fields','-assets,-links');
let next=url.toString(),page=0,expected;
while(next){
  let response,lastError;
  for(let attempt=0;attempt<5;attempt++){
    try{
      response=await fetch(next);
      if(!response.ok)throw new Error(`USGS catalogue returned ${response.status}`);
      break;
    }catch(error){lastError=error;await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)**2));}
  }
  if(!response?.ok)throw lastError;
  const body=await response.json();
  expected??=body.numberMatched;
  const lines=[];
  for(const item of body.features??[])if(item.id&&item.geometry&&!ids.has(item.id)){
    ids.add(item.id);lines.push(JSON.stringify({id:item.id,geometry:item.geometry}));
  }
  if(lines.length&&!output.write(lines.join('\n')+'\n'))await once(output,'drain');
  // USGS recursively re-encodes `fields` in its next link; retain only its cursor.
  const nextLink=body.links?.find(link=>link.rel==='next')?.href;
  if(nextLink){
    const cursor=new URL(nextLink).searchParams.get('next');
    if(!cursor)throw new Error('USGS pagination link has no cursor');
    const pageUrl=new URL(url);pageUrl.searchParams.set('next',cursor);
    next=pageUrl.toString();
  }else next=null;
  page++;
  if(page%10===0||!next)process.stdout.write(`${source}: ${ids.size}/${expected} products after ${page} pages\n`);
  if(page>1000)throw new Error('Unexpectedly many USGS catalogue pages');
}
output.end();await once(output,'finish');
if(ids.size!==expected)throw new Error(`Incomplete USGS catalogue: ${ids.size}/${expected}`);
process.stdout.write(`Downloaded all ${ids.size} ${source} footprints.\n`);
