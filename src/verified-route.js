// A fully checked data route is still not a certification of human safety.
// Keep these gates separate from the ordinary route's existing review labels.
export function assessVerifiedRoute(route, survey, {maxSpacingM=2}={}) {
  const reasons=[];
  const points=route.points??[];
  if(points.length<2)reasons.push('No connected route was found in one stereo terrain model.');
  const models=new Set(points.map(point=>point.modelId).filter(Boolean));
  if(models.size!==1||points.some(point=>point.source!=='hirise'||!point.modelId))
    reasons.push('A continuous HiRISE stereo DTM is required across the entire route.');
  if(!Number.isFinite(route.spacingM)||route.spacingM>maxSpacingM)
    reasons.push(`The terrain grid exceeds the ${maxSpacingM} m detail requirement.`);
  if(!Number.isFinite(route.unverifiedKm)||route.unverifiedKm>1e-6)
    reasons.push('The route contains unverified elevation or a model join.');
  if((route.unresolved??[]).length)reasons.push('A terrain hazard remains unresolved.');
  if(route.evidence?.status!=='checked')
    reasons.push(`DTM quality is uncertain: ${(route.evidence?.reasons??['quality evidence unavailable']).join('; ')}.`);
  if(survey?.unavailable||survey?.truncated||!survey||!Number.isFinite(survey.imagePixelM)||survey.imagePixelM>maxSpacingM)
    reasons.push('The image survey is incomplete or unavailable.');
  const total=survey?.totalKm??0,inspected=survey?.inspectedBySourceKm?.hirise??0;
  if(!(total>0&&inspected>=total-Math.max(.001,total*.005)))
    reasons.push('Readable HiRISE imagery does not cover the complete route.');
  return {ok:reasons.length===0,reasons};
}
