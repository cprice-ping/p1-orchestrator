import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { mkdir, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LaunchInput, LaunchOutput, LaunchCallbacks } from '../launch.js';
import type { SpecialistDef } from '../registry.js';
import { contextFromEnv, createOAuthTransport, sanitize } from './api.js';
import { systemPlaybook } from './knowledge.js';
import { authorizeRuntime } from './runtime.js';
import { finalizeAuthorizeRun, summarizeSdkMessage } from './run-evidence.js';

export async function launchAuthorize(input:LaunchInput,def:SpecialistDef,callbacks:LaunchCallbacks|undefined,accessToken:string):Promise<LaunchOutput> {
  const context=contextFromEnv(input.environmentId,input.authorizeMode ?? 'inspect',input.allowDestructive);
  if(input.sessionId)throw new Error('Authorize sessions are fresh per dispatch to bind environment and mode. Include a sanitized prior summary in intent.');
  const runtime=authorizeRuntime(context,createOAuthTransport(accessToken,process.env.P1_MCP_URL??''));
  const system=await systemPlaybook(def.playbook);
  const prompt=`Environment: ${context.environmentId}\nMode: ${context.mode}\nAuthentication: orchestrator PingOne OAuth session\nTask: ${input.intent}`;
  const engine=process.env.SPECIALIST_ENGINE ?? 'claude';
  if(!['claude','gemini'].includes(engine))throw new Error('Unsupported specialist engine.');
  const toolCalls:string[]=[], toolArgs:string[]=[];
  const denied:{tool:string;reason:string}[]=[];
  const dir=join(homedir(),'.p1-orchestrator','runs');await mkdir(dir,{recursive:true,mode:0o700});
  const logPath=join(dir,`${Date.now()}-authorize-${randomUUID()}.ndjson`);
  const log=async(event:unknown)=>appendFile(logPath,JSON.stringify(event)+'\n',{mode:0o600});
  let failed=false, report='', isError=false;
  let changeAttempts=0, changeSucceeded=0, verifiedChanges=0;
  let authorizeMcpStatus='not reported', assistantTextOnlyTurns=0, assistantToolUseTurns=0;
  const start=Date.now();
  const call=async(name:string,args:unknown)=>{
    toolCalls.push(name);toolArgs.push('[arguments withheld]');
    if(name==='authorize_change')changeAttempts++;
    callbacks?.onEvent?.({kind:'tool_call',name,argsPreview:'[arguments withheld]'});
    const result=await runtime.call(name,args);
    let readbackVerified=false;
    if(name==='authorize_change' && !result.isError) {
      changeSucceeded++;
      try {
        const body=JSON.parse(result.content[0].text);
        readbackVerified=body.requestedFieldsMatch===true && body.readback !== undefined;
      } catch { /* A non-JSON result cannot establish readback verification. */ }
      if(readbackVerified)verifiedChanges++;
    }
    await log({event:'tool',name,isError:result.isError,...(name==='authorize_change'?{readbackVerified}:{})});
    if(result.isError){failed=true;denied.push({tool:name,reason:result.content[0].text});}
    return result;
  };
  callbacks?.onEvent?.({kind:'init',servers:'authorize CLI adapter',visibleMcpTools:runtime.specs.length});
  try {
    if(engine==='claude') {
      const sdk=createSdkMcpServer({name:'authorize',version:'0.1.0',tools:runtime.specs.map(s=>tool(s.name,s.description,s.schema.shape as any,(args)=>call(s.name,args)))});
      const allowed=new Set(runtime.specs.map(s=>`mcp__authorize__${s.name}`));
      // Do not forward orchestrator credentials/environment configuration to the child model runtime.
      const childEnv={...process.env};
      for(const key of Object.keys(childEnv)) if(/^(PINGCLI|P1_ACCESS_TOKEN|AUTHORIZE_|API_WORKER_)/.test(key)) delete childEnv[key];
      const stream=query({prompt,options:{
        settingSources:[],systemPrompt:system,tools:[],mcpServers:{authorize:sdk},
        env:childEnv,model:def.model??process.env.P1_SPECIALIST_MODEL??process.env.ANTHROPIC_MODEL,
        maxTurns:input.maxTurns??20,permissionMode:'default',
        canUseTool:async(name,args)=>allowed.has(name)?{behavior:'allow',updatedInput:args}:{behavior:'deny',message:'Outside Authorize tool set.'},
      }});
      for await (const msg of stream) {
        const summary=summarizeSdkMessage(msg);
        if(summary) {
          await log({event:'sdk',...summary});
          if(summary.type==='system')authorizeMcpStatus=summary.authorizeMcpStatus;
          if(summary.type==='assistant') {
            if(summary.blockTypes.includes('tool_use'))assistantToolUseTurns++;
            else if(summary.blockTypes.includes('text'))assistantTextOnlyTurns++;
          }
        }
        if(msg.type==='result') {
          const r=msg as {subtype:string;result?:string};isError=r.subtype!=='success';report=r.result??'';
        }
      }
    } else {
      const ai=new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY});
      const contents:any[]=[{role:'user',parts:[{text:prompt}]}];
      const declarations=runtime.specs.map(s=>{const schema=z.toJSONSchema(s.schema) as any;delete schema.$schema;return {name:s.name,description:s.description,parametersJsonSchema:schema};});
      let completed=false;
      for(let turn=0;turn<(input.maxTurns??20);turn++) {
        const response=await ai.models.generateContent({model:def.model??process.env.P1_SPECIALIST_MODEL??'gemini-2.5-flash',contents,
          config:{systemInstruction:system,tools:[{functionDeclarations:declarations}],automaticFunctionCalling:{disable:true}}});
        const calls=response.functionCalls??[];
        if(!calls.length){report=response.text??'';completed=true;break;}
        if(response.candidates?.[0]?.content)contents.push(response.candidates[0].content);
        const results=[];
        for(const fn of calls)results.push({functionResponse:{id:fn.id,name:fn.name,response:await call(fn.name??'',fn.args??{})}});
        contents.push({role:'user',parts:results});
      }
      if(!completed){isError=true;report='Turn limit reached; inspect recorded tool outcomes before continuing.';}
    }
  } catch(err) {
    isError=true;report='Specialist runtime failed. Check model authentication/configuration privately; inspect tool outcomes before retrying writes.';
    try {await log({event:'runtime_error',name:err instanceof Error?err.name:'unknown'});} catch { /* Keep the original failure. */ }
  }
  const outcome=finalizeAuthorizeRun({mode:context.mode,report,isError:isError||failed,toolCalls,changeAttempts,changeSucceeded,verifiedChanges});
  report=String(sanitize(outcome.report));isError=outcome.isError;
  await log({event:'done',isError,toolCalls:toolCalls.length,changeAttempts,changeSucceeded,verifiedChanges,environmentId:context.environmentId,mode:context.mode});
  callbacks?.onEvent?.({kind:'done',isError,toolCalls:toolCalls.length,ms:Date.now()-start});
  return {sessionId:'',report,toolCalls,toolArgs,isError,logPath,denied,diagnostics:`engine=${engine}; sdkMcp=${authorizeMcpStatus}; assistantTextOnlyTurns=${assistantTextOnlyTurns}; assistantToolUseTurns=${assistantToolUseTurns}; changeAttempts=${changeAttempts}; changeSucceeded=${changeSucceeded}; verifiedChanges=${verifiedChanges}; orchestrator OAuth authentication; fresh dispatch; any tool failure marks the run incomplete`};
}
