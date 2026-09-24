import { z } from 'zod';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const resources = ['policies','attributes','services','versions','apiServers','operations','decisionEndpoints','recentDecisions','deployment','versionTag'] as const;
export const readSchema = z.object({
  resource: z.enum(resources), id: uuid.optional(), parentId: uuid.optional(),
  limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(2048).optional(),
}).strict();
export const changeSchema = z.object({
  action: z.enum(['create','replace','delete','deploy','tag','attach','evaluate']),
  resource: z.enum(resources), id: uuid.optional(), parentId: uuid.optional(),
  // z.record() breaks createSdkMcpServer tools/list in agent-sdk 0.3.278
  // (undefined.push during zod->JSON-Schema conversion), which silently
  // leaves the child model with zero tools. A loose empty object accepts
  // the same bodies (any object with string keys) and converts cleanly.
  body: z.object({}).passthrough().optional(),
}).strict();
export type ReadInput = z.infer<typeof readSchema>;
export type ChangeInput = z.infer<typeof changeSchema>;
export type Mode = 'inspect' | 'author' | 'deploy' | 'evaluate';
export const modeSchema = z.enum(['inspect','author','deploy','evaluate']);
export type Obj = Record<string, any>;
export interface Context {
  environmentId: string;
  allowedEnvironments: string[]; capabilities: string[]; mode: Mode; allowDestructive: boolean;
}
export interface Request { method: 'GET'|'POST'|'PUT'|'DELETE'; path: string; body?: Obj; mediaType?: string }
export type Transport = (request: Request) => Promise<unknown>;

/** A refusal by an orchestrator gate (environment, mode, capability, delete
 *  authorization) as opposed to an API or validation failure. Callers report
 *  the two differently: a refusal means stop and ask; an error means inspect. */
export class GateError extends Error {}

export function contextFromEnv(environmentId: string, mode: unknown = 'inspect', allowDestructive = false): Context {
  const c: Context = { environmentId, mode: modeSchema.parse(mode), allowDestructive,
    allowedEnvironments: (process.env.AUTHORIZE_ENVIRONMENTS ?? '').split(',').map(x=>x.trim()).filter(Boolean),
    capabilities: (process.env.AUTHORIZE_CAPABILITIES ?? 'inspect').split(',').map(x=>x.trim()),
  };
  validateContext(c); return c;
}
/** Read-only inspect works out of the box on the dispatch's environment, like
 *  every other specialist; an AUTHORIZE_ENVIRONMENTS allowlist, when set, still
 *  pins it. Author/deploy/evaluate always require the environment to be listed. */
export function validateContext(c: Context) {
  uuid.parse(c.environmentId);
  modeSchema.parse(c.mode);
  const listed = c.allowedEnvironments.includes(c.environmentId);
  if (c.mode === 'inspect' ? c.allowedEnvironments.length > 0 && !listed : !listed) {
    throw new GateError(c.mode === 'inspect'
      ? 'Target environment is not in AUTHORIZE_ENVIRONMENTS.'
      : `Target environment is not in AUTHORIZE_ENVIRONMENTS; ${c.mode} mode requires it to be listed.`);
  }
  if (!c.capabilities.includes(c.mode)) throw new GateError(`Mode ${c.mode} is disabled by AUTHORIZE_CAPABILITIES.`);
}
const collections: Record<string,string> = { policies:'authorizationPolicies', attributes:'authorizationAttributes', services:'authorizationServices', versions:'authorizationVersions', apiServers:'apiServers', decisionEndpoints:'decisionEndpoints' };
export function route(c: Context, input: ReadInput): string {
  validateContext(c); readSchema.parse(input);
  let path = `environments/${c.environmentId}/`;
  if (collections[input.resource]) {
    if (input.parentId) throw new Error('parentId is only used for operations and recentDecisions.');
    path += collections[input.resource] + (input.id ? `/${input.id}` : '');
  } else if (input.resource === 'operations' || input.resource === 'recentDecisions') {
    if (!input.parentId) throw new Error('parentId is required for this resource.');
    path += input.resource === 'operations' ? `apiServers/${input.parentId}/operations` : `decisionEndpoints/${input.parentId}/recentDecisions`;
    if (input.id) path += `/${input.id}`;
  } else {
    if (!input.id || input.parentId) throw new Error('An exact id and no parentId are required.');
    path += input.resource === 'deployment' ? `apiServers/${input.id}/deployment` : `authorizationVersions/${input.id}/tag`;
  }
  const query = new URLSearchParams();
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.cursor !== undefined) query.set('cursor', input.cursor);
  return path + (query.size ? `?${query}` : '');
}
const secretKey = /^(authorization|proxy-authorization|client.?secret|access.?token|refresh.?token|id.?token|password|credential|client-token|cookie|set-cookie)$/i;
const credentialReference = (v: unknown) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && uuid.safeParse((v as Obj).id).success;
export function sanitize(value: unknown, depth = 0): any {
  if (depth > 40) return '[depth limit]';
  if (Array.isArray(value)) return value.map(x=>sanitize(x,depth+1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,secretKey.test(k) && !credentialReference(v) ? '[REDACTED]' : sanitize(v,depth+1)]));
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return JSON.stringify(sanitize(parsed,depth+1)); } catch {}
    return value.replace(/Bearer\s+[^\s"'\\]+/gi,'Bearer [REDACTED]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED JWT]');
  }
  return value;
}
const secretString = /Bearer\s+[^\s"'\\]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i;
/** Walks the value looking for what sanitize() would redact. Checked directly,
 *  not by comparing re-serialized copies: sanitize() normalizes JSON inside
 *  strings, so a formatted statement payload would otherwise read as a secret. */
function containsSecret(value: unknown, depth = 0): boolean {
  if (depth > 40) return false;
  if (Array.isArray(value)) return value.some(x => containsSecret(x, depth + 1));
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) =>
    (secretKey.test(k) && !credentialReference(v)) || containsSecret(v, depth + 1));
  if (typeof value === 'string') {
    if (secretString.test(value)) return true;
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return containsSecret(parsed, depth + 1); } catch {}
  }
  return false;
}
function assertNoSecrets(value: unknown) {
  if (containsSecret(value)) throw new Error('Secret/token fields are not accepted through the model. Use preconfigured credential references.');
  if (JSON.stringify(value).includes('[REDACTED')) throw new Error('Cannot write a redacted representation.');
}

const apiHosts: Record<string,string> = {
  'mcp.pingone.com':'api.pingone.com', 'mcp.pingone.ca':'api.pingone.ca',
  'mcp.pingone.eu':'api.pingone.eu', 'mcp.pingone.asia':'api.pingone.asia',
  'mcp.pingone.sg':'api.pingone.sg', 'mcp.pingone.com.au':'api.pingone.com.au',
};
export function managementApiBase(mcpUrl: string): URL {
  let mcp: URL;
  try { mcp=new URL(mcpUrl); } catch { throw new Error('Set P1_MCP_URL to the configured PingOne MCP URL.'); }
  const match=mcp.pathname.match(/^\/admin\/([0-9a-f-]{36})\/mcp\/?$/i);
  if(mcp.protocol!=='https:'||!match||!apiHosts[mcp.hostname])throw new Error('P1_MCP_URL must be a supported PingOne regional MCP endpoint.');
  return new URL(`https://${apiHosts[mcp.hostname]}/v1/`);
}
/** Management API transport bound to the orchestrator's in-memory OAuth token. */
export function createOAuthTransport(token: string, mcpUrl: string, fetcher: typeof fetch = fetch): Transport {
  if(!token || /[\r\n]/.test(token))throw new Error('A valid in-memory PingOne OAuth token is required.');
  const base=managementApiBase(mcpUrl);
  return async req=>{
    if(!/^(GET|POST|PUT|DELETE)$/.test(req.method) || /[\s#\\]/.test(req.path) || req.path.includes('..'))throw new Error('Invalid Management API request.');
    const url=new URL(req.path,base);
    if(url.origin!==base.origin || !url.pathname.startsWith('/v1/environments/'))throw new Error('Invalid Management API request.');
    const headers:Record<string,string>={Authorization:`Bearer ${token}`,Accept:'application/json'};
    if(req.body!==undefined)headers['Content-Type']=req.mediaType??'application/json';
    let response:Response;
    try { response=await fetcher(url,{method:req.method,headers,body:req.body===undefined?undefined:JSON.stringify(req.body),signal:AbortSignal.timeout(60000)}); }
    catch { throw new Error('PingOne Management API request failed before a response. For a write, inspect state before retrying.'); }
    if(!response.ok)throw new Error(`PingOne Management API returned HTTP ${response.status}; response details are withheld.`);
    if(response.status===204)return {deleted:true};
    let value:unknown;
    try {value=await response.json();} catch {throw new Error('PingOne Management API returned an unreadable response.');}
    if(!value||typeof value!=='object')throw new Error('PingOne Management API returned a non-object response.');
    return value;
  };
}
function object(value: unknown): Obj {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Expected an object API response.');return value as Obj;
}
function guardExisting(current: Obj, body: Obj|undefined, allowDelete: boolean) {
  if (current.managedEntity && !(current.name==='Custom' && current.managedEntity.restrictions?.disallowChildren===false && body)) throw new Error('Managed node is not an eligible exact Custom container.');
  if (!body) return;
  if (current.id!==body.id)throw new Error('Body id must match the fresh resource read.');
  if (current.version !== undefined && current.version!==body.version)throw new Error('Stale or missing resource version; re-read before replacing.');
  for(const child of current.children ?? []) {
    const next = (body.children ?? []).find((x:Obj)=>x.id===child.id);
    if(!next) {if(!allowDelete)throw new GateError('Replacement removes an existing child; deletion is not authorized.');}
    else {
      if(child.version!==undefined && next.version!==child.version)throw new Error('Stale or missing child version.');
      guardExisting(child,next,allowDelete);
    }
  }
  if(current.managedEntity) {
    for(const child of body.children ?? []) if(!(current.children??[]).some((old:Obj)=>old.id===child.id) && child.type!=='POLICY')throw new Error('New Custom children must be POLICY nodes.');
    for(const key of ['name','enabled','combiningAlgorithm']) if(JSON.stringify(current[key])!==JSON.stringify(body[key]))throw new Error('Preserve Custom container metadata.');
    for(const child of current.children ?? []) {
      const next=(body.children??[]).find((x:Obj)=>x.id===child.id);
      if(!next || !matches(child,next))throw new Error('Custom placement must preserve every existing child unchanged.');
    }
  }
}
/** Compare requested fields, tolerating server-added metadata and stripped RULE/POLICY discriminators. */
function matches(expected: any, actual: any): boolean {
  if(Array.isArray(expected))return Array.isArray(actual) && expected.length===actual.length && expected.every((v,i)=>matches(v,actual[i]));
  if(expected && typeof expected==='object') return actual && typeof actual==='object' && Object.entries(expected).every(([k,v])=>{
    if(k.startsWith('_') || k==='environment' || k==='managedEntity')return true;
    if(k==='version')return true; // versions advance on writes
    if(k==='type' && actual[k]===undefined && (v==='RULE'||v==='POLICY'))return true;
    return matches(v,actual[k]);
  });
  return expected===actual;
}

export class AuthorizeApi {
  constructor(readonly context: Context, private transport: Transport) {validateContext(context);}
  async read(raw: unknown) {const input=readSchema.parse(raw);return sanitize(await this.transport({method:'GET',path:route(this.context,input)}));}
  async change(raw: unknown) {
    const i=changeSchema.parse(raw), c=this.context; validateContext(c);
    const needed=i.action==='deploy'||i.action==='tag'||i.action==='attach' ? 'deploy' : i.action==='evaluate' ? 'evaluate' : 'author';
    if(c.mode!==needed || !c.capabilities.includes(needed))throw new GateError(`This operation requires ${needed} mode and operator capability.`);
    if(i.action==='delete' && (!c.allowDestructive || !c.capabilities.includes('delete')))throw new GateError('Delete is disabled: it requires allowDestructive on the dispatch and the delete capability in AUTHORIZE_CAPABILITIES.');
    if(i.body)assertNoSecrets(i.body);
    if(i.resource==='policies' && i.action==='replace' && i.body?.parent)throw new Error('Policy replacement cannot change parent placement.');
    const path=route(c,{resource:i.resource,id:i.id,parentId:i.parentId});
    if(i.action==='deploy') {
      if(i.resource!=='deployment' || i.body)throw new Error('Deploy requires deployment resource, exact API Server id, and no body.');
      const before=await this.transport({method:'GET',path});
      const result=await this.transport({method:'POST',path,mediaType:'application/vnd.pingidentity.apiserver.deploy+json'});
      const after=await this.transport({method:'GET',path});
      const b=object(before), a=object(after);
      const beforeVersion=b.authorizationVersionId??b.authorizationVersion?.id;
      const afterVersion=a.authorizationVersionId??a.authorizationVersion?.id;
      const status=a.status?.code??a.status;
      const deploymentVerified=status==='DEPLOYMENT_SUCCESSFUL' && typeof afterVersion==='string' && afterVersion.length>0;
      return sanitize({operation:'deploy',before,result,after,deploymentVerified,newVersion:deploymentVerified && beforeVersion!==afterVersion,verification:'Deployment readback only; unchanged versions are not new deployments, and runtime behavior is not tested.'});
    }
    if(i.action==='evaluate') {
      if(i.resource!=='decisionEndpoints'||!i.id||!i.body||typeof i.body.parameters!=='object'||i.body.parameters===null)throw new Error('Evaluation requires a Decision Endpoint id and parameters object.');
      return sanitize(await this.transport({method:'POST',path,body:i.body}));
    }
    if(i.action==='tag') {
      if(i.resource!=='versionTag'||!i.body)throw new Error('Tag requires an exact version id and tag body.');
      await this.transport({method:'PUT',path,body:i.body});return {readback:sanitize(await this.transport({method:'GET',path})),verification:'Tag read back; not attached or runtime tested.'};
    }
    if(i.action==='attach' && (i.resource!=='decisionEndpoints'||!uuid.safeParse((i.body?.authorizationVersion as Obj | undefined)?.id).success))throw new Error('Attach requires a Decision Endpoint and authorizationVersion.id.');
    if(!['policies','attributes','services','apiServers','operations','decisionEndpoints'].includes(i.resource))throw new Error('Resource is not writable with this action.');
    if(i.action==='create') {
      if(i.id||!i.body)throw new Error('Create needs a body and no existing id.');
      if(i.resource==='policies' && (i.body.parent || i.body.type!=='POLICY'))throw new Error('Create only standalone POLICY; AAM placement uses an exact Custom-node replacement.');
      const created=object(await this.transport({method:'POST',path,body:i.body}));
      const id=uuid.parse(created.id);
      const readback=await this.transport({method:'GET',path:route(c,{resource:i.resource,id,parentId:i.parentId})});
      return sanitize({id,readback,requestedFieldsMatch:matches(i.body,readback),verification:'Configuration readback only; inspect placement and effective runtime version separately.'});
    }
    if(!i.id)throw new Error('An exact existing resource id is required.');
    const current=object(await this.transport({method:'GET',path}));
    if(current.id!==i.id)throw new Error('Readback id does not match target.');
    if(i.action==='delete') {guardExisting(current,undefined,false);await this.transport({method:'DELETE',path});return {id:i.id,deleteAccepted:true,verification:'Delete accepted; absence is not independently verified.'};}
    if(!i.body)throw new Error('Replacement needs the complete body.');
    if(i.resource==='decisionEndpoints' && JSON.stringify(current.authorizationVersion)!==JSON.stringify(i.body.authorizationVersion) && i.action!=='attach')throw new Error('Version attachment changes require attach action in deploy mode.');
    guardExisting(current,i.body,c.allowDestructive && c.capabilities.includes('delete'));
    await this.transport({method:'PUT',path,body:i.body});
    const readback=object(await this.transport({method:'GET',path}));
    const childLinks: Obj[]=[];
    if(current.managedEntity)for(const child of readback.children??[]) {
      if(!(current.children??[]).some((old:Obj)=>old.id===child.id)) {
        const found=object(await this.transport({method:'GET',path:route(c,{resource:'policies',id:uuid.parse(child.id)})}));
        const parent=found._links?.parent?.href;
        if(typeof parent!=='string'||!parent.endsWith(`/environments/${c.environmentId}/authorizationPolicies/${i.id}`)||found.managedEntity)throw new Error('Write occurred but child placement/writable-state verification failed. Stop and inspect.');
        childLinks.push({id:found.id,parent});
      }
    }
    return sanitize({id:i.id,readback,childLinks,requestedFieldsMatch:matches(i.body,readback),verification:'Configuration readback only; deployment and runtime outcome are separate.'});
  }
}
