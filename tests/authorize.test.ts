import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,stat,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthorizeApi, cliArgs, route, sanitize, executeCli, type Context, type Request } from '../src/authorize/api.js';
import { authorizeRuntime } from '../src/authorize/runtime.js';
import { systemPlaybook,reference,referenceNames } from '../src/authorize/knowledge.js';
const env='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',childId='33333333-3333-4333-8333-333333333333';
const ctx=(mode:Context['mode']='inspect'):Context=>({environmentId:env,profile:'atlas-test',allowedEnvironments:[env],capabilities:['inspect','author','deploy','evaluate'],mode,allowDestructive:false});
test('environment, schema, UUID and command boundaries',async()=>{
 assert.throws(()=>new AuthorizeApi({...ctx(),environmentId:id}),/not in/);
 assert.throws(()=>new AuthorizeApi({...ctx(),profile:''}),/explicit/);
 assert.throws(()=>route(ctx(),{resource:'policies',id:'../applications'}));
 const args=cliArgs(ctx(),{method:'GET',path:route(ctx(),{resource:'policies',id})});
 assert.equal(args.includes('--environment-id'),false);assert.ok(args.includes('--fail'));assert.ok(args.includes('atlas-test'));
 let calls=0;const rt=authorizeRuntime(ctx(),async()=>{calls++;return {};});
 assert.equal((await rt.call('authorize_read',{resource:'policies',environmentId:id})).isError,true);
 assert.equal((await rt.call('authorize_read',{resource:'policies',positional:['--profile','prod']})).isError,true);
 assert.equal((await rt.call('authorize_change',{action:'delete',resource:'policies',id})).isError,true);
 assert.equal(calls,0);
});
test('inspect, deployment, evaluate and deletion modes are separate',async()=>{
 let calls=0;const transport=async()=>{calls++;return {};};
 await assert.rejects(new AuthorizeApi(ctx(),transport).change({action:'create',resource:'policies',body:{type:'POLICY'}}),/author/);
 await assert.rejects(new AuthorizeApi(ctx('author'),transport).change({action:'deploy',resource:'deployment',id}),/deploy/);
 await assert.rejects(new AuthorizeApi(ctx('author'),transport).change({action:'evaluate',resource:'decisionEndpoints',id,body:{parameters:{}}}),/evaluate/);
 await assert.rejects(new AuthorizeApi(ctx('author'),transport).change({action:'delete',resource:'policies',id}),/disabled/);
 await assert.rejects(new AuthorizeApi(ctx('author'),transport).change({action:'create',resource:'policies',body:{type:'POLICY',parent:{id}}}),/standalone/);
 assert.equal(calls,0);
});
test('fresh versions and existing children protected before replacement',async()=>{
 const current={id,version:'fresh',children:[{id:childId,version:'child-v',name:'keep'}]};const requests:Request[]=[];
 const api=new AuthorizeApi(ctx('author'),async r=>{requests.push(r);return current;});
 await assert.rejects(api.change({action:'replace',resource:'policies',id,body:{id,version:'stale',children:current.children}}),/Stale/);
 await assert.rejects(api.change({action:'replace',resource:'policies',id,body:{id,version:'fresh',children:[]}}),/removes/);
 await assert.rejects(api.change({action:'replace',resource:'policies',id,body:{id,version:'fresh',children:[{id:childId}]}}),/child version/);
 assert.ok(requests.every(x=>x.method==='GET'));
});
test('Custom placement preserves children, verifies both links; no ancestor write',async()=>{
 const current={id,version:'v1',name:'Custom',enabled:true,combiningAlgorithm:{algorithm:'DENY_OVERRIDES'},managedEntity:{restrictions:{readOnly:true,disallowChildren:false}},children:[]};
 const next={type:'POLICY',name:'new',children:[]};const body={id,version:'v1',name:current.name,enabled:true,combiningAlgorithm:current.combiningAlgorithm,children:[next]};
 const requests:Request[]=[];
 const api=new AuthorizeApi(ctx('author'),async r=>{requests.push(r);if(r.path.endsWith(childId))return {id:childId,_links:{parent:{href:`https://api.pingone.com/v1/environments/${env}/authorizationPolicies/${id}`}}};if(requests.length===1)return current;return {...current,version:'v2',children:[{...next,id:childId}]};});
 const out=await api.change({action:'replace',resource:'policies',id,body});assert.equal(out.requestedFieldsMatch,true);assert.equal(out.childLinks.length,1);
 assert.deepEqual(requests.map(r=>r.method),['GET','PUT','GET','GET']);
 for(const managed of [{...current,name:'API Access Management'},{...current,managedEntity:{restrictions:{disallowChildren:true}}}]) {
  const a=new AuthorizeApi(ctx('author'),async()=>managed);await assert.rejects(a.change({action:'replace',resource:'policies',id,body}),/eligible/);
 }
});
test('readback mismatches remain explicit',async()=>{
 let n=0;const api=new AuthorizeApi(ctx('author'),async()=>++n===1?{id,version:'v1',name:'old'}:{id,version:'v2',name:'unchanged'});
 const out=await api.change({action:'replace',resource:'policies',id,body:{id,version:'v1',name:'wanted'}});assert.equal(out.requestedFieldsMatch,false);
});
test('tag/deploy/evaluate use the proper method, media type and body',async()=>{
 const calls:Request[]=[];const transport=async(r:Request)=>{calls.push(r);return {status:'DEPLOYMENT_SUCCESSFUL',authorizationVersionId:id};};
 await new AuthorizeApi(ctx('deploy'),transport).change({action:'deploy',resource:'deployment',id});
 assert.deepEqual(calls.map(x=>x.method),['GET','POST','GET']);assert.equal(calls[1].mediaType,'application/vnd.pingidentity.apiserver.deploy+json');
 calls.length=0;await new AuthorizeApi(ctx('evaluate'),transport).change({action:'evaluate',resource:'decisionEndpoints',id,body:{parameters:{'Example.risk':1}}});
 assert.equal(calls[0].method,'POST');assert.equal(calls[0].path,`environments/${env}/decisionEndpoints/${id}`);
});
test('nested and encoded tokens redacted while credential Definition references work',async()=>{
 const value={headers:JSON.stringify({Authorization:'Bearer opaque-secret'}),password:'secret',access_token:'secret',reference:{password:{id}}};
 const clean=sanitize(value);assert.ok(!JSON.stringify(clean).includes('opaque-secret'));assert.equal(clean.password,'[REDACTED]');assert.equal(clean.reference.password.id,id);
 let calls=0;const api=new AuthorizeApi(ctx('author'),async()=>{calls++;return {};});
 await assert.rejects(api.change({action:'create',resource:'attributes',body:{clientSecret:'secret'}}),/Secret/);assert.equal(calls,0);
});
test('entire skill and all seven references load without arbitrary file access',async()=>{
 const text=await systemPlaybook('test');assert.ok(text.includes('payload string'));assert.ok(text.includes('disallowChildren'));
 for(const topic of referenceNames)assert.ok((await reference({topic})).length>500);
 await assert.rejects(reference({topic:'../../.env'}));
});
test('CLI envelope, body privacy/cleanup, failures, timeout and bounded output',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'authorize-test-'));const mock=join(dir,'pingcli');
 const script=`#!/usr/bin/env node
const fs=require('fs');const args=process.argv.slice(2);const mode=process.env.MOCK_MODE;
if(mode==='hang'){setTimeout(()=>{},10000);return;}
if(mode==='fail'){console.error('Bearer never-disclose');process.exit(1);}
if(mode==='large'){console.log('x'.repeat(4096));return;}
if(mode==='bad'){console.log('not JSON');return;}
const idx=args.indexOf('--data');let body;
if(idx>=0){body=JSON.parse(fs.readFileSync(args[idx+1],'utf8'));fs.writeFileSync(process.env.CAPTURE,JSON.stringify({file:args[idx+1],mode:fs.statSync(args[idx+1]).mode&511,args}));}
console.log(JSON.stringify({schemaVersion:'1',status:'success',data:{id:'${id}',name:body?.name??'read'}}));`;
 await writeFile(mock,script,{mode:0o700});const capture=join(dir,'capture.json');
 try {
  const request:Request={method:'POST',path:`environments/${env}/authorizationPolicies`,body:{name:'private-body-value'}};
  assert.equal((await executeCli(ctx('author'),request,{binary:mock,env:{...process.env,CAPTURE:capture}}) as any).name,'private-body-value');
  const saved=JSON.parse(await readFile(capture,'utf8'));assert.equal(saved.mode,0o600);assert.ok(!saved.args.join(' ').includes('private-body-value'));await assert.rejects(stat(saved.file));
  for(const [mode,pattern] of [['fail',/exited 1/],['bad',/malformed/],['large',/exceeded/],['hang',/timed out/]] as const) {
   await assert.rejects(executeCli(ctx(),{method:'GET',path:`environments/${env}/authorizationPolicies`},{binary:mock,env:{...process.env,MOCK_MODE:mode},timeoutMs:100,maxBytes:2048}),pattern);
  }
  await assert.rejects(executeCli(ctx(),{method:'GET',path:`environments/${env}/authorizationPolicies`},{binary:join(dir,'absent')}),/Cannot start/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('failed child link after a Custom write is not reported as success',async()=>{
 const current={id,version:'v1',name:'Custom',enabled:true,combiningAlgorithm:{algorithm:'DENY_OVERRIDES'},managedEntity:{restrictions:{disallowChildren:false}},children:[]};
 let count=0;const rt=authorizeRuntime(ctx('author'),async r=>{count++;if(r.path.endsWith(childId))return {id:childId,_links:{parent:{href:'https://api.pingone.com/v1/environments/'+id+'/authorizationPolicies/'+id}}};return count===1?current:{...current,children:[{id:childId,type:'POLICY',name:'new'}]};});
 const result=await rt.call('authorize_change',{action:'replace',resource:'policies',id,body:{id,version:'v1',name:'Custom',enabled:true,combiningAlgorithm:current.combiningAlgorithm,children:[{type:'POLICY',name:'new'}]}});
 assert.equal(result.isError,true);assert.match(result.content[0].text,/placement/);
});
test('runtime marks a mismatched replacement readback as incomplete',async()=>{
 let n=0;const rt=authorizeRuntime(ctx('author'),async()=>++n===1?{id,version:'v1',name:'old'}:{id,version:'v2',name:'old'});
 const result=await rt.call('authorize_change',{action:'replace',resource:'policies',id,body:{id,version:'v1',name:'requested'}});assert.equal(result.isError,true);
});

test('replacement cannot remove nested rules through an unchanged parent child id',async()=>{
 const ruleId='44444444-4444-4444-8444-444444444444';
 const current={id,version:'v1',children:[{id:childId,version:'v2',children:[{id:ruleId,version:'v3'}]}]};
 const requests:Request[]=[];
 const api=new AuthorizeApi(ctx('author'),async r=>{requests.push(r);return current;});
 await assert.rejects(api.change({action:'replace',resource:'policies',id,body:{id,version:'v1',children:[{id:childId,version:'v2',children:[]}]}}),/removes/);
 assert.deepEqual(requests.map(x=>x.method),['GET']);
});
