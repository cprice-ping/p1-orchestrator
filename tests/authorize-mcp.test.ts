import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createSdkMcpServer,tool} from '@anthropic-ai/claude-agent-sdk';
import {authorizeRuntime} from '../src/authorize/runtime.js';
import type {Context} from '../src/authorize/api.js';
const id='11111111-1111-4111-8111-111111111111';
test('MCP discovers active specialist and rejects disabled Authorize mode before remote auth/model calls',async()=>{
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/server.ts'],env:{PATH:process.env.PATH??'',AUTHORIZE_ENVIRONMENTS:id,AUTHORIZE_CAPABILITIES:'inspect',P1_ENVIRONMENT_ID:id},stderr:'pipe'});
 const client=new Client({name:'authorize-test',version:'1.0.0'});
 try {
  await client.connect(transport);
  const tools=await client.listTools();assert.equal(tools.tools.length,3);
  const directory=await client.callTool({name:'list_specialists',arguments:{}});
  assert.match(JSON.stringify(directory),/authorize_policy/);
  const out=await client.callTool({name:'dispatch_specialist',arguments:{specialist:'authorize_policy',intent:'Do not make any call; mode rejection test.',environmentId:id,authorizeMode:'author'}});
  assert.equal(out.isError,true);assert.match(JSON.stringify(out),/disabled by AUTHORIZE_CAPABILITIES/);
 } finally {await client.close();}
});

test('SDK tools/list exposes the complete author-mode toolset',async()=>{
 const context:Context={environmentId:id,allowedEnvironments:[id],capabilities:['author'],mode:'author',allowDestructive:false};
 const runtime=authorizeRuntime(context,async()=>({}));
 const sdk=createSdkMcpServer({name:'authorize',version:'0.1.0',tools:runtime.specs.map(s=>
  tool(s.name,s.description,s.schema.shape as any,args=>runtime.call(s.name,args)))});
 const client=new Client({name:'authorize-tool-list-test',version:'1.0.0'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 try {
  await Promise.all([sdk.instance.connect(serverTransport),client.connect(clientTransport)]);
  const listing=await client.listTools();
  assert.deepEqual(listing.tools.map(t=>t.name).sort(),['authorize_change','authorize_read','authorize_reference']);
 } finally {
  await client.close();
  await sdk.instance.close();
 }
});
