import { AuthorizeApi, GateError, readSchema, changeSchema, sanitize, type Context, type Transport } from './api.js';
import { reference, referenceSchema } from './knowledge.js';
import { z } from 'zod';
export function authorizeRuntime(context: Context, transport: Transport) {
  const api=new AuthorizeApi(context,transport);
  const specs=[
    {name:'authorize_read',description:'Read/list Authorize policies, attributes, services, versions, API Servers/operations, Decision Endpoints/history, deployment or version tag. Environment is fixed by dispatch. Use parentId for operations/history. Collections may be paginated; inspect links and use cursor, never claim a partial list is complete.',schema:readSchema, run:(args:unknown)=>api.read(args)},
    {name:'authorize_change',description:'Execute an Authorize create/replace/delete, tag, deploy, or direct evaluation. Mode/capability gates apply in code. Full replacements need exact id and fresh versions, preserving existing children. Body is JSON, no tokens or secrets. Changes return readback evidence, not a claim of runtime success.',schema:changeSchema,run:(args:unknown)=>api.change(args)},
    {name:'authorize_reference',description:'Read one complete EA Authorize skill reference. Read policy-and-rule-authoring and condition-evaluation-and-nulls before authoring. No shell or arbitrary filesystem access.',schema:referenceSchema,run:reference},
  ];
  return {
    specs: specs.filter(s=>s.name!=='authorize_change'||context.mode!=='inspect'),
    async call(name:string,args:unknown) {
      const spec=specs.find(s=>s.name===name);
      try {
        if(!spec || (name==='authorize_change'&&context.mode==='inspect'))throw new GateError('Tool not available in this dispatch.');
        const result=await spec.run(args);
        const incomplete=typeof result==='object' && result!==null && (('requestedFieldsMatch' in result && result.requestedFieldsMatch===false)||('deploymentVerified' in result && result.deploymentVerified===false));
        return {content:[{type:'text' as const,text:typeof result==='string'?result:JSON.stringify(sanitize(result))}],isError:incomplete};
      } catch(err) {
        // Schema errors report structure only; suppress echoed input values.
        const message=err instanceof z.ZodError?'Invalid tool input schema. Use documented resource/action and UUID fields only.':err instanceof Error?err.message:'Tool failed';
        return {content:[{type:'text' as const,text:String(sanitize(message))}],isError:true,refused:err instanceof GateError};
      }
    },
  };
}
