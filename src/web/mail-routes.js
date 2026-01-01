// Owner-only routes. index.js checks same-origin + CSRF before every POST.
import {mailError, safeFilename, validateCompose} from '../mail/message.js';
import {sanitizeHtml, htmlDocument} from '../mail/sanitize.js';
import {ATTACHMENT_LIMIT, groupThreads} from './public/mail-helpers.js';
import {ACCOUNT_ID} from '../mail/config.js';

const UID = value => Number.isInteger(value) && value > 0 && value <= 4294967295;
export function createMailRoutes(ctx, {readJson, onlyKeys, fail, json}) {
  const store = ctx.mail;
  const composeKeys=['from','to','cc','bcc','subject','text','attachments','inReplyTo','references','related','draftUid','sendId'];
  async function account(id) { if(!ACCOUNT_ID.test(id)) throw fail(404); const a=store.getAccount?await store.getAccount(id):(await store.accounts()).find(a=>a.id===id); if(!a) throw fail(404); return a; }
  async function folder(id,path) { if(typeof path!=='string' || path.length>1024 || /[\x00-\x1f\x7f]/.test(path) || !(await store.folders(id)).some(f=>f.path===path)) throw fail(404); return path; }
  function uid(value) { if(!UID(value)) throw mailError(400,'Choose a valid message.'); return value; }
  function uids(values) { if(!Array.isArray(values) || !values.length || values.length>50) throw mailError(400,'Select up to 50 messages.'); return [...new Set(values.map(uid))]; }
  async function compose(id,input,draft,mailbox) {
    onlyKeys(input,composeKeys);
    const a=mailbox||await account(id);
    if(input.draftUid!==undefined && input.draftUid!==null) uid(input.draftUid);
    if(input.related) {
      onlyKeys(input.related,['folder','uid','mode']); await folder(id,input.related.folder); uid(input.related.uid);
      if(!['reply','forward'].includes(input.related.mode)) throw fail(400);
    }
    if(!Array.isArray(input.attachments) || input.attachments.length>50) throw fail(400);
    // Existing attachments are copied on the server, never fetched from a client-supplied URL or disk path.
    const folders=new Map(),attachments=[];let cachedKey,cachedAttachments,total=0;
    for(const item of input.attachments) {
      if(!item || typeof item!=='object') throw fail(400);
      onlyKeys(item,['filename','type','size','content','source','index','inline','contentId']);
      if(!item.source) {
        if(typeof item.content!=='string')throw fail(400);
        total+=item.content.length/4*3-(item.content.endsWith('==')?2:item.content.endsWith('=')?1:0);
        attachments.push(item);
      } else {
        const source=item.source;onlyKeys(source,['folder','uid','index']);
        if(!folders.has(source.folder))folders.set(source.folder,folder(id,source.folder));
        await folders.get(source.folder);uid(source.uid);
        if(!Number.isInteger(source.index)||source.index<0||source.index>100)throw fail(400);
        const key=JSON.stringify([source.folder,source.uid]);let attachment;
        if(store.allAttachments){
          if(cachedKey!==key){cachedAttachments=await store.allAttachments(id,source.folder,source.uid);cachedKey=key;}
          attachment=cachedAttachments[source.index];
        } else attachment=await store.attachment(id,source.folder,source.uid,source.index);
        if(!attachment)throw fail(404);
        total+=attachment.content.length;
        if(total>ATTACHMENT_LIMIT)throw mailError(413,'Attachments must total 18 MB or less.');
        attachments.push({filename:attachment.filename,type:attachment.type,content:Buffer.from(attachment.content).toString('base64')});
      }
      if(total>ATTACHMENT_LIMIT)throw mailError(413,'Attachments must total 18 MB or less.');
    }
    input.attachments=attachments;
    validateCompose(a,input,{draft}); // Also applied by real and fake stores. Reject From even with an injected store.
    return input;
  }
  return async (req,res,path,session) => {
    if(!session || session.operator) throw fail(404);
    if(!store) throw mailError(503,'Mail is not available.');
    const method=req.method==='HEAD'?'GET':req.method, params=new URL(req.url,'http://local').searchParams;
    if(path==='/api/mail/accounts' && method==='GET') return json(res,200,{accounts:await store.accounts()});
    if(path==='/api/mail/inboxes' && method==='GET') {
      const page=Number(params.get('page')||1),search=params.get('search')||'';
      if(!Number.isInteger(page)||page<1||page>10||search.length>500||/[\x00-\x1f]/.test(search)) throw fail(400);
      const accounts=(await store.accounts()).filter(a=>a.connected), collected=[];let total=0,partial=false;
      for(const a of accounts) {
        try {
          const inbox=(await store.folders(a.id)).find(f=>f.role==='inbox');if(!inbox)continue;
          for(let p=1;p<=page;p++) {
            const result=await store.list(a.id,{folder:inbox.path,page:p,search,allFolders:params.get('all')==='1',starred:false});
            if(p===1)total+=result.total;
            collected.push(...result.messages.map(m=>({...m,account:a.id})));partial ||= !!result.partial;
            if(!result.hasMore)break;
          }
        } catch { partial=true; }
      }
      collected.sort((a,b)=>Date.parse(b.date)-Date.parse(a.date)||b.uid-a.uid);
      const messages=collected.slice((page-1)*50,page*50);
      const threads=accounts.flatMap(a=>groupThreads(messages.filter(m=>m.account===a.id))).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
      return json(res,200,{messages,threads,total,page,hasMore:page<10&&page*50<total,partial:partial||total>500});
    }
    const match=/^\/api\/mail\/([a-z][a-z0-9_-]{0,39})\/(folders|messages|message|conversation|attachment|inline|raw|body|flags|move|send|draft|discard)$/.exec(path);
    if(!match) throw fail(404);
    const [,id,action]=match;
    const mailbox=await account(id);
    const getActions=['folders','messages','message','conversation','attachment','inline','raw','body'];
    if((getActions.includes(action)?'GET':'POST')!==method) throw fail(405);
    if(action==='folders') return json(res,200,{folders:await store.folders(id)});
    if(action==='messages') {
      const path=await folder(id,params.get('folder')), page=Number(params.get('page') || 1), search=params.get('search') || '';
      if(!Number.isInteger(page) || page<1 || page>10000 || search.length>500 || /[\x00-\x1f]/.test(search)) throw fail(400);
      return json(res,200,await store.list(id,{folder:path,page,search,allFolders:params.get('all')==='1',starred:params.get('starred')==='1'}));
    }
    if(getActions.includes(action)) {
      const path=await folder(id,params.get('folder')), messageUid=uid(Number(params.get('uid')));
      if(action==='message') return json(res,200,{message:await store.message(id,path,messageUid)});
      if(action==='conversation') return json(res,200,{messages:await store.conversation(id,path,messageUid)});
      if(action==='raw') { res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'inline','Content-Security-Policy':"default-src 'none'; sandbox"}); return res.end(req.method==='HEAD'?undefined:await store.raw(id,path,messageUid)); }
      if(action==='body') {
        const message=await store.message(id,path,messageUid), remote=params.get('images')==='1';
        // Embed validated CID images as data after reading through the same attachment interface.
        // Opaque sandbox origins cannot reliably send SameSite cookies for image subrequests.
        const inline=new Map();
        const all=store.allAttachments?await store.allAttachments(id,path,messageUid):null;
        for(const a of message.attachments.filter(a=>a.contentId && /^image\/(png|jpeg|gif|webp)$/.test(a.type)).slice(0,20)) {
          const full=all?.[a.index]||await store.attachment(id,path,messageUid,a.index);
          if(full.size<=5*1024*1024) inline.set(a.contentId,`data:${a.type};base64,${Buffer.from(full.content).toString('base64')}`);
        }
        const sanitized=sanitizeHtml(message.html,{remote,inlineUrl:cid=>inline.get(cid)||''});
        res.setHeader('X-Frame-Options','SAMEORIGIN');
        res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'unsafe-inline'; img-src data:${remote?' https: http:':''}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox`);
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        return res.end(req.method==='HEAD'?undefined:htmlDocument(sanitized.html));
      }
      const index=Number(params.get('index'));
      if(!Number.isInteger(index) || index<0 || index>100) throw fail(400);
      const a=await store.attachment(id,path,messageUid,index);
      const inline=action==='inline';
      if(inline && !/^image\/(png|jpeg|gif|webp)$/.test(a.type)) throw fail(404);
      const filename=safeFilename(a.filename), ascii=filename.replace(/[^\x20-\x7e]/g,'_');
      res.writeHead(200,{'Content-Type':inline?a.type:'application/octet-stream','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':`${inline?'inline':'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`,
        'Content-Length':a.content.length});
      return res.end(req.method==='HEAD'?undefined:a.content);
    }
    // Node's server.requestTimeout limits receipt of the request, not the time to send a response.
    // SMTP has its own 120 s operation deadline; extend this socket only, after normal CSRF gating.
    if(action==='send') req.setTimeout?.(180_000);
    const input=await readJson(req,['send','draft'].includes(action)?25*1024*1024:32*1024);
    if(action==='send' || action==='draft') {
      if(action==='send' && (typeof input.sendId!=='string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.sendId))) throw fail(400);
      await compose(id,input,action==='draft',mailbox);
      return json(res,200,await store[action==='send'?'send':'saveDraft'](id,input));
    }
    if(action==='discard') { onlyKeys(input,['uid']); return json(res,200,await store.deleteDraft(id,uid(input.uid))); }
    if(action==='flags') {
      onlyKeys(input,['folder','uids','seen','flagged']); const flags={};
      for(const k of ['seen','flagged']) if(input[k]!==undefined) { if(typeof input[k]!=='boolean') throw fail(400); flags[k]=input[k]; }
      if(!Object.keys(flags).length) throw fail(400);
      return json(res,200,await store.flags(id,await folder(id,input.folder),uids(input.uids),flags));
    }
    if(action==='move') {
      onlyKeys(input,['folder','uids','role','destination']);
      if(input.role && !['archive','trash','junk','notjunk'].includes(input.role) || !!input.role===!!input.destination) throw fail(400);
      if(input.destination) await folder(id,input.destination);
      return json(res,200,await store.move(id,await folder(id,input.folder),uids(input.uids),input));
    }
    throw fail(404);
  };
}
