import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeAuthorizeRun, summarizeSdkMessage } from '../src/authorize/run-evidence.js';

const base = {mode:'author' as const,report:'I will read the rule first.',isError:false,
  toolCalls:[] as string[],changeAttempts:0,changeSucceeded:0,verifiedChanges:0};

test('a text-only author run reports no action and fails closed',()=>{
  const outcome=finalizeAuthorizeRun(base);
  assert.equal(outcome.isError,true);
  assert.match(outcome.report,/no PingOne Authorize read or change was performed/);
});

test('author reads without a change cannot report a completed edit',()=>{
  const outcome=finalizeAuthorizeRun({...base,toolCalls:['authorize_reference','authorize_read']});
  assert.equal(outcome.isError,true);
  assert.match(outcome.report,/no requested change/);
});

test('a successful configuration replacement requires verified readback',()=>{
  const unverified=finalizeAuthorizeRun({...base,report:'Updated.',toolCalls:['authorize_change'],changeAttempts:1,changeSucceeded:1});
  assert.equal(unverified.isError,true);
  assert.match(unverified.report,/may have written configuration/);
  const verified=finalizeAuthorizeRun({...base,report:'Updated.',toolCalls:['authorize_change'],changeAttempts:1,changeSucceeded:1,verifiedChanges:1});
  assert.equal(verified.isError,false);
});

test('SDK diagnostics include only event shape, never text, arguments, or error detail',()=>{
  assert.deepEqual(summarizeSdkMessage({type:'system',subtype:'init',mcp_servers:[{name:'authorize',status:'connected',error:'secret'}]}),
    {type:'system',subtype:'init',authorizeMcpStatus:'connected'});
  assert.deepEqual(summarizeSdkMessage({type:'assistant',message:{content:[{type:'text',text:'secret'},{type:'tool_use',input:{token:'secret'}}]}}),
    {type:'assistant',blockTypes:['text','tool_use']});
  assert.deepEqual(summarizeSdkMessage({type:'result',subtype:'success',result:'secret'}),
    {type:'result',subtype:'success'});
  assert.equal(summarizeSdkMessage({type:'system',subtype:'init',mcp_servers:[{name:'authorize',status:'secret'}]})?.authorizeMcpStatus,
    'not reported');
});
