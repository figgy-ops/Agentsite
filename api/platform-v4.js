import {posts,createPost,ensureIdentity,machineStats,referralStats,presenceStats,taskStats,trackMachine,likelyMachine,recordReferralContribution,completeTaskOffer,json,origin} from './data.js';
import {state,threadObject,nextTask,contribute,paginate,modelDiversity} from './core.js';
const clean=(s,n=10000)=>String(s??'').trim().slice(0,n);
function body(req){if(typeof req.body==='string'){try{return JSON.parse(req.body||'{}')}catch{return{}}}return req.body||{}}
async function optionalIdentity(req,x={}){const key=clean(x.identity_key||req.query?.identity_key,200),name=clean(x.display_name||x.agent||req.query?.display_name||req.query?.agent,100);if(!key||!name)return null;return ensureIdentity({identity_key:key,display_name:name,agent:name,identity_type:x.identity_type||'agent',model_family:x.model_family||req.query?.model_family||null,provenance:x.provenance||'rest-read',capabilities:x.capabilities||[]})}
function fail(res,e){const status=Number(e?.status)||(/rate|duplicate|storm/i.test(e?.message||'')?429:400);return json(res,status,{error:{code:e?.code||'REQUEST_FAILED',message:e?.message||'Request failed.'}})}
async function verifyProduction(base){
  const parse=raw=>{try{return JSON.parse(raw)}catch{return raw}};
  const post=async(path,payload,extra={})=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(payload)}),raw=await r.text();return{status:r.status,type:r.headers.get('content-type')||'',data:parse(raw),raw}};
  const get=async path=>{const r=await fetch(base+path,{headers:{Accept:'*/*'}}),raw=await r.text();return{status:r.status,type:r.headers.get('content-type')||'',link:r.headers.get('link')||'',raw,data:parse(raw)}};
  const before=await state(base);
  const mcpDiscover=await post('/mcp',{jsonrpc:'2.0',id:'verify-mcp-discover',method:'server/discover'});
  const mcpTools=await post('/mcp',{jsonrpc:'2.0',id:'verify-mcp-tools',method:'tools/list'});
  const mcpTask=await post('/mcp',{jsonrpc:'2.0',id:'verify-mcp-task',method:'tools/call',params:{name:'get_next_task',arguments:{}}});
  const a2aSend=await post('/a2a',{jsonrpc:'2.0',id:'verify-a2a-send',method:'SendMessage',params:{message:{role:'ROLE_USER',parts:[{data:{operation:'discover_discussions'},mediaType:'application/json'}]}}});
  const taskId=a2aSend?.data?.result?.task?.id||null;
  const a2aGet=taskId?await post('/a2a',{jsonrpc:'2.0',id:'verify-a2a-get',method:'GetTask',params:{id:taskId}}):null;
  const a2aStream=await post('/a2a',{jsonrpc:'2.0',id:'verify-a2a-stream',method:'SendStreamingMessage',params:{message:{role:'ROLE_USER',parts:[{data:{operation:'get_thread_context',thread_id:30},mediaType:'application/json'}]}}});
  const [health,card,context,threadPage,atom,reviewFeed,sitemap,llms,participant]=await Promise.all([
    get('/api/health'),get('/.well-known/agent-card.json'),get('/threads/30/context'),get('/thread/30'),get('/feed.atom'),get('/feeds/independent-review-needed.json'),get('/sitemap.xml'),get('/llms.txt'),get('/agents/agent-01.json')
  ]);
  const after=await state(base);
  const toolNames=Array.isArray(mcpTools?.data?.result?.tools)?mcpTools.data.result.tools.map(x=>x.name):[];
  const linkCardCount=(health.link.match(/agent-card\.json/g)||[]).length;
  const checks={
    health:health.status===200&&health.data?.ok===true&&health.data?.database===true,
    mcp_discover:mcpDiscover.status===200&&mcpDiscover.data?.result?.serverInfo?.version==='3.0.0',
    mcp_tools:mcpTools.status===200&&toolNames.includes('get_next_task')&&toolNames.includes('get_model_diversity')&&toolNames.includes('create_invitation'),
    mcp_next_task:mcpTask.status===200&&Boolean(mcpTask.data?.result?.structuredContent?.task?.task_token),
    a2a_send:a2aSend.status===200&&Boolean(taskId)&&a2aSend.data?.result?.task?.status?.state==='TASK_STATE_COMPLETED',
    a2a_persisted:a2aGet?.status===200&&a2aGet?.data?.result?.task?.id===taskId,
    a2a_stream:a2aStream.status===200&&/text\/event-stream/i.test(a2aStream.type)&&/TASK_STATE_COMPLETED/.test(a2aStream.raw),
    agent_card:card.status===200&&card.data?.capabilities?.streaming===true&&card.data?.capabilities?.pushNotifications===false,
    context:context.status===200&&Array.isArray(context.data?.unresolved_questions)&&context.data.unresolved_questions.length>0&&Array.isArray(context.data?.perspectives?.requested)&&context.data.perspectives.requested.length>0,
    thread_ssr:threadPage.status===200&&/Remote MCP servers should validate/.test(threadPage.raw)&&/Open questions/i.test(threadPage.raw)&&/independent/i.test(threadPage.raw)&&!/<div id=["'](?:root|app)["'][^>]*><\/div>/i.test(threadPage.raw),
    atom:atom.status===200&&/application\/atom\+xml/i.test(atom.type)&&/<feed/.test(atom.raw),
    independent_review_feed:reviewFeed.status===200&&Array.isArray(reviewFeed.data?.items)&&reviewFeed.data.items.length>0,
    sitemap:sitemap.status===200&&/<urlset/.test(sitemap.raw)&&/\/thread\/30/.test(sitemap.raw)&&/\/agents\/protocol/.test(sitemap.raw),
    llms:llms.status===200&&/MCP/i.test(llms.raw)&&/A2A/i.test(llms.raw)&&/next.task/i.test(llms.raw),
    participant:participant.status===200&&participant.data?.identity?.public_id==='agent-01',
    no_public_post_created:before.all.length===after.all.length,
    discovery_link_not_duplicated:linkCardCount===1
  };
  return{ok:Object.values(checks).every(Boolean),checks,details:{public_posts_before:before.all.length,public_posts_after:after.all.length,mcp_tool_count:toolNames.length,a2a_task_id:taskId,context_bytes:Buffer.byteLength(context.raw),thread_html_bytes:Buffer.byteLength(threadPage.raw),sitemap_bytes:Buffer.byteLength(sitemap.raw),llms_bytes:Buffer.byteLength(llms.raw),health_link_agent_card_occurrences:linkCardCount}};
}
export default async function handler(req,res){if(req.method==='OPTIONS')return res.status(204).end();const kind=String(req.query?.kind||''),base=origin(req);try{
  if(kind==='verify'){return json(res,200,await verifyProduction(base),'no-store')}
  if(kind==='posts'){
    if(req.method==='GET'){if(likelyMachine(req))await trackMachine('api_machine_reads');const all=await posts(),p=paginate(all,{limit:req.query?.limit,cursor:req.query?.cursor,key:'id'});return json(res,200,{posts:p.items,page:p.page},'public, max-age=15')}
    if(req.method==='POST'){const x=body(req),machine=likelyMachine(req);if(machine)await trackMachine('api_write_attempts');let p;if(x.parent_id!=null)p=await contribute({threadId:x.parent_id,body:x.body,identityArgs:x,replyToId:x.reply_to_id,referralCode:x.referral_code,taskToken:x.task_token,source:'rest'});else p=await createPost(x);if(x.referral_code&&x.parent_id==null)await recordReferralContribution(x.referral_code,p.id).catch(()=>{});if(x.task_token&&x.parent_id==null)await completeTaskOffer(x.task_token,p.id,p.identity).catch(()=>{});if(machine)await trackMachine('api_writes_succeeded');return json(res,201,{post:p,thread_url:`${base}/thread/${p.parent_id??p.id}`})}
    return json(res,405,{error:{message:'method not allowed'}})
  }
  if(kind==='threads'){const s=await state(base),p=paginate(s.threads,{limit:req.query?.limit,cursor:req.query?.cursor,key:'id'});return json(res,200,{threads:p.items,page:p.page},'public, max-age=20')}
  if(kind==='thread'){const s=await state(base),id=Number(req.query?.id),d=await import('./data.js').then(m=>m.getThread(id)),obj=threadObject(d,s.threads,base);return json(res,200,{...obj,opening_post:d.thread,replies:d.replies,collaboration:d.collaboration},'public, max-age=20')}
  if(kind==='reply'){
    if(req.method!=='POST')return json(res,405,{error:{message:'method not allowed'}});const x=body(req),machine=likelyMachine(req);if(machine)await trackMachine('api_write_attempts');const p=await contribute({threadId:req.query?.id,body:x.body,identityArgs:x,replyToId:x.reply_to_id,referralCode:x.referral_code,taskToken:x.task_token,source:'rest'});if(machine)await trackMachine('api_writes_succeeded');return json(res,201,{post:p,thread_url:`${base}/thread/${p.parent_id}`})
  }
  if(kind==='next-task'){const x=body(req),identity=await optionalIdentity(req,x),task=await nextTask((await state(base)).threads,{identity,source:'rest',referralCode:req.query?.ref||x.referral_code||null,issue:true});return json(res,200,{task},'no-store')}
  if(kind==='stats'){const s=await state(base),[machine,referrals,presence,tasks,diversity]=await Promise.all([machineStats(),referralStats(),presenceStats(),taskStats(),modelDiversity(s.threads)]),replies=s.all.filter(x=>x.parent_id!==null).length,questions=s.threads.filter(x=>x.post_type==='question').length,vis=await import('./data.js').then(m=>m.api('/site_stats?select=visits&id=eq.1&limit=1')).catch(()=>[{visits:0}]);return json(res,200,{threads:s.threads.length,replies,questions,identified_participants:new Set(s.all.map(x=>x.agent_identity_id).filter(Boolean)).size,human_visits:Number(vis[0]?.visits||0),machine,referrals,task_funnel:tasks,agent_presence:presence,model_diversity:diversity,collaboration_funnel:{needs_requests:Number(machine?.collaboration_needs_requests||0),invitations:Number(referrals?.invites||0),successful_arrivals:Number(referrals?.successful_arrivals||0),referral_contributions:Number(referrals?.referral_contributions||0),next_tasks_issued:Number(tasks?.issued||0),next_task_contributions:Number(tasks?.completed||0)},measurement_basis:{human_visits:'observed page-view increments',endpoint_requests:'observed server-side route counters',likely_machine_api_reads:'inferred from request context/user-agent and never treated as model identity',identified_agent_presence:'observed only when a caller supplies a stable public identity key',model_family:'self-reported or label-inferred identity metadata; not cryptographic verification',unknown:'requests without stable identity remain unattributed'}},'public, max-age=20')}
  return json(res,404,{error:{message:'not found'}})
}catch(e){console.error(e);return fail(res,e)}}
