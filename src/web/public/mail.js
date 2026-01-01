import {mailDate,mailDateTime,recipientSummary,fileSize} from './mail-helpers.js';
import {Composer} from './mail-compose.js';
const {h,api,toast,fill,main,pageHead,loading,errorState}=window.MM;
const failure=error=>toast(error.message||'Could not reach the mail server. Trying again.',{error:true,ms:6000});
const run=fn=>()=>void Promise.resolve().then(fn).catch(failure);
const btn=(text,fn,cls='',label)=>h('button',{class:`btn ${cls}`,type:'button',text,'aria-label':label,title:label,onclick:run(fn)});
const state={accounts:[],account:'',folder:'',uid:null,page:1,search:'',all:false,starred:false,folders:new Map(),rows:[],selected:new Set(),active:0,split:true,generation:0,total:0,hasMore:false,partial:false};
try{state.split=localStorage.getItem('mm-mail-split')!=='off';}catch{}
const PAGE=50;
const key=m=>`${m.account||state.account}|${m.folder}|${m.uid}`;
const folderName=path=>path.split('/').at(-1);
const account=()=>state.accounts.find(a=>a.id===state.account);
const currentFolder=()=>state.folders.get(state.account)?.find(f=>f.path===state.folder);
const ownAddresses=()=>state.accounts.flatMap(a=>a.addresses);
const composer=new Composer({accounts:()=>state.accounts,changed:()=>{void refresh(false);}});
let rail,pane,rows,toolbar,searchInput,allChip,clearSearch,folderTitle,offline,root,drawer,splitButton,fab,request=0,opened=null;

function url(id,action,values={}){return `/api/mail/${encodeURIComponent(id)}/${action}?${new URLSearchParams(values)}`;}
function hashFor(id,folder,uid=null,{starred=false}={}){return `#${encodeURIComponent(id)}/${encodeURIComponent(folder)}${uid?'/'+uid:''}${starred?'?starred=1':''}`;}
function navigate(id,folder,uid=null,options={}){
  const hash=hashFor(id,folder,uid,options);
  if(location.hash===hash)void loadHash();else location.hash=hash;
}
function starButton(flagged,fn){
  const star=btn('',fn,'ghost mail-reading-star');
  const paint=on=>{star.replaceChildren(on?'★':'☆',h('span',{class:'mail-star-label',text:on?' Starred':' Star'}));star.setAttribute('aria-pressed',String(on));star.setAttribute('aria-label',on?'Unstar':'Star');};
  paint(flagged);star.paint=paint;return star;
}
const back=()=>navigate(state.account,state.folder,null,{starred:state.starred});

// A small disclosure menu for secondary actions. Native details keeps keyboard and screen reader behavior.
function menu(label,items){
  const panel=h('div',{class:'mail-menu',role:'group','aria-label':label});
  const box=h('details',{class:'mail-more'},h('summary',{class:'btn',text:label}),panel);
  for(const item of items.filter(Boolean)){
    if(item instanceof Node){panel.append(item);continue;}
    panel.append(h('button',{type:'button',class:`mail-menu-item${item.bad?' bad':''}`,text:item.text,onclick:()=>{box.open=false;void Promise.resolve().then(item.run).catch(failure);}}));
  }
  return box;
}
document.addEventListener('click',e=>{for(const d of document.querySelectorAll('.mail-more[open]'))if(!d.contains(e.target))d.open=false;});

function setDrawer(open){root.classList.toggle('drawer-open',open);drawer.setAttribute('aria-expanded',String(open));if(open)rail.querySelector('a,button,select')?.focus();}
function build(){
  rail=h('nav',{class:'mail-rail',id:'mail-rail','aria-label':'Mailboxes and folders'});
  drawer=h('button',{class:'btn mail-folders-toggle',type:'button','aria-label':'Folders','aria-controls':'mail-rail','aria-expanded':'false',text:'☰',onclick:()=>setDrawer(!root.classList.contains('drawer-open'))});
  folderTitle=h('span',{class:'mail-folder-title',text:'Inbox'}); // pageHead drops empty spans.
  searchInput=h('input',{type:'search',placeholder:'Search mail','aria-label':'Search mail. Supports from, to, subject, has:attachment, is:unread, is:starred',maxlength:500,enterkeyhint:'search'});
  const submit=()=>{state.search=searchInput.value.trim();state.page=1;syncSearch();return refresh(true);};
  allChip=h('button',{type:'button',class:'chip mail-all-folders','aria-pressed':'false',text:'All folders',onclick:run(()=>{state.all=!state.all;syncSearch();state.page=1;return refresh(true);})});
  clearSearch=h('button',{type:'button',class:'btn ghost mail-clear-search',text:'Clear','aria-label':'Clear search',hidden:true,onclick:run(()=>{searchInput.value='';state.all=false;return submit();})});
  const search=h('form',{class:'mail-search',role:'search',onsubmit:e=>{e.preventDefault();void submit().catch(failure);}},searchInput,clearSearch,allChip);
  splitButton=btn(state.split?'No split':'Split',()=>{state.split=!state.split;root.classList.toggle('no-split',!state.split);splitButton.textContent=state.split?'No split':'Split';try{localStorage.setItem('mm-mail-split',state.split?'on':'off');}catch{}},'ghost mail-split-toggle',state.split?'Open messages in place of the list':'Show the reading pane beside the list');
  toolbar=h('div',{class:'mail-toolbar'});
  rows=h('div',{class:'mail-rows',role:'list','aria-label':'Conversations'});
  const list=h('section',{class:'mail-list','aria-label':'Message list'},toolbar,rows);
  pane=h('section',{class:'mail-pane','aria-label':'Reading pane'});
  offline=h('p',{class:'error mail-offline',role:'status',hidden:navigator.onLine,text:'You are offline. Drafts will save when your connection returns.'});
  fab=h('button',{type:'button',class:'btn primary mail-fab',text:'Compose',onclick:run(()=>compose())});
  root=h('div',{class:`mail-layout${state.split?'':' no-split'}`},rail,h('div',{class:'mail-workspace'},list,pane),h('div',{class:'mail-scrim',onclick:()=>setDrawer(false)}));
  fill(main(),pageHead('Mail',drawer,folderTitle,search,splitButton,btn('?',()=>shortcuts(),'ghost mail-help','Keyboard shortcuts')),offline,root,fab);
  emptyPane();
}
function syncSearch(){
  allChip.setAttribute('aria-pressed',String(state.all));
  clearSearch.hidden=!state.search&&!state.all;
  root.classList.toggle('searching',!!state.search||state.all);
}
function emptyPane(){
  root.classList.remove('reading');opened=null;
  fill(pane,h('div',{class:'mail-pane-empty'},h('p',{class:'empty',text:'No conversation selected.'}),h('p',{class:'muted',text:'Choose a message from the list. Press ? for keyboard shortcuts.'})));
}
function titleOf(){
  if(state.account==='all')return 'All inboxes';
  if(state.starred)return 'Starred';
  const f=currentFolder();return f?(f.role==='other'?f.path:folderName(f.path)):folderName(state.folder||'Inbox');
}
function folderLink(text,count,href,current,title){
  return h('li',{},h('a',{class:'mail-folder',href,'aria-current':current?'page':null,title,onclick:()=>setDrawer(false)},h('span',{class:'mail-folder-name',text}),count?h('span',{class:'mail-folder-count',text:String(count),'aria-label':`${count} unread`}):null));
}
function renderRail(){
  const a=account(),connected=state.accounts.filter(a=>a.connected),children=[btn('Compose',()=>compose(),'primary mail-compose')];
  if(state.accounts.length){
    const picker=h('select',{class:'mail-account-picker','aria-label':'Mailbox',onchange:()=>{const id=picker.value;navigate(id,id==='all'?'Inbox':state.folders.get(id)?.find(f=>f.role==='inbox')?.path||'Inbox');}});
    if(connected.length>1)picker.append(h('option',{value:'all',text:`All inboxes${connected.reduce((n,a)=>n+(a.unread||0),0)?' · '+connected.reduce((n,a)=>n+(a.unread||0),0):''}`,selected:state.account==='all'}));
    for(const x of state.accounts)picker.append(h('option',{value:x.id,text:`${x.label}${x.unread?' · '+x.unread:''}${x.connected?'':' · not connected'}`,selected:x.id===state.account}));
    const note=state.account==='all'?h('p',{class:'mail-account-note muted',text:`${connected.length} mailboxes`}):a?.connected?h('p',{class:'mail-account-note muted',text:a.addresses[0].address}):a?h('p',{class:'mail-account-note error',text:`Not connected. ${a.reason||''}`.trim()}):null;
    children.push(h('div',{class:'mail-account'},picker,note));
  }
  if(a?.connected){
    const order=['inbox','starred','drafts','sent','archive','junk','trash','other'];
    const folders=[...(state.folders.get(a.id)||[])].sort((x,y)=>order.indexOf(x.role)-order.indexOf(y.role)||x.path.localeCompare(y.path));
    const items=[];
    for(const f of folders){
      // Drafts show their total like Gmail; other folders show unread.
      items.push(folderLink(f.role==='other'?f.path:folderName(f.path),f.role==='drafts'?f.total:f.role==='sent'||f.role==='trash'?0:f.unread,hashFor(a.id,f.path),!state.starred&&f.path===state.folder,f.path));
      if(f.role==='inbox')items.push(folderLink('Starred',0,hashFor(a.id,f.path,null,{starred:true}),state.starred,'Starred messages in Inbox'));
    }
    children.push(h('ul',{class:'mail-folders'},items));
  }else if(state.account==='all')children.push(h('ul',{class:'mail-folders'},folderLink('Inbox',connected.reduce((n,a)=>n+(a.unread||0),0),'#all/Inbox',true)));
  fill(rail,...children);
  folderTitle.textContent=titleOf();
}
async function accounts(){
  const result=await api('/api/mail/accounts');state.accounts=result.accounts;
  await Promise.all(state.accounts.filter(a=>a.connected).map(async a=>{try{state.folders.set(a.id,(await api(url(a.id,'folders'))).folders);}catch{}}));
  const badge=document.querySelector('.mail-unread');if(badge){const count=state.accounts.filter(a=>a.alerts).reduce((n,a)=>n+a.unread,0);badge.textContent=count?' '+count:'';badge.hidden=!count;}
}
async function loadHash(){
  const previous=`${state.account}/${state.folder}/${state.starred}`;
  try{
    const [path,query]=location.hash.slice(1).split('?'),[id,folder,uid]=path.split('/').map(decodeURIComponent);
    state.account=id||state.accounts[0]?.id||'';state.folder=folder||state.folders.get(state.account)?.find(f=>f.role==='inbox')?.path||'Inbox';
    state.uid=uid&&/^\d+$/.test(uid)?Number(uid):null;state.starred=new URLSearchParams(query).get('starred')==='1';
  }catch{state.account=state.accounts[0]?.id||'';state.folder='Inbox';state.uid=null;}
  const changed=previous!==`${state.account}/${state.folder}/${state.starred}`;
  if(changed){state.page=1;state.selected.clear();state.active=0;}
  setDrawer(false);renderRail();
  if(changed||!state.rows.length)await refresh(true);else markOpen();
  request++;
  if(state.uid)await openMessage({account:state.account,folder:state.folder,uid:state.uid});
  else{emptyPane();markOpen();}
}
async function refresh(showLoading=false){
  if(!root)return;
  const generation=++state.generation,scroll=rows.scrollTop;
  if(showLoading){fill(rows,loading());renderToolbar();}
  try{
    await accounts();if(generation!==state.generation)return;renderRail();
    const a=account();
    if(state.account!=='all'&&!a?.connected){state.rows=[];state.total=0;renderToolbar();fill(rows,h('p',{class:'empty',text:a?`Not connected. ${a.reason||'Could not reach the mail server. Trying again.'}`:'No mailbox is configured.'}));return;}
    const params={page:state.page,search:state.search,all:state.all?'1':'0'};
    const data=state.account==='all'?await api('/api/mail/inboxes?'+new URLSearchParams(params)):await api(url(a.id,'messages',{folder:state.folder,...params,starred:state.starred?'1':'0'}));
    if(generation!==state.generation)return;
    const tag=m=>({...m,account:m.account||a?.id});
    state.rows=data.threads.map(t=>({...tag(t),messages:t.messages.map(tag)})).sort((x,y)=>Date.parse(y.date)-Date.parse(x.date));
    Object.assign(state,{hasMore:!!data.hasMore,total:data.total||0,partial:!!data.partial});
    const valid=new Set(state.rows.flatMap(t=>t.messages.map(key)));state.selected=new Set([...state.selected].filter(k=>valid.has(k)));
    state.active=Math.min(state.active,Math.max(0,state.rows.length-1));
    const focused=rows.contains(document.activeElement)&&document.activeElement.closest('.mail-row-open');
    renderRows();rows.scrollTop=scroll;
    if(focused)rows.querySelector(`[data-index="${state.active}"] .mail-row-open`)?.focus({preventScroll:true});
    offline.hidden=navigator.onLine;
  }catch(error){if(generation===state.generation){if(showLoading)fill(rows,errorState(error.message,()=>refresh(true)));else failure(error);}}
}
const selectedRows=()=>state.rows.flatMap(t=>t.messages).filter(m=>state.selected.has(key(m)));
function moveSelect(messages,after){
  const ids=[...new Set(messages.map(m=>m.account||state.account))];
  const select=h('select',{class:'mail-move','aria-label':'Move to folder',disabled:ids.length!==1},h('option',{value:'',text:'Move to...'}));
  if(ids.length===1)for(const f of state.folders.get(ids[0])||[])if(!messages.every(m=>m.folder===f.path))select.append(h('option',{value:f.path,text:f.role==='other'?f.path:folderName(f.path)}));
  select.addEventListener('change',()=>{if(!select.value)return;const target=select.value;select.closest('details')?.removeAttribute('open');
    void grouped(messages,g=>api(`/api/mail/${g.account}/move`,{method:'POST',body:{folder:g.folder,uids:g.uids,destination:target}})).then(()=>{state.selected.clear();after?.();return refresh(false);}).catch(failure);});
  return select;
}
function renderToolbar(){
  if(toolbar.querySelector('.mail-more[open]'))return; // Do not close a menu the owner is using.
  const all=state.rows.flatMap(t=>t.messages),count=state.selected.size;
  const check=h('input',{type:'checkbox',class:'mail-check-all','aria-label':'Select all messages on this page',title:'Select all on this page',onchange:()=>{if(check.checked)all.forEach(m=>state.selected.add(key(m)));else state.selected.clear();renderRows();}});
  check.checked=!!all.length&&all.every(m=>state.selected.has(key(m)));check.indeterminate=!!count&&!check.checked;check.disabled=!all.length;
  const start=(state.page-1)*PAGE;
  const shown=state.rows.reduce((n,t)=>n+t.messages.length,0);
  const pager=h('div',{class:'mail-pager'},h('span',{class:'mail-range',role:'status',text:shown?`${start+1}–${start+shown} of ${state.total}${state.partial?' (limited search)':''}`:''}),
    btn('‹',()=>{if(state.page>1){state.page--;return refresh(true);}},'ghost mail-page','Newer'),btn('›',()=>{if(state.hasMore){state.page++;return refresh(true);}},'ghost mail-page','Older'));
  pager.children[1].disabled=state.page<=1;pager.children[2].disabled=!state.hasMore;
  const children=[h('label',{class:'mail-check'},check)];
  if(count){
    const selected=selectedRows(),junk=currentFolder()?.role==='junk';
    const conversations=state.rows.filter(t=>t.messages.some(m=>state.selected.has(key(m)))).length;
    children.push(h('span',{class:'mail-selected',text:`${conversations} selected`}),btn('Archive',()=>act('archive',selected)),btn('Delete',()=>act('trash',selected)),
      btn('Mark read',()=>setFlags(selected,{seen:true}),'mail-wide'),btn('Mark unread',()=>setFlags(selected,{seen:false}),'mail-wide'),
      menu('More',[{text:'Mark read',run:()=>setFlags(selected,{seen:true})},{text:'Mark unread',run:()=>setFlags(selected,{seen:false})},{text:junk?'Not junk':'Report junk',run:()=>act(junk?'notjunk':'junk',selected)},h('label',{class:'mail-menu-move'},h('span',{class:'sr-only',text:'Move to folder'}),moveSelect(selected))]));
    root.classList.add('selecting');
  }else{children.push(btn('↻',()=>refresh(true),'ghost mail-refresh','Refresh'));root.classList.remove('selecting');}
  children.push(pager);
  fill(toolbar,...children);
}
function rowView(m,index){
  const keys=m.messages.map(key),selected=keys.every(k=>state.selected.has(k));
  const checkbox=h('input',{type:'checkbox','aria-label':`Select ${m.subject||'(no subject)'}`,checked:selected,onchange:()=>{for(const k of keys){if(checkbox.checked)state.selected.add(k);else state.selected.delete(k);}renderRows();}});
  const star=btn(m.flagged?'★':'☆',()=>setFlags(m.messages.filter(x=>x.uid===m.uid&&x.folder===m.folder),{flagged:!m.flagged}),'mail-star',m.flagged?'Unstar':'Star');star.setAttribute('aria-pressed',String(m.flagged));
  const sender=m.from?.name||m.from?.address||'Unknown sender';
  const open=h('a',{class:'mail-row-open',href:hashFor(m.account,m.folder,m.uid,{starred:state.starred}),onfocus:()=>{state.active=index;}},
    h('span',{class:'mail-sender'},h('span',{class:'mail-sender-name',text:sender}),m.count>1?h('span',{class:'mail-count',text:String(m.count),'aria-label':`${m.count} messages`}):null),
    h('span',{class:'mail-line'},h('span',{class:'mail-subject',text:m.subject||'(no subject)'}),m.snippet?h('span',{class:'mail-snippet',text:m.snippet}):null),
    h('span',{class:'mail-meta'},m.hasAttachment?h('span',{class:'mail-clip',text:'file','aria-label':'Has attachment'}):null,m.draft?h('span',{class:'mail-draft-tag',text:'Draft'}):null,h('time',{text:mailDate(m.date),datetime:m.date,title:mailDateTime(m.date)})));
  const quick=h('div',{class:'mail-quick'},btn('Archive',()=>act('archive',m.messages),'ghost'),btn('Delete',()=>act('trash',m.messages),'ghost'),btn(m.seen?'Unread':'Read',()=>setFlags(m.messages,{seen:!m.seen}),'ghost',m.seen?'Mark unread':'Mark read'));
  const isOpen=state.uid&&m.messages.some(x=>x.uid===state.uid&&x.folder===state.folder&&x.account===state.account);
  return h('div',{class:`mail-row${m.seen?'':' unread'}${index===state.active?' active':''}${selected?' selected':''}${isOpen?' open':''}`,role:'listitem',dataset:{index,keys:keys.join(' ')}},h('label',{class:'mail-row-check'},checkbox),star,open,quick);
}
function renderRows(){
  renderToolbar();
  if(!state.rows.length){fill(rows,h('div',{class:'mail-list-empty'},h('p',{class:'empty',text:state.search?'No messages match your search.':state.starred?'No starred messages.':'This folder is empty.'}),state.search?h('p',{class:'muted',text:'Try fewer words, or turn on All folders.'}):null));return;}
  fill(rows,...state.rows.map(rowView));
}
function markOpen(){
  const open=state.uid?`${state.account}|${state.folder}|${state.uid}`:'';
  for(const row of rows.querySelectorAll('.mail-row'))row.classList.toggle('open',!!open&&row.dataset.keys.split(' ').includes(open));
}
async function grouped(messages,callback){
  const groups=new Map();for(const m of messages){const a=m.account||state.account,k=`${a}|${m.folder}`;if(!groups.has(k))groups.set(k,{account:a,folder:m.folder,uids:[]});groups.get(k).uids.push(m.uid);}
  for(const group of groups.values())await callback(group);
}
async function setFlags(messages,flags){
  if(!messages.length)return;
  await grouped(messages,g=>api(`/api/mail/${g.account}/flags`,{method:'POST',body:{folder:g.folder,uids:g.uids,...flags}}));
  messages.forEach(m=>Object.assign(m,flags));
  if(opened&&messages.some(m=>key(m)===key(opened))){Object.assign(opened,flags);if(flags.flagged!==undefined)pane.querySelector('.mail-reading-star')?.paint?.(flags.flagged);}
  await refresh(false);
}
async function act(role,messages){
  if(!messages.length)return;
  await grouped(messages,g=>api(`/api/mail/${g.account}/move`,{method:'POST',body:{folder:g.folder,uids:g.uids,role}}));
  state.selected.clear();
  toast({archive:'Archived.',trash:'Moved to Trash.',junk:'Reported as junk.',notjunk:'Moved to Inbox.'}[role]);
  if(state.uid&&messages.some(m=>m.uid===state.uid&&m.folder===state.folder))back();
  await refresh(false);
}
function textBody(text){
  const box=h('div',{class:'mail-text'});let pos=0;
  for(const m of String(text||'').matchAll(/https?:\/\/[^\s<>"']+/g)){box.append(document.createTextNode(text.slice(pos,m.index)),h('a',{href:m[0],target:'_blank',rel:'noopener noreferrer',text:m[0]}));pos=m.index+m[0].length;}
  box.append(document.createTextNode(String(text||'').slice(pos)));return box;
}
function messageCard(m,a,last){
  const body=h('div',{class:'mail-message-body'});
  if(m.html){
    const iframe=h('iframe',{class:'mail-html',title:'Email body on light paper',sandbox:'allow-popups allow-popups-to-escape-sandbox',referrerpolicy:'no-referrer',loading:'lazy',src:url(a.id,'body',{folder:m.folder,uid:m.uid})});
    if(m.hiddenImages){const bar=h('div',{class:'mail-images'},h('span',{text:'Images are hidden.'}),btn('Show images',()=>{iframe.src=url(a.id,'body',{folder:m.folder,uid:m.uid,images:'1'});bar.remove();},'ghost'));body.append(bar);}
    body.append(iframe);
  }else body.append(textBody(m.text));
  const files=m.attachments.filter(x=>!x.inline);
  if(files.length)body.append(h('div',{class:'mail-attachments'},h('p',{class:'mail-attachments-label',text:`${files.length} attachment${files.length>1?'s':''}`}),
    files.map(file=>h('a',{class:'mail-attachment',href:url(a.id,'attachment',{folder:m.folder,uid:m.uid,index:file.index}),download:file.filename},h('span',{class:'mail-attachment-name',text:file.filename}),h('span',{class:'mail-attachment-size',text:fileSize(file.size)})))));
  const details=h('dl',{class:'mail-recipient-details',hidden:true},
    ...[['From',[m.from].filter(Boolean)],['To',m.to],['Cc',m.cc],['Bcc',m.bcc],['Reply to',m.replyTo]].filter(([,list])=>list?.length).flatMap(([label,list])=>[h('dt',{text:label}),h('dd',{text:list.map(x=>x.name?`${x.name} <${x.address}>`:x.address).join(', ')})]),
    h('dt',{text:'Date'}),h('dd',{text:mailDateTime(m.date)}));
  const toggle=h('button',{type:'button',class:'mail-recipients-toggle','aria-expanded':'false',text:`${recipientSummary(m,ownAddresses())} ▾`,onclick:()=>{details.hidden=!details.hidden;toggle.setAttribute('aria-expanded',String(!details.hidden));}});
  const snippet=String(m.text||'').replace(/\s+/g,' ').trim().slice(0,160);
  return h('details',{class:'mail-message',open:last},
    h('summary',{},h('span',{class:'mail-from-name',text:m.from?.name||m.from?.address||'Unknown sender'}),m.from?.name&&m.from?.address?h('span',{class:'mail-from-address',text:`<${m.from.address}>`}):null,
      h('span',{class:'mail-message-snippet',text:snippet}),h('time',{datetime:m.date,text:mailDateTime(m.date)})),
    h('div',{class:'mail-recipients'},toggle,details),body);
}
async function openMessage(message){
  const token=++request,a=state.accounts.find(a=>a.id===message.account);
  if(!a?.connected){emptyPane();return;}
  root.classList.add('reading');fill(pane,loading());markOpen();
  try{
    const data=await api(url(message.account,'conversation',{folder:message.folder,uid:message.uid}));if(token!==request)return;
    if(!data.messages.length)throw Error('Message not found.');
    const current=data.messages.find(m=>m.uid===message.uid&&m.folder===message.folder)||data.messages.at(-1);
    if(current.draft){navigate(message.account,message.folder);await composer.open(a,current);return;}
    opened={...current,account:message.account};
    const targets=data.messages.filter(m=>m.folder===message.folder).map(m=>({...m,account:message.account}));
    const unread=targets.filter(m=>!m.seen);if(unread.length)void setFlags(unread,{seen:true}).catch(failure);
    const junk=currentFolder()?.role==='junk';
    const star=starButton(current.flagged,()=>setFlags([opened],{flagged:!opened.flagged}));
    const tools=h('div',{class:'mail-reading-tools',role:'toolbar','aria-label':'Conversation actions'},btn('Back',back,'ghost mail-back','Back to the list'),
      btn('Reply',()=>compose(current,'reply',a),'ghost mail-wide'),btn('Archive',()=>act('archive',targets),'ghost'),btn('Delete',()=>act('trash',targets),'ghost'),
      btn('Mark unread',()=>setFlags(targets,{seen:false}).then(back),'ghost mail-wide'),star,
      menu('More',[{text:'Reply all',run:()=>compose(current,'replyAll',a)},{text:'Forward',run:()=>compose(current,'forward',a)},{text:'Mark unread',run:()=>setFlags(targets,{seen:false}).then(back)},
        {text:junk?'Not junk':'Report junk',run:()=>act(junk?'notjunk':'junk',targets)},h('label',{class:'mail-menu-move'},h('span',{class:'sr-only',text:'Move to folder'}),moveSelect(targets,back)),
        h('a',{class:'mail-menu-item',href:url(a.id,'raw',{folder:current.folder,uid:current.uid}),target:'_blank',rel:'noopener noreferrer',text:'Show original'}),{text:'Print',run:()=>printMessage(data.messages)}]));
    const f=currentFolder();
    const head=h('div',{class:'mail-reading-head'},h('h2',{class:'mail-reading-subject',text:current.subject||'(no subject)'}),f?h('span',{class:'chip',text:state.starred?'Starred':folderName(f.path)}):null,data.messages.length>1?h('span',{class:'mail-reading-count muted',text:`${data.messages.length} messages`}):null);
    const replies=h('div',{class:'mail-reply-bar'},btn('Reply',()=>compose(current,'reply',a)),btn('Reply all',()=>compose(current,'replyAll',a)),btn('Forward',()=>compose(current,'forward',a)));
    fill(pane,tools,h('div',{class:'mail-reading'},head,data.messages.map((m,i)=>messageCard(m,a,i===data.messages.length-1)),replies));
    pane.scrollTop=0;
    if(matchMedia('(max-width:899px)').matches||!state.split){pane.tabIndex=-1;pane.focus({preventScroll:true});}
  }catch(error){if(token===request)fill(pane,errorState(error.message,()=>openMessage(message)));}
}
async function compose(message,mode='reply',a){
  a||=account()?.connected?account():state.accounts.find(a=>a.connected);
  if(!a){toast('Connect a mailbox before composing.',{error:true});return;}
  if(message && !message.draft && message.text===undefined) message=(await api(url(a.id,'message',{folder:message.folder,uid:message.uid}))).message;
  await composer.open(a,message,mode);
}
function printMessage(messages){
  // A separate owner-only text document lets the browser print without reaching into the opaque HTML frame.
  const win=window.open('','_blank');if(!win)return;
  win.opener=null;const doc=win.document;doc.title=messages.at(-1).subject||'Mail';
  for(const m of messages){const heading=doc.createElement('h2');heading.textContent=m.subject;const from=doc.createElement('p');from.textContent=`${m.from?.name||''} <${m.from?.address||''}> · ${mailDateTime(m.date)}`;const body=doc.createElement('pre');body.textContent=m.text||'Open Show original for the HTML source.';doc.body.append(heading,from,body);}win.print();
}
const SHORTCUTS=[['c','Compose'],['/','Search'],['j / k','Next / previous conversation'],['Enter or o','Open'],['u','Back to the list'],['r','Reply'],['a','Reply all'],['f','Forward'],['e','Archive'],['#','Delete'],['s','Star'],['Shift+U','Mark unread'],['x','Select'],['Ctrl/Cmd+Enter','Send'],['Esc','Close']];
function shortcuts(){
  if(document.querySelector('.mail-shortcuts'))return;
  const dialog=h('dialog',{class:'mail-shortcuts','aria-label':'Mail keyboard shortcuts'},h('h2',{text:'Keyboard shortcuts'}),h('dl',{},SHORTCUTS.flatMap(([k,v])=>[h('dt',{},h('kbd',{text:k})),h('dd',{text:v})])),btn('Close',()=>dialog.close()));
  dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
}
document.addEventListener('keydown',e=>{
  const help=document.querySelector('.mail-shortcuts[open]');
  if(help){if(e.key==='Escape'){e.preventDefault();help.close();}return;}
  const more=document.querySelector('.mail-more[open]');
  if(more&&e.key==='Escape'){e.preventDefault();more.open=false;more.querySelector('summary').focus();return;}
  if(e.key==='Escape'&&root.classList.contains('drawer-open')){setDrawer(false);drawer.focus();return;}
  if(e.defaultPrevented||e.altKey||e.ctrlKey||e.metaKey||e.isComposing||/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)||e.target.isContentEditable)return;
  if(composer.panel){if(e.key==='Escape')void composer.close();return;}
  const row=state.rows[state.active],message=opened&&state.uid?opened:row;
  const target=m=>state.accounts.find(a=>a.id===m.account);
  const actions={c:()=>compose(),'/':()=>searchInput.focus(),j:()=>focusRow(1),k:()=>focusRow(-1),Enter:()=>row&&navigate(row.account,row.folder,row.uid,{starred:state.starred}),o:()=>row&&navigate(row.account,row.folder,row.uid,{starred:state.starred}),u:back,
    r:()=>message&&compose(message,'reply',target(message)),a:()=>message&&compose(message,'replyAll',target(message)),f:()=>message&&compose(message,'forward',target(message)),
    e:()=>message&&act('archive',message.messages||[message]),'#':()=>message&&act('trash',message.messages||[message]),s:()=>message&&setFlags([message],{flagged:!message.flagged}),U:()=>message&&setFlags(message.messages||[message],{seen:false}),
    x:()=>{if(row){const on=row.messages.every(m=>state.selected.has(key(m)));for(const m of row.messages)on?state.selected.delete(key(m)):state.selected.add(key(m));renderRows();rows.querySelector(`[data-index="${state.active}"] .mail-row-open`)?.focus();}},'?':shortcuts,Escape:back};
  // Enter on a focused row link already follows its href.
  if(e.key==='Enter'&&e.target.closest?.('.mail-row-open, button, a, summary'))return;
  if(actions[e.key]){e.preventDefault();void Promise.resolve().then(actions[e.key]).catch(failure);}
});
function focusRow(delta){
  root.classList.add('keyboard');
  state.active=Math.max(0,Math.min(state.rows.length-1,state.active+delta));
  for(const row of rows.querySelectorAll('.mail-row'))row.classList.toggle('active',Number(row.dataset.index)===state.active);
  rows.querySelector(`[data-index="${state.active}"] .mail-row-open`)?.focus();
}
document.addEventListener('pointerdown',()=>root?.classList.remove('keyboard'));
window.addEventListener('hashchange',()=>void loadHash().catch(failure));window.addEventListener('focus',()=>void refresh(false));
window.addEventListener('offline',()=>offline.hidden=false);window.addEventListener('online',()=>{offline.hidden=true;void composer.save();void refresh(false);});
try{build();syncSearch();await accounts();await loadHash();setInterval(()=>void refresh(false),60_000);}catch(error){fill(main(),errorState(error.message,()=>location.reload()));}
