import {timeAtDistance} from './travel-time.js';

const rad=Math.PI/180,mod=(value,base)=>((value%base)+base)%base;
const sinDeg=value=>Math.sin(value*rad),cosDeg=value=>Math.cos(value*rad);

// NASA GISS Mars24 equations. TT-UTC is held at the latest listed leap-second value
// for future dates, so this is planning geometry rather than operational ephemeris.
export function marsSolar(date,latitude,longitudeEast){
  const instant=date instanceof Date?date:new Date(date);
  if(!Number.isFinite(instant.getTime())||!Number.isFinite(latitude)||!Number.isFinite(longitudeEast)||Math.abs(latitude)>90)throw new RangeError('Invalid Mars solar date or coordinate');
  const year=instant.getUTCFullYear(),ttOffset=year>=2017?69.184:year>=2009?66.184:year>=2006?65.184:64.184;
  const jd=2440587.5+instant.getTime()/86400000+ttOffset/86400,dt=jd-2451545;
  const anomaly=19.3871+.52402073*dt,fms=270.3871+.524038496*dt;
  const perturbers=[[.0071,2.2353,49.409],[.0057,2.7543,168.173],[.0039,1.1177,191.837],[.0037,15.7866,21.736],[.0021,2.1354,15.704],[.0020,2.4694,95.528],[.0018,32.8493,49.095]];
  const pbs=perturbers.reduce((sum,[amplitude,period,phase])=>sum+amplitude*cosDeg(.985626*dt/period+phase),0);
  const center=(10.691+3e-7*dt)*sinDeg(anomaly)+.623*sinDeg(2*anomaly)+.050*sinDeg(3*anomaly)+.005*sinDeg(4*anomaly)+.0005*sinDeg(5*anomaly)+pbs;
  const ls=mod(fms+center,360),eot=2.861*sinDeg(2*ls)-.071*sinDeg(4*ls)+.002*sinDeg(6*ls)-center;
  const mst=mod(24*((jd-2451549.5)/1.0274912517+44796-.0009626),24);
  const trueSolarHour=mod(mst+longitudeEast/15+eot/15,24);
  const declination=Math.asin(.42565*sinDeg(ls))/rad+.25*sinDeg(ls);
  const hourAngle=(trueSolarHour-12)*15;
  const elevation=Math.asin(sinDeg(declination)*sinDeg(latitude)+cosDeg(declination)*cosDeg(latitude)*cosDeg(hourAngle))/rad;
  const daylightArgument=-Math.tan(latitude*rad)*Math.tan(declination*rad);
  const daylightMarsHours=daylightArgument<=-1?24:daylightArgument>=1?0:2*Math.acos(daylightArgument)/rad/15;
  return {elevationDeg:elevation,trueSolarHour,daylightMarsHours,solarLongitudeDeg:ls,declinationDeg:declination};
}

function distanceKm(a,b){
  const dLat=(b.lat-a.lat)*rad,dLon=(b.lon-a.lon)*rad;
  const h=Math.sin(dLat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLon/2)**2;
  return 2*3396.19*Math.asin(Math.sqrt(Math.max(0,Math.min(1,h))));
}

function optionalNumber(value){return value===''||value===null||value===undefined?null:Number(value);}

export function evaluateMissionConditions({startUTC,points,travelProfile,stops=[],returnToStart=false,totalHours,
  temperatureMin='',temperatureMax='',suitTemperatureMin='',suitTemperatureMax='',radiationRate='',doseLimit='',
  windSpeed='',windLimit='',dustTau='',dustLimit='',radioRangeKm='',baseAntennaM='',suitAntennaM=''}){
  const start=new Date(startUTC);
  if(!Number.isFinite(start.getTime())||!points?.length||!travelProfile||!Number.isFinite(totalHours))throw new RangeError('Mission time or route is unavailable');
  const at=(hours,point)=>marsSolar(new Date(start.getTime()+hours*3600000),point.lat,point.lon).elevationDeg;
  let darkHours=0,minimumSun=Infinity,samples=0;
  const sample=(hours,point,duration=0)=>{const angle=at(hours,point);minimumSun=Math.min(minimumSun,angle);samples++;if(angle<=0)darkHours+=duration;};
  const last=points.length-1,stride=Math.max(1,Math.ceil(last/80));
  for(let i=0;i<last;i+=stride){
    const j=Math.min(last,i+stride),duration=travelProfile.timeHours[j]-travelProfile.timeHours[i];
    const steps=Math.max(1,Math.ceil(duration/.25));
    for(let k=0;k<steps;k++){
      const fraction=(k+.5)/steps,index=Math.min(j,Math.floor(i+(j-i)*fraction));
      const distance=travelProfile.distances[i]+(travelProfile.distances[j]-travelProfile.distances[i])*fraction;
      const travelHour=travelProfile.timeHours[i]+duration*fraction;
      const workBefore=stops.filter(stop=>stop.distanceKm<=distance).reduce((sum,stop)=>sum+stop.minutes/60,0);
      sample(travelHour+workBefore,points[index],duration/steps);
      if(returnToStart)sample(travelProfile.hours+stops.reduce((sum,stop)=>sum+stop.minutes/60,0)+
        travelProfile.hours-travelHour,points[index],duration/steps);
    }
  }
  if(last===0)sample(0,points[0]);
  for(const stop of stops){
    const workBefore=stops.filter(other=>other.distanceKm<stop.distanceKm).reduce((sum,other)=>sum+other.minutes/60,0);
    sample(timeAtDistance(travelProfile,stop.distanceKm)+workBefore+stop.minutes/120,stop.point,stop.minutes/60);
  }
  const temp=[temperatureMin,temperatureMax,suitTemperatureMin,suitTemperatureMax].map(optionalNumber);
  if(temp.every(value=>value!==null)&&(temp[0]>temp[1]||temp[2]>temp[3]))throw new RangeError('Temperature minimum must not exceed maximum.');
  const temperature=temp.every(value=>value!==null&&Number.isFinite(value))?{
    status:temp[0]>=temp[2]&&temp[1]<=temp[3]?'within':'over',range:[temp[0],temp[1]],limits:[temp[2],temp[3]]}:{status:'unknown'};
  const rate=optionalNumber(radiationRate),limit=optionalNumber(doseLimit),dose=rate===null?null:rate*totalHours;
  if([rate,limit].some(value=>value!==null&&(!Number.isFinite(value)||value<0)))throw new RangeError('Radiation values must be nonnegative.');
  const radiation={status:dose===null||limit===null?'unknown':dose<=limit?'within':'over',doseMsv:dose,limitMsv:limit};
  const wind=optionalNumber(windSpeed),windMax=optionalNumber(windLimit),dust=optionalNumber(dustTau),dustMax=optionalNumber(dustLimit);
  if([wind,windMax,dust,dustMax].some(value=>value!==null&&(!Number.isFinite(value)||value<0)))throw new RangeError('Weather values must be nonnegative.');
  const weather={status:[wind,windMax,dust,dustMax].some(value=>value===null)?'unknown':wind<=windMax&&dust<=dustMax?'within':'over',wind,windMax,dust,dustMax};
  const hardware=optionalNumber(radioRangeKm),baseHeight=optionalNumber(baseAntennaM),suitHeight=optionalNumber(suitAntennaM);
  if([hardware,baseHeight,suitHeight].some(value=>value!==null&&(!Number.isFinite(value)||value<0)))throw new RangeError('Radio inputs must be nonnegative.');
  const horizon=baseHeight!==null&&suitHeight!==null&&baseHeight>=0&&suitHeight>=0?
    (Math.sqrt(2*3396190*baseHeight+baseHeight**2)+Math.sqrt(2*3396190*suitHeight+suitHeight**2))/1000:null;
  const directRange=hardware===null||horizon===null?null:Math.min(hardware,horizon);
  let maxBaseDistanceKm=0;for(const point of points)maxBaseDistanceKm=Math.max(maxBaseDistanceKm,distanceKm(points[0],point));
  const communications={status:directRange===null?'unknown':maxBaseDistanceKm<=directRange?'geometry_within':'geometry_over',
    directRangeKm:directRange,horizonKm:horizon,maxBaseDistanceKm};
  return {sunlight:{darkHours,minimumElevationDeg:minimumSun,samples,kind:'geometric only'},temperature,radiation,weather,communications};
}
