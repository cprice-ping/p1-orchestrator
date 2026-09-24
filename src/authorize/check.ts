/** Read-only transport probe; no model, no mutation. Prints counts, not tenant payloads. */
import { contextFromEnv } from './api.js';
import { authorizeRuntime } from './runtime.js';
const context=contextFromEnv(process.env.P1_ENVIRONMENT_ID??'','inspect',false);
const runtime=authorizeRuntime(context);
for (const resource of ['policies','attributes','services','decisionEndpoints'] as const) {
  const r=await runtime.call('authorize_read',{resource,limit:1});
  if(r.isError){console.error(JSON.stringify({resource,ok:false,error:r.content[0].text}));process.exitCode=1;break;}
  const d=JSON.parse(r.content[0].text);
  console.log(JSON.stringify({resource,ok:true,collections:Object.fromEntries(Object.entries(d._embedded??{}).map(([k,v])=>[k,Array.isArray(v)?v.length:null])),paged:Boolean(d._links?.next)}));
  await new Promise(resolve=>setTimeout(resolve,300));
}
