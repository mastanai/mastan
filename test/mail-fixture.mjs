// Invented, in-memory mailbox. No network or credentials, including on Send.
import {groupThreads,parseSearch} from '../src/web/public/mail-helpers.js';
import {composeRaw,validateCompose,parseMessage,publicMessage,mailError} from '../src/mail/message.js';
export async function createFakeMail({empty=false}={}) {
  const definitions=[{id:'hello',label:'Copper Kite',alerts:true,addresses:[{address:'hello@example.com',name:'Copper Kite'},{address:'studio@example.com',name:'Copper Kite'}]},
    {id:'archive',label:'Lantern Events',alerts:false,addresses:[{address:'events@example.com',name:'Lantern Events'}]}];
  const roles=[['Inbox','inbox'],['Drafts','drafts'],['Sent','sent'],['Archive','archive'],['Junk','junk'],['Trash','trash'],['Projects/Notes','other']];
  const rows=new Map(definitions.map(a=>[a.id,[]])); let next=1000;
  async function put(id,folder,input,flags={}) {
    const a=definitions.find(a=>a.id===id), raw=input.raw || await composeRaw({...input,disableFileAccess:true,disableUrlAccess:true},folder==='Drafts');
    const parsed=await parseMessage(raw,{uid:next++,folder,seen:false,flagged:false,answered:false,draft:folder==='Drafts',...flags});
    const m={...parsed,raw,size:raw.length,hasAttachment:!!parsed.attachments.length,snippet:parsed.text.replace(/\s+/g,' ').slice(0,140)};
    rows.get(id).push(m); return m;
  }
  if(!empty) for(let i=0;i<40;i++) {
    const id=i<30?'hello':'archive',a=definitions.find(a=>a.id===id),folder=i===2?'Sent':i===29?'Drafts':i%9===0?'Archive':i%8===0?'Sent':i%13===0?'Junk':'Inbox';
    const sender=['Mira Veylan','Sami Orven','Lina Tarev','Daren Elvi'][i%4];
    const thread=i<3;
    await put(id,folder,{from:folder==='Sent'||folder==='Drafts'?a.addresses[0]:{name:sender,address:`person${i%4}@example.org`},to:folder==='Sent'?[{name:'Mira Veylan',address:'person0@example.org'}]:[a.addresses[0]],
      cc:i===1?[{address:'review@example.net',name:'Review group'}]:[],subject:thread?`${i?'Re: ':''}Workshop notebook`:[`Paper samples ${i+1}`,'Friday reading circle','Prototype review','A short studio update'][i%4],
      text:i===29?'A draft for the next workshop.':`Hello,\n\nHere are the invented notes from our workshop ${i+1}. The next review is on Friday.\n\nSee https://example.com/workshop for the schedule.\n\n${sender}`,
      html:i===4?'<h2>Studio newsletter</h2><p>A quiet week of new ideas.</p><img src="https://example.com/newsletter.png" alt="A remote image"><p><a href="https://example.com">Read the notebook</a></p>':i===5?'<h2>Hostile HTML fixture</h2><script>alert(1)</script><img src="x" onerror="alert(2)"><form action="https://example.com"><input name="secret"></form><a href="javascript:alert(3)">Unsafe link removed</a><p>This paragraph is safe.</p>':i===6?'<p>An inline sketch:</p><img src="cid:sketch">':undefined,
      attachments:i===6?[{filename:'sketch.png',content:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64'),cid:'sketch',contentType:'image/png'}]:i%7===0?[{filename:'workshop-notes.txt',content:Buffer.from('Invented workshop notes only.')}]:[],
      date:new Date(Date.now()-i*3600_000),messageId:`<preview-${i}@example.com>`,inReplyTo:thread&&i?'<preview-0@example.com>':undefined,references:thread&&i?['<preview-0@example.com>']:[]}, {seen:['Sent','Drafts'].includes(folder)||i%3!==0,flagged:i%6===0});
  }
  const find=(id,folder,uid)=>{const m=rows.get(id)?.find(m=>m.folder===folder&&m.uid===uid);if(!m)throw mailError(404,'Message not found.');return m;};
  const row=m=>{const {raw,text,html,attachments,headers,...r}=m;return r;};
  const store={definitions,rows,sentCount:0,
    async accounts(){return definitions.map(a=>({...a,connected:true,unread:rows.get(a.id).filter(m=>m.folder==='Inbox'&&!m.seen).length}));},
    async folders(id){return roles.map(([path,role])=>({path,name:path.split('/').at(-1),role,total:rows.get(id).filter(m=>m.folder===path).length,unread:rows.get(id).filter(m=>m.folder===path&&!m.seen).length}));},
    async list(id,{folder,page=1,search='',starred=false,allFolders=false}){
      const q=parseSearch(search);
      let found=rows.get(id).filter(m=>(allFolders?!['Junk','Trash'].includes(m.folder):m.folder===folder)&&(!starred||m.flagged)&&
        (q.seen===undefined||m.seen===q.seen)&&(!q.flagged||m.flagged)&&(!q.attachment||m.hasAttachment)&&
        (!q.from||`${m.from.name} ${m.from.address}`.toLowerCase().includes(q.from.toLowerCase()))&&(!q.to||JSON.stringify(m.to).toLowerCase().includes(q.to.toLowerCase()))&&
        (!q.subject||m.subject.toLowerCase().includes(q.subject.toLowerCase()))&&(!q.text||`${m.subject} ${m.text}`.toLowerCase().includes(q.text.toLowerCase()))).sort((a,b)=>Date.parse(b.date)-Date.parse(a.date));
      const total=found.length,messages=found.slice((page-1)*50,page*50).map(row);return {messages,threads:groupThreads(messages),total,page,hasMore:page*50<total};
    },
    async message(id,folder,uid){return publicMessage(find(id,folder,uid));},
    async conversation(id,folder,uid){const seed=find(id,folder,uid);if(seed.draft)return [publicMessage(seed)];const g=groupThreads(rows.get(id).filter(m=>[folder,'Sent'].includes(m.folder)).map(row)).find(g=>g.messages.some(m=>m.uid===uid));return (g?.messages||[seed]).slice().reverse().map(m=>publicMessage(find(id,m.folder,m.uid)));},
    async raw(id,folder,uid){return find(id,folder,uid).raw;},
    async allAttachments(id,folder,uid){return find(id,folder,uid).attachments;},
    async attachment(id,folder,uid,index){const a=find(id,folder,uid).attachments[index];if(!a)throw mailError(404,'Attachment not found.');return a;},
    async flags(id,folder,uids,flags){for(const uid of uids)Object.assign(find(id,folder,uid),flags);return {ok:true};},
    async move(id,folder,uids,{role,destination}){const target=role?roles.find(r=>r[1]===(role==='notjunk'?'inbox':role))?.[0]:destination;if(!target)throw mailError(404,'Folder not found.');for(const uid of uids)find(id,folder,uid).folder=target;return {ok:true};},
    async saveDraft(id,input){const fields=validateCompose(definitions.find(a=>a.id===id),input,{draft:true});fields.messageId=`<preview-draft-${next}@example.com>`;const m=await put(id,'Drafts',fields,{seen:true,draft:true});m.related=input.related;if(input.draftUid)await this.deleteDraft(id,input.draftUid);return {uid:m.uid,folder:'Drafts'};},
    async deleteDraft(id,uid){const m=find(id,'Drafts',uid);if(!m.draft)throw mailError(400,'Not a draft.');rows.set(id,rows.get(id).filter(m=>m.uid!==uid));return {ok:true};},
    async send(id,input){const fields=validateCompose(definitions.find(a=>a.id===id),input);fields.messageId=`<preview-sent-${next}@example.com>`;await put(id,'Sent',fields,{seen:true});this.sentCount++;if(input.draftUid)await this.deleteDraft(id,input.draftUid);return {ok:true};},
    async newMail(id,previous){const inbox=rows.get(id).filter(m=>m.folder==='Inbox'),topUid=Math.max(0,...inbox.map(m=>m.uid));return {uidValidity:'1',topUid,folder:'Inbox',messages:previous?inbox.filter(m=>m.uid>previous.topUid).map(row):[]};},
    async shutdown(){}
  };return store;
}
