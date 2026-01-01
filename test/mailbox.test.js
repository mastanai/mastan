// Real web routing and MIME code, in-memory HTTP/IMAP/SMTP. Never opens a socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createFakeMail} from './mail-fixture.mjs';
import {sanitizeHtml} from '../src/mail/sanitize.js';
import {validateCompose,composeRaw,parseMessage,externalAuth} from '../src/mail/message.js';
import {groupThreads,parseSearch,replyFields,mailDate,mailDateTime,recipientSummary,ATTACHMENT_LIMIT} from '../src/web/public/mail-helpers.js';
import {MailStore} from '../src/mail/store.js';
import {loadAccounts,credentials} from '../src/mail/config.js';

const data=mkdtempSync(join(tmpdir(),'mailbox-test-'));
process.env.MASTAN_ME_DATA=data;
const {config}=await import('../src/config.js');
const {MailboxAlerts}=await import('../src/jobs/mailbox-alerts.js');
const {openDb}=await import('../src/db.js');
const {createWeb,COOKIE}=await import('../src/web/index.js');
const A=await import('../src/web/auth.js');
const db=openDb();
A.addCredential(db,{id:'mail-fixture-owner',publicKey:new Uint8Array(32).fill(3)});
const owner=A.createSession(db,'mail-fixture-owner'),operator=A.createSession(db,A.OPERATOR);
const mail=await createFakeMail();
const web=createWeb({config,db,mail,atlas:{stats:()=>({})}});
test.after(()=>{db.close();rmSync(data,{recursive:true,force:true});});
function request(path,{session=owner,method='GET',body,csrf=true,origin=config.origin,handler=web}={}){
  return new Promise((resolve,reject)=>{
    const payload=body===undefined?null:Buffer.from(JSON.stringify(body));
    const req=Readable.from(payload?[payload]:[]);req.url=path;req.method=method;
    req.headers={host:config.host,...(session?{cookie:`${COOKIE}=${session.value}`} :{}),...(method==='POST'?{origin,...(csrf&&session?{'x-csrf-token':session.csrf}:{})}:{}),...(payload?{'content-type':'application/json','content-length':String(payload.length)}:{})};
    req.socket={localPort:3100,remoteAddress:'127.0.0.1'};req.setTimeout=ms=>req.timeout=ms;
    const headers={};const res={headersSent:false,statusCode:200,setHeader(k,v){headers[k.toLowerCase()]=v;},getHeader(k){return headers[k.toLowerCase()];},
      writeHead(code,values={}){this.statusCode=code;this.headersSent=true;for(const [k,v] of Object.entries(values))this.setHeader(k,v);},
      end(value){const buffer=Buffer.isBuffer(value)?value:Buffer.from(value||'');const text=buffer.toString();let json;try{json=JSON.parse(text);}catch{}resolve({status:this.statusCode,headers,text,json,buffer,timeout:req.timeout});}};
    handler(req,res).catch(reject);
  });
}
const query=(action,values)=>`/api/mail/hello/${action}?${new URLSearchParams(values)}`;
const input=()=>({from:'hello@example.com',to:[{address:'reader@example.net',name:'Reader'}],cc:[],bcc:[],subject:'Fixture subject',text:'Plain text only.\n.line',attachments:[]});

test('mail page and every API are invisible to operators and signed-out visitors',async()=>{
  for(const session of [operator,null])for(const path of ['/mail','/mail/','/api/mail/accounts',query('message',{folder:'Inbox',uid:1})])assert.equal((await request(path,{session})).status,404,path);
  const page=await request('/mail');assert.equal(page.status,200);assert.match(page.text,/render|mail\.js/);assert.match(page.text,/type="module"/);assert.match(page.text,/mail\.css/);
  assert.match(page.headers['content-security-policy'],/frame-src 'self'/);assert.doesNotMatch((await request('/fleet')).headers['content-security-policy'],/frame-src/);
  assert.match(page.text,/href="\/mail" aria-current="page"/);assert.doesNotMatch((await request('/chat',{session:operator})).text,/href="\/mail"/);
  assert.equal((await request('/api/mail/accounts')).json.accounts.length,2);
});

test('All inboxes merge accounts chronologically into at most 50 messages per page',async()=>{
  const response=await request('/api/mail/inboxes');assert.equal(response.status,200,response.text);
  assert.ok(response.json.messages.length<=50);assert.deepEqual([...new Set(response.json.messages.map(m=>m.account))].sort(),['archive','hello']);
  for(let i=1;i<response.json.messages.length;i++)assert.ok(Date.parse(response.json.messages[i-1].date)>=Date.parse(response.json.messages[i].date));
  assert.equal((await request('/api/mail/inboxes?page=11')).status,400);
});

test('mail writes require CSRF, the exact origin, JSON and POST',async()=>{
  const path='/api/mail/hello/draft';
  assert.equal((await request(path,{method:'POST',body:input(),csrf:false})).status,403);
  assert.equal((await request(path,{method:'POST',body:input(),origin:'https://example.net'})).status,403);
  assert.equal((await request(path)).status,405);
});

test('account, folder, UID, flags and destination validation stops before store work',async()=>{
  assert.equal((await request('/api/mail/missing/folders')).status,404);
  assert.equal((await request(query('messages',{folder:'Inbox\r\nNOOP'}))).status,404);
  for(const uid of ['0','-1','4294967296','1:*','NaN'])assert.equal((await request(query('message',{folder:'Inbox',uid}))).status,400,uid);
  assert.equal((await request('/api/mail/hello/flags',{method:'POST',body:{folder:'Inbox',uids:[1],seen:'true'}})).status,400);
  assert.equal((await request('/api/mail/hello/move',{method:'POST',body:{folder:'Inbox',uids:[1],role:'delete'}})).status,400);
  assert.equal((await request('/api/mail/hello/move',{method:'POST',body:{folder:'Inbox',uids:[1],destination:'unlisted'}})).status,404);
  assert.equal((await request('/api/mail/hello/discard',{method:'POST',body:{uid:0}})).status,400);
});

test('From restriction, recipient/header validation and attachment wire limits apply with a fake store',async()=>{
  for(const change of [{from:'forged@example.net'},{subject:'x\r\nBcc: victim@example.net'},{to:[{address:'bad'}]},{html:'<b>no</b>'},{attachments:[{filename:'x',content:'not base64',type:'text/plain'}]}]){
    const r=await request('/api/mail/hello/draft',{method:'POST',body:{...input(),...change}});assert.equal(r.status,400,r.text);
  }
  assert.equal(ATTACHMENT_LIMIT,18*1024*1024);
  assert.throws(()=>validateCompose(mail.definitions[0],{...input(),attachments:[{filename:'large',type:'text/plain',content:Buffer.alloc(ATTACHMENT_LIMIT+1).toString('base64')}]}),/18 MB/);
});

test('draft replacement retains Bcc, attachments and reply headers, and Send only follows explicit POST',async()=>{
  const fields={...input(),bcc:[{address:'hidden@example.net'}],inReplyTo:'<original@example.net>',references:['<root@example.net>','<original@example.net>'],attachments:[{filename:'note.txt',type:'text/plain',content:Buffer.from('attached fixture').toString('base64')}]};
  const draft=await request('/api/mail/hello/draft',{method:'POST',body:fields});assert.equal(draft.status,200,draft.text);
  const first=draft.json.uid;
  const opened=(await request(query('message',{folder:'Drafts',uid:first}))).json.message;
  assert.equal(opened.bcc[0].address,'hidden@example.net');assert.equal(opened.inReplyTo,'<original@example.net>');assert.equal(opened.attachments.length,1);
  const second=await request('/api/mail/hello/draft',{method:'POST',body:{...fields,draftUid:first,text:'Revised'}});assert.equal(second.status,200,second.text);
  assert.equal((await request(query('message',{folder:'Drafts',uid:first}))).status,404);
  const before=mail.sentCount;assert.equal((await request('/api/mail/hello/send')).status,405);assert.equal(mail.sentCount,before);
  const sent=await request('/api/mail/hello/send',{method:'POST',body:{...fields,draftUid:second.json.uid,sendId:'fixture-send-1234567'}});
  assert.equal(sent.status,200,sent.text);assert.equal(sent.timeout,180000);assert.equal(mail.sentCount,before+1);
  assert.equal((await request(query('message',{folder:'Drafts',uid:second.json.uid}))).status,404);
});

test('HTML is reconstructed, active content is removed and remote images require an explicit request',()=>{
  const raw='<base href="https://evil.example"><meta http-equiv="refresh" content="0;url=x"><script>alert(1)</script><div onclick="x()" style="color: red; background-image:url(https://evil.example);width:100%">Safe</div><form><input><button>submit</button></form><svg><a href="x">x</a></svg><iframe srcdoc="x"></iframe><object data="x"></object><embed src="x"><img src="https://example.net/a.png" onerror="x()"><img src="cid:logo"><a href="&#106;avascript:alert(2)">bad</a><a href="data:text/html,x">bad</a><a target="_self" href="https://example.net/?a=1&amp;b=2">good</a>';
  const clean=sanitizeHtml(raw,{inlineUrl:cid=>cid==='logo'?'/api/mail/hello/inline?x=1':''});
  assert.doesNotMatch(clean.html,/<(?:script|form|object|iframe|embed|svg|base|meta)\b|onerror|onclick|javascript:|data:text|background-image|src="https:/i);
  assert.match(clean.html,/Safe/);assert.match(clean.html,/color: red/);assert.match(clean.html,/target="_blank" rel="noopener noreferrer"/);
  assert.match(clean.html,/src="\/api\/mail/);assert.equal(clean.hiddenImages,true);
  assert.match(sanitizeHtml(raw,{remote:true}).html,/src="https:\/\/example.net\/a.png"/);
  for(const hostile of ['<IMG SRC=jav&#x61;script:alert(1)>','<a href="java\nscript:x">x</a>','<a href="&colon;javascript:x">x</a>','<img src="data:image/svg+xml;base64,PHN2Zz4=">','<scr<script>ipt>alert(1)</scr<script>ipt>','<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">']){
    const safe=sanitizeHtml(hostile).html;assert.doesNotMatch(safe,/<script\b|onerror=|src="javascript:|href="java|src="data:image\/svg/i,safe);
  }
});

test('newsletter layout survives the allowlist; CSS url, image-set, var, @import and odd display values do not',()=>{
  const out=sanitizeHtml('<div style="display:none !important;max-height:0;overflow:hidden">preheader</div><table width="600" border="0" cellpadding="8" onload="x"><tr><td bgcolor="#f0f0f0" align="center" valign="top" style="background:url(https://example.net/a.png);color:#123">a</td></tr></table><p style="background:image-set(\'x\' 1x);color:var(--x);display:-webkit-box;font-size:14px">b</p><img width="120" height="40" src="cid:none"><style>@import url(https://example.net/x.css);</style>').html;
  assert.match(out,/style="display:none;max-height:0;overflow:hidden"/);assert.match(out,/<table width="600" cellpadding="8" border="0">/);assert.match(out,/<td align="center" valign="top" bgcolor="#f0f0f0" style="color:#123">/);
  assert.match(out,/<p style="font-size:14px">/);assert.doesNotMatch(out,/url|image-set|var\(|import|onload|webkit/i);assert.match(out,/<img width="120" height="40">/);
});
test('mail body gets its own sandbox CSP, downloads are attachment/nosniff and raw is plain text',async()=>{
  const newsletter=mail.rows.get('hello').find(m=>m.html.includes('newsletter'));
  const body=await request(query('body',{folder:newsletter.folder,uid:newsletter.uid}));assert.equal(body.status,200,body.text);
  assert.match(body.headers['content-security-policy'],/default-src 'none'/);assert.match(body.headers['content-security-policy'],/sandbox/);assert.doesNotMatch(body.headers['content-security-policy'],/allow-scripts|allow-same-origin|img-src[^;]*https:/);
  assert.doesNotMatch(body.text,/src="https:/);assert.match((await request(query('body',{folder:newsletter.folder,uid:newsletter.uid,images:1}))).text,/src="https:/);
  const m=mail.rows.get('hello').find(m=>m.attachments.length&&!m.attachments[0].inline);
  const attachment=await request(query('attachment',{folder:m.folder,uid:m.uid,index:0}));assert.equal(attachment.status,200);assert.match(attachment.headers['content-disposition'],/^attachment; filename=/);assert.equal(attachment.headers['x-content-type-options'],'nosniff');assert.equal(attachment.headers['content-type'],'application/octet-stream');
  const raw=await request(query('raw',{folder:m.folder,uid:m.uid}));assert.match(raw.headers['content-type'],/^text\/plain/);
  const svg={...m.attachments[0],type:'image/svg+xml'};const original=m.attachments[0];m.attachments[0]=svg;
  assert.equal((await request(query('inline',{folder:m.folder,uid:m.uid,index:0}))).status,404);m.attachments[0]=original;
});

test('reply, reply all and forward build exact recipients, threading, quotes and attachment references',()=>{
  const m={uid:77,folder:'Inbox',from:{name:'Mira',address:'mira@example.net'},replyTo:[{address:'reply@example.net'}],to:[{address:'hello@example.com'},{address:'reader@example.net'}],cc:[{address:'studio@example.com'},{address:'copy@example.net'},{address:'reader@example.net'}],subject:'Re: Workshop',text:'one\ntwo',date:'2026-11-13',messageId:'<m@example.net>',references:['<root@example.net>'],attachments:[{index:0,filename:'x.txt'}]};
  const reply=replyFields(m,mail.definitions[0]);assert.deepEqual(reply.to,[{address:'reply@example.net'}]);assert.equal(reply.subject,'Re: Workshop');assert.match(reply.text,/> one\n> two/);assert.equal(reply.inReplyTo,m.messageId);assert.deepEqual(reply.references,['<root@example.net>',m.messageId]);
  const all=replyFields(m,mail.definitions[0],'replyAll');assert.deepEqual(all.to.map(a=>a.address),['reply@example.net','reader@example.net']);assert.deepEqual(all.cc.map(a=>a.address),['copy@example.net']);
  const ownReply=replyFields({...m,from:mail.definitions[0].addresses[0],replyTo:[],to:[{address:'reader@example.net'}]},mail.definitions[0]);assert.deepEqual(ownReply.to,[{address:'reader@example.net'}]);
  const across=replyFields({...m,cc:[{address:'events@example.com'}]},mail.definitions[0],'replyAll',mail.definitions.flatMap(a=>a.addresses));assert.deepEqual(across.cc,[]);
  const forward=replyFields(m,mail.definitions[0],'forward');assert.equal(forward.inReplyTo,'');assert.deepEqual(forward.references,[]);assert.match(forward.subject,/^Fwd:/);assert.match(forward.text,/Forwarded message/);assert.doesNotMatch(forward.text,/\d{4}-\d\d-\d\dT/);assert.match(replyFields({...m,date:'2026-02-05T12:00:00Z'},mail.definitions[0]).text,/On 5 Feb 2026 15:00, /);assert.deepEqual(forward.attachments[0].source,{folder:'Inbox',uid:77,index:0});
});

test('thread grouping follows reference chains, then subjects with overlapping participants',()=>{
  const row=(uid,subject,messageId,references=[],from='a@example.net')=>({uid,subject,messageId,references,from:{address:from},to:[{address:'hello@example.com'}],date:new Date(2026,0,uid).toISOString(),seen:uid!==1});
  const threads=groupThreads([row(1,'Original','<a@x>'),row(2,'Changed','<b@x>',['<a@x>']),row(3,'Changed again','<c@x>',['<b@x>']),row(4,'Note','<d@x>'),row(5,'Re: Note','<e@x>')]);
  assert.equal(groupThreads([{...row(1,'Same draft','<draft1@x>'),draft:true},{...row(2,'Same draft','<draft2@x>'),draft:true}]).length,2);
  assert.equal(threads.length,2);assert.equal(threads.find(t=>t.count===3).seen,false);assert.equal(threads[0].uid,5);
  assert.equal(groupThreads([{...row(1,'Same','<1@x>'),to:[]},{...row(2,'Same','<2@x>',[],'z@example.net'),to:[]}]).length,2);
});

test('search parser and Riyadh date formatting cover every supported operator',()=>{
  assert.deepEqual(parseSearch('from:"Mira Veylan" to:hello@example.com subject:"Weekly notes" has:attachment is:unread is:starred free words'),{from:'Mira Veylan',to:'hello@example.com',subject:'Weekly notes',attachment:true,seen:false,flagged:true,text:'free words'});
  const now=new Date('2026-11-13T12:00:00Z');assert.equal(mailDate('2026-11-13T09:04:00Z',now),'12:04');assert.equal(mailDate('2026-02-05T12:00:00Z',now),'5 Feb');assert.equal(mailDate('2025-02-05T12:00:00Z',now),'5 Feb 2025');assert.equal(mailDate('bad',now),'');
  assert.equal(mailDateTime('2026-02-05T12:00:00Z',now),'5 Feb 15:00');assert.equal(mailDateTime('2025-02-05T12:00:00Z',now),'5 Feb 2025 15:00');
  assert.equal(recipientSummary({to:[{address:'Hello@example.com'}],cc:[{name:'Review group',address:'r@example.net'}]},[{address:'hello@example.com'}]),'to me, Review group');
  assert.equal(recipientSummary({to:[]}),'to undisclosed recipients');
});

test('MIME is plain text with a mastan.ai id, Bcc only in drafts, and AUTH EXTERNAL checks 235',async()=>{
  const fields=validateCompose(mail.definitions[0],{...input(),bcc:[{address:'hidden@example.net'}]});
  const raw=await composeRaw(fields);assert.match(raw.toString(),/Content-Type: text\/plain/);assert.match(raw.toString(),/Message-ID: <[^>]+@mastan.ai>/i);assert.doesNotMatch(raw.toString(),/^Bcc:/mi);
  assert.match((await composeRaw(fields,true)).toString(),/^Bcc: hidden@example.net/mi);
  let command;await externalAuth({sendCommand:async c=>{command=c;return {status:235};}});assert.equal(command,'AUTH EXTERNAL =');
  await assert.rejects(externalAuth({sendCommand:async()=>({status:535,text:'Certificate refused'})}),/Certificate refused/);
});

test('config overrides, hidden accounts and missing certificates stay independent',async()=>{
  const missing=new MailStore({config});assert.equal((await missing.accounts()).length,2);assert.ok((await missing.accounts()).every(a=>!a.connected&&/certificate/.test(a.reason)));
  mkdirSync(join(data,'config'),{recursive:true});const defs=JSON.parse(JSON.stringify(loadAccounts(config)));defs[1].hidden=true;writeFileSync(join(data,'config','mail-accounts.json'),JSON.stringify(defs));assert.deepEqual(loadAccounts(config).map(a=>a.id),['hello']);
  rmSync(join(data,'config','mail-accounts.json'));await missing.shutdown();
  // Present but damaged PEM files are "not connected", never a socket-library throw.
  const cert=join(data,'broken.crt'),key=join(data,'broken.key');writeFileSync(cert,'not a certificate');writeFileSync(key,'not a key');
  assert.equal(credentials({certFile:cert,keyFile:key}),null);assert.equal(credentials({certFile:join(data,'absent.crt'),keyFile:key}),null);
  const broken=new MailStore({config,accounts:[{...loadAccounts(config)[0],certFile:cert,keyFile:key}]});
  assert.match((await broken.accounts())[0].reason,/certificate/);await assert.rejects(broken.folders('hello'),e=>e.status===503&&e.code==='CERT');await broken.shutdown();
  writeFileSync(join(data,'config','mail-accounts.json'),JSON.stringify([{...defs[0],id:'all'}]));assert.deepEqual(loadAccounts(config),[]);rmSync(join(data,'config','mail-accounts.json'));
});

function alertSetup({send=null,notify=null}={}){
  db.prepare("DELETE FROM kv WHERE key LIKE 'mailbox_alerts:%'").run();
  const sent=[];let snapshot={uidValidity:'1',topUid:10,folder:'Inbox',messages:[]};
  const store={definitions:[{id:'hello',alerts:true,addresses:[{address:'hello@mastan.ai'},{address:'privacy@example.com'}]},{id:'archive',alerts:false}],async newMail(){return snapshot;}};
  const alerts=new MailboxAlerts({db,store,send,notify:notify||(async text=>sent.push(text)),origin:'https://me.test',now:()=>Date.parse('2026-11-13T22:30:00Z')});
  return {alerts,sent,set:next=>snapshot=next};
}
const alertRow=uid=>({uid,from:{name:'Invented Sender',address:'sender@example.net'},subject:'Workshop update',seen:false});
test('mailbox alerts seed silently, skip read/reports, notify once and reset on UIDVALIDITY change',async()=>{
  const {alerts,sent,set}=alertSetup();await alerts.tick();assert.equal(sent.length,0);
  set({uidValidity:'1',topUid:13,folder:'Inbox',messages:[alertRow(11),{...alertRow(12),seen:true},{...alertRow(13),subject:'DMARC aggregate report'}]});await alerts.tick();await alerts.tick();assert.equal(sent.length,1);assert.match(sent[0],/sender@example.net/);assert.match(sent[0],/https:\/\/me.test\/mail#hello\/Inbox\/11/);
  set({uidValidity:'2',topUid:30,folder:'Inbox',messages:[alertRow(30)]});await alerts.tick();assert.equal(sent.length,1);
});
test('over five new messages produce one summary; a failing account tells the owner once after an hour',async()=>{
  const {alerts,sent,set}=alertSetup();await alerts.tick();set({uidValidity:'1',topUid:16,folder:'Inbox',messages:Array.from({length:6},(_,i)=>alertRow(i+11))});await alerts.tick();assert.equal(sent.length,1);assert.match(sent[0],/^📧 New emails\n6 new messages/);
  alerts.store.newMail=async()=>{throw Error('private connection error');};for(let i=0;i<15;i++)await alerts.tick();assert.equal(sent.length,2);assert.match(sent[1],/failing for an hour/);
});

test('canary notices: id, recipient alias, sender and subject in text only, short lines, health id by Riyadh day',async()=>{
  const notices=[];const {alerts,sent,set}=alertSetup({send:async n=>notices.push(n)});await alerts.tick();
  set({uidValidity:'7',topUid:12,folder:'Inbox',messages:[{...alertRow(11),to:[{address:'privacy@example.com'}]},{...alertRow(12),from:{name:'x'.repeat(500),address:'a'.repeat(500)+'@example.net'},subject:'https://evil.example/'+'s'.repeat(900),to:[{address:'other@example.org'}]}]});
  alerts.state('hello',{uidValidity:'7',topUid:10});await alerts.tick();
  assert.equal(sent.length,0);assert.equal(notices.length,2);
  assert.equal(notices[0].id,'mail:hello:7:11');
  assert.equal(notices[0].text,'📧 New email\nprivacy@example.com\nFrom: Invented Sender <sender@example.net>\nSubject: Workshop update\nhttps://me.test/mail#hello/Inbox/11');
  assert.equal(notices[0].fallback,'📧 New email\nhello@mastan.ai\nhttps://me.test/mail#hello/Inbox/11');
  assert.equal(notices[1].text.split('\n')[1],'hello@mastan.ai');assert.doesNotMatch(notices[1].text,/evil|https:\/\/evil/);
  for(const n of notices) for(const v of [n.text,n.fallback]) { assert.ok(v.length<=700);assert.ok(v.split('\n').length<=6);assert.doesNotMatch(v,/[\x00-\x09\x0b-\x1f]/); }
  assert.deepEqual(alerts.healthNotice(),{id:'mail:health:20261114',text:alerts.healthNotice().text,fallback:alerts.healthNotice().text});assert.match(alerts.healthNotice().text,/^📧 Mail alerts problem\n.*failing for an hour/);
});
test('canary notices: over five is one summary notice with a stable id',async()=>{
  const notices=[];const {alerts,set}=alertSetup({send:async n=>notices.push(n)});await alerts.tick();
  set({uidValidity:'1',topUid:16,folder:'Inbox',messages:Array.from({length:6},(_,i)=>alertRow(i+11))});await alerts.tick();
  assert.equal(notices.length,1);assert.equal(notices[0].id,'mail:hello:summary:16');
  assert.equal(notices[0].text,'📧 New emails\n6 new messages for hello@mastan.ai\nhttps://me.test/mail#hello/Inbox');assert.equal(notices[0].fallback,'📧 New emails\nhttps://me.test/mail#hello/Inbox');
  assert.deepEqual(alerts.state('hello'),{uidValidity:'1',topUid:16});
});
test('a failed canary send falls back to Telegram with a content-free log line',async()=>{
  const logs=[],warn=console.warn;console.warn=(...a)=>logs.push(a.join(' '));
  try {
    const {alerts,sent,set}=alertSetup({send:async()=>{throw Object.assign(Error('private detail'),{code:'NO_KEY'});}});await alerts.tick();
    set({uidValidity:'1',topUid:11,folder:'Inbox',messages:[alertRow(11)]});await alerts.tick();
    assert.equal(sent.length,1);assert.match(sent[0],/^📧 New email\n.*\nFrom: Invented Sender/);assert.deepEqual(alerts.state('hello'),{uidValidity:'1',topUid:11});
    assert.deepEqual(logs,['[mailbox-alerts] canary notice failed NO_KEY']);
  } finally { console.warn=warn; }
});
test('the checkpoint advances only past notices one of the two paths accepted',async()=>{
  const warn=console.warn;console.warn=()=>{};
  try {
    let calls=[];const telegram=[];
    const {alerts,set}=alertSetup({send:async n=>{calls.push(n.id);if(n.id.endsWith(':12'))throw Object.assign(Error(),{code:'EXIT_255'});},notify:async text=>{if(/Inbox\/12$/.test(text))throw Error('telegram down');telegram.push(text);}});
    await alerts.tick();set({uidValidity:'1',topUid:13,folder:'Inbox',messages:[alertRow(11),alertRow(12),alertRow(13)]});await alerts.tick();
    assert.deepEqual(calls,['mail:hello:1:11','mail:hello:1:12']);assert.deepEqual(alerts.state('hello'),{uidValidity:'1',topUid:11});assert.equal(telegram.length,0);
    // Next run: 11 is not sent again; 12 now goes through Telegram, 13 through canary.
    alerts.notify=async text=>telegram.push(text);calls=[];await alerts.tick();
    assert.deepEqual(calls,['mail:hello:1:12','mail:hello:1:13']);assert.equal(telegram.length,1);assert.match(telegram[0],/Inbox\/12$/);assert.deepEqual(alerts.state('hello'),{uidValidity:'1',topUid:13});
  } finally { console.warn=warn; }
});
test('a tick requested while one is running runs once more afterwards',async()=>{
  const {alerts,set}=alertSetup();let release,runs=0;
  alerts.store.newMail=async()=>{runs++;if(runs===1)await new Promise(r=>release=r);return {uidValidity:'1',topUid:10,folder:'Inbox',messages:[]};};
  const first=alerts.tick();await new Promise(r=>setImmediate(r));await alerts.tick();await alerts.tick();assert.equal(runs,1);
  release();await first;await new Promise(r=>setTimeout(r,5));assert.equal(runs,2);set({uidValidity:'1',topUid:10,folder:'Inbox',messages:[]});
});

// A protocol fake asserts locks, partial fetches, UID usage and certificate options.
function imapSetup({smtpFails=false,appendFails=false}={}){
  const cert=join(data,'fixture.crt'),key=join(data,'fixture.key');writeFileSync(cert,'fixture certificate');writeFileSync(key,'fixture key');
  const def={...mail.definitions[0],host:'mail.example.invalid',imapPort:993,smtpPort:465,certFile:cert,keyFile:key};
  const calls=[];let locked=false,connections=0;const flags=new Set(['\\Seen']);
  class FakeImap extends EventEmitter{
    constructor(options){super();connections++;assert.equal(options.auth,undefined);assert.equal(options.secure,true);assert.ok(options.tls.cert);this.usable=false;this.mailbox={uidValidity:1n,uidNext:20};}
    async connect(){this.usable=true;}
    close(){this.usable=false;this.emit('close');}
    async list(){return [{path:'Inbox',name:'Inbox',flags:new Set(),specialUse:'\\Inbox',status:{messages:1,unseen:0}},...['sent','drafts','archive','trash','junk'].map(role=>({path:`Role-${role}`,name:role,specialUse:'\\'+role[0].toUpperCase()+role.slice(1),flags:new Set(),status:{messages:0,unseen:0}}))];}
    async getMailboxLock(folder){assert.equal(locked,false);locked=true;calls.push(['lock',folder]);return {release(){locked=false;calls.push(['release']);}};}
    async search(query,options){assert.ok(locked);assert.equal(options.uid,true);calls.push(['search',query]);return [7];}
    async fetchAll(range,query,options){assert.ok(locked);assert.equal(options.uid,true);assert.equal(query.source.maxLength,4096);calls.push(['fetch',range]);return [{uid:7,envelope:{from:[{address:'person@example.net'}],to:[def.addresses[0]],subject:'Fixture',date:new Date()},flags,size:40,source:Buffer.from('From: person@example.net\r\n\r\nHello')}];}
    async fetchOne(uid,query,options){assert.ok(locked);assert.equal(options.uid,true);return {uid,flags:new Set(['\\Draft','\\Seen']),envelope:{from:[def.addresses[0]]},size:60,source:Buffer.from('From: hello@example.com\r\n\r\nHello')};}
    async messageFlagsAdd(range,flags,options){assert.ok(locked);assert.equal(options.uid,true);calls.push(['add',flags]);}
    async messageFlagsRemove(range,flags,options){assert.ok(locked);assert.equal(options.uid,true);calls.push(['remove',flags]);}
    async messageMove(range,to,options){assert.ok(locked);assert.equal(options.uid,true);calls.push(['move',to]);}
    async append(folder,raw,flags){assert.ok(locked);calls.push(['append',folder,flags]);if(appendFails&&folder==='Role-sent')throw Error('append failed');return {uid:99};}
    async messageDelete(uid,options){assert.ok(locked);assert.equal(options.uid,true);calls.push(['delete',uid]);}
  }
  const store=new MailStore({config,accounts:[def],readCredentials:()=>({cert:Buffer.from('fixture certificate'),key:Buffer.from('fixture key')}),clientFactory:o=>new FakeImap(o),transport:()=>({async sendMail(options){calls.push(['smtp',options]);if(smtpFails)throw {response:'550 Message refused'};return {accepted:['reader@example.net'],rejected:[]};},close(){}})});
  return {store,calls,get connections(){return connections;}};
}
test('IMAP serializes locks, reuses one PREAUTH connection, pages by UID and trains junk keywords',async()=>{
  const f=imapSetup();await Promise.all([f.store.list('hello',{folder:'Inbox'}),f.store.flags('hello','Inbox',[7],{seen:true})]);assert.equal(f.connections,1);assert.ok(f.calls.some(c=>c[0]==='fetch'));
  await f.store.move('hello','Inbox',[7],{role:'junk'});assert.ok(f.calls.some(c=>c[0]==='add'&&c[1][0]==='$Junk'));assert.ok(f.calls.some(c=>c[0]==='remove'&&c[1][0]==='$NotJunk'));assert.ok(f.calls.some(c=>c[0]==='move'&&c[1]==='Role-junk'));
  await f.store.shutdown();
});
test('SMTP failure keeps the draft; acceptance appends to special-use Sent before draft deletion; idempotency prevents resends',async()=>{
  const failed=imapSetup({smtpFails:true});await assert.rejects(failed.store.send('hello',{...input(),draftUid:7,sendId:'failed-fixture'}),/550 Message refused/);assert.ok(!failed.calls.some(c=>c[0]==='delete'));
  // An SMTP refusal does not drop or back off the IMAP connection.
  await failed.store.list('hello',{folder:'Inbox'});assert.equal(failed.connections,1);await failed.store.shutdown();
  const ok=imapSetup();const data={...input(),draftUid:7,sendId:'success-fixture'};await ok.store.send('hello',data);await ok.store.send('hello',data);
  assert.equal(ok.calls.filter(c=>c[0]==='smtp').length,1);const append=ok.calls.findIndex(c=>c[0]==='append');assert.equal(ok.calls[append][1],'Role-sent');assert.ok(ok.calls.findIndex(c=>c[0]==='delete')>append);await ok.store.shutdown();
  const partial=imapSetup({appendFails:true});const result=await partial.store.send('hello',{...input(),draftUid:7,sendId:'copy-failed-fixture'});assert.equal(result.ok,true);assert.match(result.warning,/Do not send it again/);assert.ok(!partial.calls.some(c=>c[0]==='delete'));await partial.store.shutdown();
});
