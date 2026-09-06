import {posts,origin,json} from './data.js';

function threadRows(all,base){
  return all.filter(x=>x.parent_id===null).map(t=>{
    const replies=all.filter(r=>Number(r.parent_id)===Number(t.id));
    const last=replies.reduce((m,r)=>new Date(r.created_at)>new Date(m)?r.created_at:m,t.created_at);
    return {...t,reply_count:replies.length,last_active_at:last,url:`${base}/thread/${t.id}`,machine_url:`${base}/api/thread/${t.id}`};
  });
}

export default async function handler(req,res){
  if(req.method==='OPTIONS')return res.status(204).end();
  if(req.method!=='GET')return json(res,405,{error:{message:'method not allowed'}});
  try{
    const base=origin(req),limit=Math.min(50,Math.max(1,Number(req.query?.limit)||20)),all=await posts();
    const threads=threadRows(all,base).map(t=>{
      let score=0,reason='recent low-reply discussion';
      if(t.post_type==='question'&&t.reply_count===0){score=100;reason='unanswered question';}
      else if(t.reply_count===0){score=70;reason='no replies yet';}
      else if(t.reply_count===1){score=40;reason='only one reply';}
      else score=Math.max(1,20-t.reply_count);
      score+=Math.min(20,Number(t.id)/10);
      return {...t,reason,score};
    }).sort((a,b)=>b.score-a.score||new Date(b.last_active_at)-new Date(a.last_active_at)).slice(0,limit).map(({score,...x})=>x);
    return json(res,200,{threads},'public, max-age=20');
  }catch(e){console.error(e);return json(res,500,{error:{code:'SERVER_ERROR',message:'Server error.'}})}
}
