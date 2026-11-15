import { gridToMarsCoordinate } from './terrain.js';
import { loadNasaTerrain } from './nasa-adapter.js';
import { TerrainMap, places } from './map-view.js';
import { parseCoordinates } from './camera.js';
import { drawProfile } from './profile.js';
import { imageryLayers } from './imagery.js';
import { niceScaleBar } from './scale.js';
import { loadCoverage } from './blend-dem.js';
import { planEVA } from './eva-plan.js';
import { estimateTravelTime } from './travel-time.js';
import { evaluateMissionConditions } from './mars-environment.js';
import { suggestScienceStops } from './science-stops.js';
import { GEOLOGY_SOURCE, geologyAt, suggestGlobalScienceTargets } from './science-targets.js';

const $ = selector => document.querySelector(selector);
const format = point => `${Math.abs(point.lat).toFixed(3)}°${point.lat < 0 ? 'S' : 'N'} · ${point.lon.toFixed(3)}°E`;
const sourceLabel = source => ({hrsc:'HRSC footprint',mola:'MOLA base',ctx:'CTX stereo DTM',hirise:'HiRISE stereo DTM',unverified:'Unverified elevation'})[source]??'Unknown source';
let overview = null, start = null, goal = null, analysis = null, pick = null, worker = null, workerBusy = false, requestId = 0, routePoints = [], routeSegments = [];
let evaStops = [], evaRouteWarning = '', evaMode='standard', evaHazards=[], scienceStopsMessage='No additional mapped science stops yet.';
let scienceTargets=[], selectedScienceTarget=null;
let geologyHoverTimer=null,geologyHoverSerial=0;
const evaDuration = hours => {const minutes=Math.round(hours*60);return `${Math.floor(minutes/60)}h ${(minutes%60).toString().padStart(2,'0')}m`;};

function renderEVA() {
  const stopHost=$('#evaStops');stopHost.replaceChildren();
  for(const stop of [...evaStops].sort((a,b)=>a.distanceKm-b.distanceKm)){
    const row=document.createElement('div');row.className='eva-stop';
    const detail=document.createElement('span');detail.textContent=`${stop.proposed?'Suggested: ':''}${stop.objective} · ${stop.distanceKm.toFixed(2)} km · ${stop.minutes} min · ${format(stop.point)}${stop.reason?` · ${stop.reason}`:''}`;
    const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.setAttribute('aria-label',`Remove ${stop.objective}`);
    remove.addEventListener('click',()=>{evaStops=evaStops.filter(item=>item!==stop);renderEVA();});
    row.append(detail,remove);stopHost.append(row);
  }
  if(!evaStops.length){const note=document.createElement('p');note.className='note';note.textContent=scienceStopsMessage;stopHost.append(note);}
  const output=$('#evaResult');output.replaceChildren();
  if(!analysis){output.textContent='Calculate a route to estimate walking time and mission conditions.';output.dataset.status='empty';return;}
  for(const id of ['evaSpeed','evaSlowdown','evaReserve','evaDeparture','evaOxygen','evaPower','evaWater','evaLimit','evaTargetMinutes',
    'evaTempMin','evaTempMax','evaSuitTempMin','evaSuitTempMax','evaRadRate','evaDoseLimit','evaWind','evaWindLimit','evaDust','evaDustLimit',
    'evaRadioRange','evaBaseAntenna','evaSuitAntenna'])if(!$('#'+id).checkValidity()){
    output.textContent='Correct the highlighted planning input to recalculate.';output.dataset.status='over';return;
  }
  const budgets={oxygen:$('#evaOxygen').value,power:$('#evaPower').value,coolingWater:$('#evaWater').value,evaLimit:$('#evaLimit').value};
  let plan,travel,environment;
  const stops=evaMode==='science'?[...evaStops,{objective:$('#evaTargetObjective').value.trim()||'Science target B',
    minutes:Number($('#evaTargetMinutes').value),distanceKm:analysis.distanceKm,point:routePoints.at(-1)}]:[];
  try{
    travel=estimateTravelTime(analysis,Number($('#evaSpeed').value),{slowdownAt12Deg:Number($('#evaSlowdown').value)/100});
    plan=planEVA({distanceKm:analysis.distanceKm,speedKmh:Number($('#evaSpeed').value),returnToStart:$('#evaReturn').checked,
      stops,budgets,reservePercent:Number($('#evaReserve').value),travelProfile:travel});
    const departure=$('#evaDeparture').value;
    environment=evaluateMissionConditions({startUTC:departure?`${departure}Z`:'',points:routePoints,travelProfile:travel,
      stops,returnToStart:$('#evaReturn').checked,totalHours:plan.totalHours,
      temperatureMin:$('#evaTempMin').value,temperatureMax:$('#evaTempMax').value,
      suitTemperatureMin:$('#evaSuitTempMin').value,suitTemperatureMax:$('#evaSuitTempMax').value,
      radiationRate:$('#evaRadRate').value,doseLimit:$('#evaDoseLimit').value,
      windSpeed:$('#evaWind').value,windLimit:$('#evaWindLimit').value,dustTau:$('#evaDust').value,dustLimit:$('#evaDustLimit').value,
      radioRangeKm:$('#evaRadioRange').value,baseAntennaM:$('#evaBaseAntenna').value,suitAntennaM:$('#evaSuitAntenna').value});
  }
  catch(error){output.textContent=error.message;output.dataset.status='over';return;}
  const resourceNames={oxygen:'Oxygen',power:'Suit power',coolingWater:'Cooling water',evaLimit:'EVA time limit'};
  const entries=Object.entries(plan.resources);
  const exceeded=entries.filter(([,value])=>value.status==='over').map(([name])=>resourceNames[name]);
  const unknown=entries.filter(([,value])=>value.status==='unknown').map(([name])=>resourceNames[name]);
  const conditionExceeded=['temperature','radiation','weather'].filter(name=>environment[name].status==='over');
  if(environment.communications.status==='geometry_over')conditionExceeded.push('direct radio range');
  const conditionsUnknown=['temperature','radiation','weather'].some(name=>environment[name].status==='unknown')||
    environment.communications.status!=='geometry_over';
  output.dataset.status=exceeded.length||conditionExceeded.length?'over':unknown.length||conditionsUnknown?'unknown':'within';
  const title=document.createElement('strong');title.textContent=exceeded.length||conditionExceeded.length?
    `Review exceeded assumptions: ${[...exceeded,...conditionExceeded].join(', ')}`:unknown.length?'Planning inputs incomplete':'Entered limits have margin; mission conditions remain unverified';
  const timing=document.createElement('p');timing.textContent=`${evaMode==='science'?'Science expedition':'Standard walk'} · outbound ${evaDuration(plan.walkHours)} · work ${evaDuration(plan.workHours)} · return ${evaDuration(plan.returnHours)} · total ${evaDuration(plan.totalHours)}. Slope-adjusted from ${Number($('#evaSpeed').value).toFixed(1)} km/h base speed; up to ${travel.maxFactor.toFixed(1)}× slower on measured grades${travel.unknownKm?`; ${travel.unknownKm.toFixed(2)} km has unknown terrain slowdown`:''}.`;
  const resources=document.createElement('p');resources.textContent=entries.map(([name,value])=>`${resourceNames[name]}: ${value.status==='unknown'?'not entered':`${value.remainingHours<0?'short by':'reserve-adjusted margin'} ${evaDuration(Math.abs(value.remainingHours))}`}`).join(' · ')+'.';
  output.append(title,timing,resources);
  if(plan.itinerary.length){const schedule=document.createElement('ol');for(const stop of plan.itinerary){const item=document.createElement('li');item.textContent=`${stop.objective}: arrive ≈${evaDuration(stop.arrivalHours)} after departure; work ${stop.minutes} min.`;schedule.append(item);}output.append(schedule);}
  const conditions=document.createElement('div');conditions.className='eva-condition-results';
  const lines=[
    `Sunlight (Mars24 geometry): minimum sampled solar elevation ${environment.sunlight.minimumElevationDeg.toFixed(1)}°; approximately ${evaDuration(environment.sunlight.darkHours)} of walk/work in geometric darkness. Terrain shadows and dust are excluded.`,
    `Temperature: ${environment.temperature.status==='unknown'?'no complete site forecast and suit limits entered':`${environment.temperature.range.join(' to ')} °C forecast versus ${environment.temperature.limits.join(' to ')} °C suit limits — ${environment.temperature.status}`}.`,
    `Radiation: ${environment.radiation.doseMsv===null?'dose rate not entered':`${environment.radiation.doseMsv.toFixed(2)} mSv from entered constant rate${environment.radiation.limitMsv===null?'; no mission limit entered':` versus ${environment.radiation.limitMsv.toFixed(2)} mSv limit — ${environment.radiation.status}`}`}.`,
    `Weather: ${environment.weather.status==='unknown'?'wind and dust forecast or mission limits missing':`entered wind ${environment.weather.wind} m/s and dust τ ${environment.weather.dust} — ${environment.weather.status}`}.`,
    `Communications: farthest point ${environment.communications.maxBaseDistanceKm.toFixed(2)} km from A; ${environment.communications.directRangeKm===null?'enter radio range and antenna heights for a geometric check':`curvature/hardware direct range ${environment.communications.directRangeKm.toFixed(2)} km — ${environment.communications.status==='geometry_over'?'outside range':'within geometric range'}`}. Terrain blockage and orbiter access remain unknown.`
  ];
  for(const line of lines){const paragraph=document.createElement('p');paragraph.textContent=line;conditions.append(paragraph);}output.append(conditions);
  const warning=document.createElement('p');warning.className='eva-warning';warning.textContent=`Route evidence: ${evaRouteWarning} ${evaMode==='science'?'Mapped targets and unit contacts are regional-scale proposals; confirm their position and route hazards in higher-resolution data. ':''}This worksheet does not approve an EVA.`;output.append(warning);
}

function renderScienceTargets(message='') {
  const host=$('#scienceTargets');host.replaceChildren();
  if(message){const note=document.createElement('p');note.className='note';note.textContent=message;host.append(note);}
  for(const [index,target] of scienceTargets.entries()){
    const button=document.createElement('button');button.type='button';
    button.setAttribute('aria-pressed',String(selectedScienceTarget===target));
    button.textContent=`${index+1}. ${target.objective} · ${target.distanceKm.toFixed(1)} km from A`;
    const detail=document.createElement('small');detail.textContent=`${target.reason} · ${format(target.point)} · ${target.source}. Route length may be longer.`;
    button.append(detail);
    button.addEventListener('click',()=>selectScienceTarget(target));host.append(button);
    if(target.reference){const reference=document.createElement('a');reference.href=target.reference;reference.target='_blank';reference.rel='noreferrer';reference.textContent='Source feature ↗';host.append(reference);}
  }
  if(scienceTargets.length){const link=document.createElement('a');link.href=GEOLOGY_SOURCE;link.target='_blank';link.rel='noreferrer';link.textContent='USGS global geology (SIM 3292) ↗';host.append(link);}
}

function selectScienceTarget(target){
  if(!start||!overview)return;
  selectedScienceTarget=target;
  goal=target.point;
  $('#evaTargetObjective').value=target.objective.slice(0,80);
  setPick(null);
  invalidate();
  setEVAMode('science');
  renderScienceTargets('Selected target B. Calculating the terrain route; this may take time.');
  calculate(false);
}

async function planScienceFromA(){
  if(!start||!overview)return;
  const base=start,version=requestId;
  $('#sciencePlanFromA').disabled=true;
  renderScienceTargets('Searching the global geologic map around A and sampling nearby terrain…');
  try{
    const result=await suggestGlobalScienceTargets(base,overview);
    if(base!==start||version!==requestId)return;
    scienceTargets=result.targets;
    if(!scienceTargets.length){renderScienceTargets('No mapped science target found in the queried sources within about 6 km of A. Choose B manually or move A.');return;}
    selectScienceTarget(scienceTargets[0]);
  }catch(error){
    if(base!==start||version!==requestId)return;
    renderScienceTargets(`Could not find targets: ${error.message}`);
    notice('Science target search failed. Try again or choose B manually.',true);
  }finally{$('#sciencePlanFromA').disabled=!overview||!start;}
}

function updateEVASections(){
  const select=$('#evaSection');select.replaceChildren();
  for(const [index,segment] of routeSegments.entries()){
    const option=document.createElement('option');option.value=String(index);option.textContent=`${index+1}. ${sourceLabel(segment.source)} · ${segment.distanceKm.toFixed(2)} km · ${segment.evidence?.status==='checked'?'data checked':'uncertain'}`;select.append(option);
  }
  select.disabled=!routeSegments.length;$('#evaAddStop').disabled=!routeSegments.length;$('#evaSuggestStops').disabled=!routeSegments.length;
}

async function generateScienceStops(){
  if(!analysis||!routePoints.length)return;
  const version=requestId;
  scienceStopsMessage='Checking mapped geologic units along the route…';renderEVA();
  const radians=Math.PI/180;
  let suggestions;
  try{suggestions=await suggestScienceStops(analysis,routePoints,routeSegments);}
  catch(error){if(version!==requestId)return;scienceStopsMessage='Geologic map unavailable; no automatic science stop proposed.';renderEVA();return;}
  if(version!==requestId)return;
  evaStops=[...evaStops.filter(stop=>!stop.proposed),...suggestions.filter(stop=>!evaHazards.some(hazard=>{
    const dLat=(stop.point.lat-hazard.lat)*radians,dLon=(stop.point.lon-hazard.lon)*radians;
    const h=Math.sin(dLat/2)**2+Math.cos(stop.point.lat*radians)*Math.cos(hazard.lat*radians)*Math.sin(dLon/2)**2;
    return 2*3396.19*Math.asin(Math.sqrt(Math.max(0,Math.min(1,h))))<(hazard.radiusM+200)/1000;
  }))];
  scienceStopsMessage='No mapped unit transition along this route; no extra science stop proposed.';
  renderEVA();
}

function setEVAMode(mode){
  evaMode=mode;
  $('#evaStandard').setAttribute('aria-pressed',String(mode==='standard'));
  $('#evaScience').setAttribute('aria-pressed',String(mode==='science'));
  $('#scienceControls').hidden=mode!=='science';
  $('#evaReturn').checked=mode==='science';
  $('#evaModeHint').textContent=mode==='science'?
    'Set A, then find global science targets automatically. MarsWalk chooses B and checks a route; you can select another target or set B manually.':
    'Estimate travel from A to B. Enter your mission limits and forecast; blanks remain unknown.';
  if(mode==='science'&&analysis&&!evaStops.length)generateScienceStops();
  else renderEVA();
}

function notice(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
}

const map = new TerrainMap($('#terrainCanvas'), {
  select(node, event, coordinate) {
    if (!overview || node === null || !coordinate) return;
    if (!Number.isFinite(overview.elevation[node])) {
      notice('No overview elevation at this point. Choose another location.', true);
      return;
    }
    setPoint(event.shiftKey ? 'goal' : pick || (start ? 'goal' : 'start'), coordinate);
  },
  hover(node, position) {
    const tip = $('#mapTooltip');
    if (node === null || !overview) {
      clearTimeout(geologyHoverTimer);geologyHoverSerial++;
      tip.hidden = true;
      $('#mapPosition').textContent = 'Drag to pan · scroll or use +/− to zoom';
      return;
    }
    const coordinate = map.coordinateAt(position) || gridToMarsCoordinate(node % overview.width, Math.floor(node / overview.width), overview);
    const transition = map.transitionAt(position);
    const area = map.areaAt(coordinate);
    tip.hidden = false;
    tip.style.left = `${Math.max(5, Math.min(position.x + 12, map.camera.width - 265))}px`;
    tip.style.top = `${Math.max(5, position.y - 40)}px`;
    if(map.layer==='geology'){
      tip.textContent=`${format(coordinate)} · checking mapped unit…`;
      $('#mapPosition').textContent=format(coordinate);
      clearTimeout(geologyHoverTimer);
      const serial=++geologyHoverSerial;
      geologyHoverTimer=setTimeout(async()=>{
        try{
          const unit=await geologyAt(coordinate);
          if(serial!==geologyHoverSerial||map.layer!=='geology')return;
          const detail=unit?`${unit.unit} · ${unit.description}`:'No mapped unit at this location';
          tip.textContent=`${format(coordinate)} · ${detail}`;
          $('#geologyAtCursor').textContent=detail;
        }catch(error){
          if(serial!==geologyHoverSerial||map.layer!=='geology')return;
          tip.textContent=`${format(coordinate)} · geologic unit lookup unavailable`;
          $('#geologyAtCursor').textContent='Unit lookup unavailable; the published color map remains visible.';
        }
      },220);
      return;
    }
    tip.textContent = transition ? `${format(transition.point)} · Route enters ${sourceLabel(transition.source)}` :
      area ? `${format(coordinate)} · ${sourceLabel(area.source)} footprint · ${Number.isFinite(area.gsd)?`${area.gsd} m nominal grid · `:''}${area.id} · DTM cells may contain gaps` :
      `${format(coordinate)} · MOLA overview ${Number.isFinite(overview.elevation[node]) ? Math.round(overview.elevation[node]) + ' m' : 'no data'}`;
    $('#mapPosition').textContent = format(coordinate);
  },
  changed({zoom, maxZoom, scaleKm, imagery, areaStatus}) {
    $('#zoomLabel').textContent = `View ${zoom.toFixed(1)}×`;
    const bar = niceScaleBar(scaleKm);
    $('#scale').textContent = bar.label;
    $('#scale').style.width = `${bar.widthPx}px`;
    $('#zoomIn').disabled = zoom >= maxZoom;
    $('#zoomOut').disabled = zoom <= 1;
    $('#areaStatus').textContent = areaStatus;
    $('#coverageFilter').disabled=map.layer==='geology';
    $('#mapLabels').disabled=map.layer==='geology';
    $('#geologyInfo').hidden=map.layer!=='geology';
    if(map.layer==='geology'){
      $('#imageryInfo').textContent=`USGS SIM 3292 global geology · ${imagery?.ready??0}/${imagery?.total??0} map tiles loaded${imagery?.failed?` · ${imagery.failed} unavailable`:''}. Regional map at 1:20,000,000; route heights remain numeric DEMs.`;
      $('#opacityControl').hidden=false;
      $('#opacityLabel').textContent='Geology opacity';
      $('#imageryOpacity').value=Math.round(map.imageryOpacity.geology*100);
      $('#opacityValue').textContent=`${$('#imageryOpacity').value}%`;
    }else if (imagery) {
      const spec = imageryLayers[map.layer];
      const current = imagery.pixelKm >= 1 ? `${imagery.pixelKm.toFixed(1)} km` : imagery.pixelKm >= .001 ? `${Math.round(imagery.pixelKm * 1000)} m` : `${Math.round(imagery.pixelKm * 100000) / 100} cm`;
      $('#imageryInfo').textContent = `${spec.label}${map.layer === 'hirise' ? ' over Viking' : map.layer==='ctx'?' · independent image base':''} · ${imagery.ready}/${imagery.total} detail tiles${imagery.failed ? ` · ${imagery.failed} unavailable` : ''} · display sampling ≈${current}/px · source ${spec.nativeResolution}. Route heights use numeric DEMs.`;
      $('#opacityControl').hidden = map.layer === 'viking';
      $('#opacityLabel').textContent='Image opacity';
      $('#imageryOpacity').value = Math.round((map.imageryOpacity[map.layer] ?? 1) * 100);
      $('#opacityValue').textContent = `${$('#imageryOpacity').value}%`;
    } else {
      $('#imageryInfo').textContent = 'MOLA overview is bundled. Route calculations load USGS HRSC/MOLA numeric heights for the corridor.';
      $('#opacityControl').hidden = true;
    }
  }
});

function setPick(value) {
  pick = value;
  $('#pickStart').setAttribute('aria-pressed', String(value === 'start'));
  $('#pickGoal').setAttribute('aria-pressed', String(value === 'goal'));
  $('#terrainCanvas').classList.toggle('picking', !!value);
}

function updatePoints() {
  $('#startCoord').textContent = start ? format(start) : '—';
  $('#endCoord').textContent = goal ? format(goal) : '—';
  $('#calculateButton').disabled = !overview || !start || !goal;
  $('#verifiedButton').disabled = !overview || !start || !goal;
  $('#sciencePlanFromA').disabled = !overview || !start;
}

function invalidate(status = 'CALCULATION NEEDED') {
  requestId++;
  if (workerBusy) {
    worker?.terminate();
    worker = null;
    workerBusy = false;
  }
  analysis = null;
  routePoints = []; routeSegments = [];
  evaStops=[];evaRouteWarning='';evaHazards=[];scienceStopsMessage='No additional mapped science stops yet.';updateEVASections();renderEVA();
  map.setRoute([], start, goal);
  map.setTerrainDepressions([]);
  map.setLocalFootprint(null,null);
  $('#routeStatus').textContent = status;
  $('#resolution').textContent='Best available route DEM';
  $('#calculateButton').textContent = 'Calculate route ↗';
  $('#verifiedButton').textContent = 'Find verified-data route ↗';
  for (const id of ['distanceMetric', 'gainMetric', 'maxSlopeMetric', 'nodesMetric']) $('#' + id).textContent = '—';
  $('#routeQuality').textContent = 'Route data quality will appear here after calculation.';
  $('#hazardStatus').textContent='Terrain depression checks run where a detailed CTX or HiRISE model supports them. An empty result never certifies a safe route.';
  delete $('#routeQuality').dataset.source;
  $('#profileCaption').textContent = 'Calculate a route to see its elevation profile.';
  $('#routeSegments').innerHTML = '<p class="note">Calculate a route to see where the source changes.</p>';
  drawProfile($('#profileCanvas'), null);
  updatePoints();
}

function setPoint(target, coordinate) {
  if (target === 'start') start = coordinate;
  else goal = coordinate;
  scienceTargets=[];selectedScienceTarget=null;
  renderScienceTargets(start?'Find science targets from A, or choose B manually.':'Choose A to search for nearby science targets.');
  setPick(target === 'start' ? 'goal' : null);
  invalidate();
  notice(target === 'start' ? 'Start set. Choose B, or open Science expedition to find a target automatically.' : 'Destination set. Calculate a route.');
}

function updateLegend() {
  if (!overview) return;
  $('#legend').textContent = map.layer === 'slope' ? 'Overview slope: green 0° → orange ≥30° · 4 px/° MOLA' :map.layer==='geology'?'USGS SIM 3292: colors = mapped geologic units · lines = contacts and structures · 1:20,000,000': imageryLayers[map.layer] ? `${imageryLayers[map.layer].label} imagery · numeric route heights use HRSC/MOLA blend` : `MOLA overview elevation: ${Math.round(overview.min).toLocaleString()} → ${Math.round(overview.max).toLocaleString()} m`;
}

function renderSegments() {
  const host=$('#routeSegments');host.replaceChildren();
  if(!routeSegments.length){host.textContent='No source transitions on this route.';return;}
  const items=routeSegments.map((segment,index)=>({...segment,index}));
  const sort=$('#segmentSort').value;
  if(sort==='source')items.sort((a,b)=>a.source.localeCompare(b.source)||a.index-b.index);
  if(sort==='length')items.sort((a,b)=>b.distanceKm-a.distanceKm);
  for(const segment of items.slice(0,100)){
    const button=document.createElement('button');button.type='button';button.className='segment-item';
    button.innerHTML=`<span class="segment-dot ${segment.source}"></span><span><strong>${sourceLabel(segment.source)}</strong><small>Section ${segment.index+1} · ${segment.distanceKm.toFixed(1)} km${segment.spacingM?` · ${segment.spacingM.toFixed(segment.spacingM<10?1:0)} m grid`:''} · ${segment.evidence?.status==='checked'?'data checked':'uncertain'}</small></span><span aria-hidden="true">↗</span>`;
    if(segment.evidence?.reasons?.length){const reasons=document.createElement('small');reasons.className='segment-reasons';reasons.textContent=segment.evidence.reasons.join('; ');button.children[1].append(reasons);}
    button.title=[segment.modelId?`USGS product ${segment.modelId}`:null,...(segment.evidence?.reasons??[])].filter(Boolean).join(' · ');
    button.addEventListener('click',()=>{const point=routePoints[Math.floor((segment.from+segment.to)/2)];if(point)map.focus(point.lat,point.lon,Math.max(map.camera.zoom,48));});
    host.append(button);
  }
  if(items.length>100){const note=document.createElement('p');note.className='note';note.textContent=`Showing 100 of ${items.length} sections. Zoom into a shorter route for more detail.`;host.append(note);}
}

async function loadMap() {
  try {
    overview = await loadNasaTerrain('mars-global');
    map.setTerrain(overview);
    $('#loading').hidden = true;
    $('#dataBadge').textContent = 'USGS HRSC/MOLA · GLOBAL';
    $('#resolution').textContent = 'Best available route DEM';
    invalidate('CHOOSE POINTS');
    updateLegend();
    notice('Choose start and destination anywhere on Mars. Numeric routes load the HRSC/MOLA blend.');
    loadCoverage().then(mask=>map.setCoverage(mask)).catch(()=>notice('HRSC footprint guide could not load; route calculation may be unavailable.',true));
  } catch (error) {
    $('#loading').textContent = 'Could not load the global Mars elevation map.';
    $('#dataBadge').textContent = 'LOAD ERROR';
    notice(error.message, true);
  }
}

function calculate(verifiedOnly=false) {
  if (!overview || !start || !goal) return;
  for(const id of ['vehicleRadius','crossSlopeLimit','stepLimit'])if(!$('#'+id).checkValidity()||!Number.isFinite(Number($('#'+id).value))){
    $('#'+id).focus();notice('Enter valid walking clearance, cross-slope and step limits.',true);return;
  }
  const limit = $('#detailRequirement').value === 'any' ? Infinity : Number($('#detailRequirement').value);
  const hazardSettings={vehicleRadiusM:Number($('#vehicleRadius').value),
    crossSlopeLimit:Number($('#crossSlopeLimit').value),stepLimitM:Number($('#stepLimit').value)};
  map.hazardSettings=hazardSettings;
  invalidate(verifiedOnly?'CHECKING DETAILED DATA':'LOADING GLOBAL HEIGHTS');
  const id = requestId;
  $('#calculateButton').disabled = true;
  $('#verifiedButton').disabled = true;
  (verifiedOnly?$('#verifiedButton'):$('#calculateButton')).textContent = 'Calculating…';
  try {
    worker ??= new Worker(new URL('./global-route-worker.js', import.meta.url), {type:'module'});
  } catch (error) {
    invalidate('ERROR');
    notice(error.message, true);
    return;
  }
  worker.onerror = () => {
    if (id !== requestId) return;
    invalidate('ERROR');
    notice('Could not calculate the route. Try again.', true);
  };
  worker.onmessage = ({data}) => {
    if (data.id !== requestId) return;
    if (data.stage) {
      $('#routeStatus').textContent = data.stage === 'local' ? 'CHECKING LOCAL DTMS' : data.stage==='native'?`SEARCHING NATIVE DTM · ${data.explored.toLocaleString()} CELLS / ${data.tiles} TILES` : data.stage === 'loading' ? 'LOADING BASE MAP' : data.stage === 'routing' ? 'FINDING CORRIDOR' : data.stage === 'coverage' ? 'CHECKING HRSC COVERAGE' : data.stage === 'patching' ? 'REFINING LOCAL SECTIONS' : data.stage==='imagery'?`CHECKING CTX/HIRISE IMAGES${data.progress?` · ${data.progress}%`:''}`:`LOADING BLEND HEIGHTS${data.progress ? ` · ${data.progress}%` : ''}`;
      return;
    }
    workerBusy = false;
    updatePoints();
    $('#calculateButton').textContent = 'Calculate route ↗';
    $('#verifiedButton').textContent = 'Find verified-data route ↗';
    if(data.noVerifiedRoute){
      $('#routeStatus').textContent = 'NO VERIFIED-DATA ROUTE';
      $('#routeQuality').textContent = data.reason;
      notice(data.reason,true);
      return;
    }
    if (data.error) {
      worker.terminate();
      worker = null;
      $('#routeStatus').textContent = 'ERROR';
      notice(data.error, true);
      return;
    }
    const {result, quality} = data;
    $('#nodesMetric').textContent = result.explored.toLocaleString();
    if (!result.points.length) {
      $('#routeStatus').textContent = 'NO ROUTE FOUND';
      notice('No route meets the selected slope limit within the loaded terrain corridor. Adjust the points or limit.', true);
      return;
    }
    analysis = data.analysis;
    routePoints=result.points;routeSegments=quality.segments;
    evaHazards=quality.terrainHazards??[];
    evaRouteWarning=(quality.unresolvedHazards?.length??0)>0?'Terrain depressions remain unresolved.':quality.unverifiedKm>0?'Some route elevations are unverified.':routeSegments.some(segment=>segment.evidence?.status!=='checked')?'Some route sections have uncertain data quality.':'No listed data-quality flag; small or unseen hazards may remain.';
    updateEVASections();if(evaMode==='science')generateScienceStops();else renderEVA();
    analysis.segments=routeSegments;
    map.setRoute(result.points, start, goal, quality.segments, quality.transitions);
    map.setTerrainDepressions(quality.terrainHazards??[]);
    map.setLocalFootprints(quality.footprint?[{source:routeSegments[0]?.source,geometry:quality.footprint}]:
      (quality.localModels??[]).map(model=>({source:model.source,geometry:model.footprint})));
    const unresolvedCount=quality.unresolvedHazards?.length??0;
    const uncertainSections=quality.segments.filter(segment=>segment.evidence?.status!=='checked').length;
    $('#routeStatus').textContent = verifiedOnly?'DATA CHECKS PASSED':unresolvedCount?'HAZARD UNRESOLVED':uncertainSections||(quality.unverifiedKm??0)>0?'ROUTE NEEDS REVIEW':'ROUTE READY';
    $('#distanceMetric').textContent = analysis.distanceKm.toFixed(1) + ' km';
    $('#gainMetric').textContent = Math.round(analysis.elevationGain) + ' m';
    $('#maxSlopeMetric').textContent = analysis.maxSlope.toFixed(1) + '°';
    const unverifiedKm=quality.unverifiedKm??0;
    const unverifiedJoinKm=quality.unverifiedJoinKm??0;
    const detailedKm=quality.segments.filter(segment=>segment.source==='ctx'||segment.source==='hirise').reduce((sum,segment)=>sum+segment.distanceKm,0);
    const coarseKm=quality.segments.filter(segment=>segment.source==='hrsc'||segment.source==='mola').reduce((sum,segment)=>sum+segment.distanceKm,0);
    const candidateCount=(quality.terrainHazards??[]).length;
    const demSurvey=quality.demSurvey??{};
    const avoidedCount=quality.avoidedHazards?.length??0;
    const unknownPct=analysis.distanceKm?unverifiedKm/analysis.distanceKm*100:0;
    $('#hazardStatus').textContent = demSurvey.available?
      `Terrain review: ${candidateCount} DTM depression candidates, ${avoidedCount} avoided on the native grid, ${unresolvedCount} intersecting the route. ${demSurvey.testedCenters??0} candidate centers checked${demSurvey.truncated?'; the search was capped or data ran out':''}. ${demSurvey.error??''} Detailed DEM: ${detailedKm.toFixed(1)} km; coarse HRSC/MOLA: ${coarseKm.toFixed(1)} km; unverified elevation: ${unverifiedKm.toFixed(2)} km (${unknownPct.toFixed(1)}%; model joins ${unverifiedJoinKm.toFixed(2)} km). Candidate circles approximate extent; orbital terrain and unseen hazards still need review.`:
      `Terrain crater review unavailable at this route's resolution. HRSC/MOLA covers ${coarseKm.toFixed(1)} km; detailed stereo terrain covers ${detailedKm.toFixed(1)} km. A coarse elevation grid cannot rule out pedestrian-scale craters. No automatic crater clearance is claimed.`;
    const heading = document.createElement('strong'), detail = document.createElement('span');
    const localSource=routeSegments[0]?.source,mixed=(quality.localModels?.length??0)>0;
    $('#resolution').textContent=mixed?`Mixed DEM · ${Math.round(quality.spacingM)} m base + local stereo`:
      `${localSource==='ctx'||localSource==='hirise'?sourceLabel(localSource):'HRSC/MOLA blend'} · ${Math.round(quality.spacingM)} m`;
    if(quality.footprint){
      heading.textContent=`USGS ${sourceLabel(localSource)} · ${quality.spacingM.toFixed(quality.spacingM<10?1:0)} m route sampling`;
      detail.textContent=`Numeric stereo heights from product ${quality.source}. ${quality.nativeTiles?`Native-grid search read ${quality.nativeTiles} tiles on demand without a fixed corridor. Forward and cross slope, apparent steps, missing cells and model edges were checked against the chosen walking assumptions. `:`${quality.alternativesCompared??1} local corridor${quality.alternativesCompared===1?'':'s'} compared. `}${uncertainSections} section${uncertainSections===1?'':'s'} have unresolved data quality; open a section for reasons. The highlighted footprint is the catalog boundary; no-data holes are excluded from the route. ${verifiedOnly?'The full route passed the stated data checks. ':''}Grid spacing does not prove foot-scale obstacle detection or human safety.`;
    }else{
      const hrscKm=quality.segments.filter(s=>s.source==='hrsc').reduce((sum,s)=>sum+s.distanceKm,0);
      const molaKm=quality.segments.filter(s=>s.source==='mola').reduce((sum,s)=>sum+s.distanceKm,0);
      const localKm=quality.segments.filter(s=>s.source==='ctx'||s.source==='hirise').reduce((sum,s)=>sum+s.distanceKm,0);
      const products=[...new Map((quality.localModels??[]).map(model=>[model.id,model])).values()];
      const localGrids=[...new Set(products.map(model=>`${sourceLabel(model.source)} ${model.spacingM.toFixed(model.spacingM<10?1:0)} m`))];
      const lengths=[hrscKm>0?`${hrscKm.toFixed(1)} km inside approximate HRSC footprints`:null,molaKm>0?`${molaKm.toFixed(1)} km on the MOLA base`:null,localKm>0?`${localKm.toFixed(1)} km on CTX/HiRISE stereo DTMs`:null,unverifiedJoinKm>0?`${unverifiedJoinKm.toFixed(2)} km at unverified model joins`:null].filter(Boolean);
      heading.textContent = mixed?`${hrscKm+molaKm>0?'Mixed USGS terrain':'USGS stereo terrain'} · ${products.length} stereo product${products.length===1?'':'s'}`:
        `USGS HRSC/MOLA blend · ${Math.round(quality.spacingM).toLocaleString()} m route sampling`;
      detail.textContent = `${lengths.join('; ')}. ${quality.localSearchNote?`Local model search: ${quality.localSearchNote} `:''}${uncertainSections} sections have unresolved data quality; open a section for reasons. ${quality.transitions.length} model/source transitions marked on the line. ${hrscKm+molaKm>0?`Base route sampling is ${Math.round(quality.spacingM)} m. `:''}${mixed?`Local grids: ${localGrids.join(', ')}. `:''}${molaKm>0?'MOLA-base elevations are interpolated from roughly 463 m source posts. ':''}${hrscKm>0?'HRSC footprint boundaries and 5 km blend edges are approximate. ':''}${mixed?'Vertical registration at stereo model seams is excluded from climb and slope statistics. ':''}These figures do not bound route error or prove safety.`;
    }
    $('#routeQuality').replaceChildren(heading, detail);
    $('#routeQuality').dataset.source = quality.footprint?localSource:'blend';
    renderSegments();
    const [lowest,highest]=analysis.elevations.reduce(([lo,hi],value)=>Number.isFinite(value)?
      [Math.min(lo,value),Math.max(hi,value)]:[lo,hi],[Infinity,-Infinity]);
    $('#profileCaption').textContent = `${result.pathLength} route points · ${Math.round(lowest)} to ${Math.round(highest)} m relative to the Mars areoid · ${unverifiedKm>0?'profile gaps mark unverified model joins · ':''}horizontal surface distance.`;
    drawProfile($('#profileCanvas'), analysis);
    notice(verifiedOnly?'The route passed all listed data checks. Orbital data still cannot certify walking safety.':unresolvedCount?`${unresolvedCount} terrain depression candidate${unresolvedCount===1?'':'s'} still intersects the route. This route needs manual review.`:avoidedCount?`${avoidedCount} terrain depression candidate${avoidedCount===1?'':'s'} avoided on the native DTM grid. Review the terrain evidence below.`:quality.footprint?`Route calculated from a real ${sourceLabel(localSource)}. See the highlighted model footprint.`:mixed?'Route refined with local CTX/HiRISE stereo terrain where catalog products cover sections. Source transitions are marked on the line.':'Route calculated from the USGS HRSC/MOLA DEM. Green sections follow the HRSC footprint guide; orange sections use the MOLA base.',Boolean(unresolvedCount));
  };
  workerBusy = true;
  worker.postMessage({id, start, goal, options:{slopeLimit:Number($('#slopeLimit').value), riskWeight:Number($('#riskWeight').value)/100,
    maxGridSpacingM:limit,verifiedOnly,...hazardSettings}});
}

$('#pickStart').addEventListener('click', () => {setPick('start'); notice('Click anywhere on the map or search for start coordinates.');});
$('#pickGoal').addEventListener('click', () => {setPick('goal'); notice('Click anywhere on the map or search for destination coordinates.');});
$('#resetButton').addEventListener('click', () => {start = goal = null; scienceTargets=[];selectedScienceTarget=null;renderScienceTargets('Choose A to search for nearby science targets.');setPick(null); invalidate('CHOOSE POINTS'); notice('Points cleared.');});
$('#calculateButton').addEventListener('click', () => calculate(false));
$('#verifiedButton').addEventListener('click', () => calculate(true));
for (const [id, out, suffix] of [['slopeLimit','slopeOutput','°'], ['riskWeight','riskOutput','%']]) $('#' + id).addEventListener('input', event => {
  $('#' + out).value = event.target.value + suffix;
  invalidate();
  notice('Settings changed. Recalculate the route.');
});
$('#detailRequirement').addEventListener('change', () => {invalidate(); notice('Elevation-grid requirement changed. Recalculate the route.');});
$('#coverageFilter').addEventListener('change',event=>map.setCoverageFilter(event.target.value));
$('#mapLabels').addEventListener('change',event=>map.setShowMapLabels(event.target.checked));
$('#showDepressions').addEventListener('change',event=>map.setShowTerrainDepressions(event.target.checked));
for(const id of ['vehicleRadius','crossSlopeLimit','stepLimit'])$('#'+id).addEventListener('change',()=>{invalidate();notice('Walking clearance changed. Recalculate the route.');});
$('#segmentSort').addEventListener('change',renderSegments);
for(const id of ['evaSpeed','evaSlowdown','evaReserve','evaDeparture','evaOxygen','evaPower','evaWater','evaLimit','evaReturn',
  'evaTargetObjective','evaTargetMinutes','evaTempMin','evaTempMax','evaSuitTempMin','evaSuitTempMax','evaRadRate','evaDoseLimit',
  'evaWind','evaWindLimit','evaDust','evaDustLimit','evaRadioRange','evaBaseAntenna','evaSuitAntenna'])$('#'+id).addEventListener('input',renderEVA);
$('#evaStandard').addEventListener('click',()=>setEVAMode('standard'));
$('#evaScience').addEventListener('click',()=>setEVAMode('science'));
$('#sciencePlanFromA').addEventListener('click',planScienceFromA);
$('#evaSuggestStops').addEventListener('click',generateScienceStops);
$('#evaAddStop').addEventListener('click',()=>{
  if(!analysis||!routeSegments.length)return;
  const objective=$('#evaObjective').value.trim(),minutes=Number($('#evaMinutes').value);
  if(!objective){$('#evaObjective').focus();return;}
  if(!$('#evaMinutes').checkValidity()||!Number.isInteger(minutes)){$('#evaMinutes').focus();return;}
  const segment=routeSegments[Number($('#evaSection').value)];if(!segment)return;
  const index=Math.round((segment.from+segment.to)/2),point=routePoints[index],distanceKm=analysis.distances[index];
  if(!point||!Number.isFinite(distanceKm))return;
  evaStops.push({objective,minutes,distanceKm,point});$('#evaObjective').value='';renderEVA();map.focus(point.lat,point.lon,Math.max(map.camera.zoom,48));
});
document.querySelectorAll('[data-layer]').forEach(button => button.addEventListener('click', () => {
  clearTimeout(geologyHoverTimer);geologyHoverSerial++;$('#mapTooltip').hidden=true;
  document.querySelectorAll('[data-layer]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  map.setLayer(button.dataset.layer);
  updateLegend();
}));
$('#imageryOpacity').addEventListener('input', event => {map.setImageryOpacity(map.layer, Number(event.target.value)/100); $('#opacityValue').textContent = `${event.target.value}%`;});
$('#zoomIn').addEventListener('click', () => {map.camera.zoomAt(1.5); map.draw();});
$('#zoomOut').addEventListener('click', () => {map.camera.zoomAt(1/1.5); map.draw();});
$('#fitMap').addEventListener('click', () => {map.camera.reset(); map.draw();});
$('#globalButton').addEventListener('click', () => {map.camera.reset(); map.draw();});
$('#searchForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!overview) {notice('The global Mars map is still loading.', true);return;}
  const input = $('#searchInput').value.trim().toLowerCase();
  const place = places.find(item => item.aliases.includes(input));
  const coordinate = place || parseCoordinates(input);
  if (!coordinate) {
    notice('Enter a Mars place name or latitude, longitude (for example 15.4, 131.7).', true);
    return;
  }
  const target = pick;
  if (target) setPoint(target, {lat:coordinate.lat, lon:coordinate.lon});
  map.focus(coordinate.lat, coordinate.lon, Math.max(map.camera.zoom, 12));
  if (!target) notice(`${place?.name || 'Coordinates'} · ${format(coordinate)}. Use Pick start or Pick destination to plan a route.`);
});
new ResizeObserver(() => drawProfile($('#profileCanvas'), analysis)).observe($('#profileCanvas'));
fetch('data/imagery-index.json').then(response => response.ok ? response.json() : null).then(index => {if (index?.files) map.setImageryIndex(index.files);}).catch(() => {});
$('#evaDeparture').value=new Date().toISOString().slice(0,16);
setEVAMode('standard');
loadMap();
