import {ATTACHMENT_LIMIT,addressValid,replyFields,fileSize} from './mail-helpers.js';
const {h,api,toast}=window.MM;
const button=(text,action,cls='')=>h('button',{type:'button',class:`btn ${cls}`,text,onclick:()=>void action()});
export class Composer {
  constructor({accounts,changed}) { this.accounts=accounts; this.changed=changed; this.panel=null; this.saving=Promise.resolve(); this.version=0; this.savedVersion=-1; this.hold=null; }
  async open(account,message,mode) {
    if(this.panel) { if(this.hold) { this.restore(); return; } if(!await this.close()) return; }
    this.account=account;this.draftUid=message?.draft?message.uid:null;this.related=message?.draft?message.related:null;
    const fields=message?.draft?{...message,attachments:message.attachments.map(a=>({...a,source:{folder:message.folder,uid:message.uid,index:a.index}}))}:
      message?replyFields(message,account,mode,(typeof this.accounts==='function'?this.accounts():this.accounts||[account]).flatMap(a=>a.addresses)):{to:[],cc:[],bcc:[],subject:'',text:'',attachments:[]};
    this.related=fields.related;this.attachments=fields.attachments || [];this.version=0;this.savedVersion=message?.draft?0:-1;
    const draftFrom=message?.draft&&account.addresses.some(a=>a.address===message.from?.address)?message.from.address:account.addresses[0].address;
    this.from=h('select',{'aria-label':'From'},account.addresses.map(a=>h('option',{value:a.address,text:`${a.name} <${a.address}>`,selected:a.address===draftFrom})));
    this.status=h('span',{class:'muted',role:'status',text:message?.draft?'Saved':''});
    this.recipients={};const recipientRows=['to','cc','bcc'].map(key=>this.addressField(key,fields[key] || []));
    this.subject=h('input',{type:'text',value:fields.subject || '',maxlength:998,'aria-label':'Subject',placeholder:'Subject'});
    this.body=h('textarea',{'aria-label':'Message',placeholder:'Write a message',rows:12});this.body.value=fields.text || '';
    this.files=h('div',{class:'mail-compose-files'});
    const picker=h('input',{type:'file',multiple:true,hidden:true,onchange:()=>{void this.addFiles([...picker.files]);picker.value='';}});
    this.sendButton=button('Send',()=>this.send(),'primary');
    this.panel=h('section',{class:'mail-composer',role:'dialog','aria-label':'Compose message'},
      h('div',{class:'mail-compose-head'},h('strong',{text:message?.draft?'Draft':mode==='forward'?'Forward':message?'Reply':'New message'}),this.status,button('Minimize',()=>this.minimize()),button('Close',()=>this.close())),
      h('div',{class:'mail-compose-content'},h('label',{class:'mail-compose-from'},'From',this.from),recipientRows,
        h('label',{},h('span',{class:'sr-only',text:'Subject'}),this.subject),this.body,this.files,
        h('p',{class:'muted mail-limit',text:'Plain text mail. Attachments: up to 18 MB total.'}),
        h('div',{class:'btn-row'},this.sendButton,button('Attach files',()=>picker.click()),picker,button('Discard',()=>this.discard(),'bad'))));
    this.panel.addEventListener('input',()=>this.dirty());this.panel.addEventListener('change',()=>this.dirty());
    this.panel.addEventListener('dragover',e=>{e.preventDefault();this.panel.classList.add('dragging');});
    this.panel.addEventListener('dragleave',()=>this.panel.classList.remove('dragging'));
    this.panel.addEventListener('drop',e=>{e.preventDefault();this.panel.classList.remove('dragging');void this.addFiles([...e.dataTransfer.files]);});
    this.panel.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();void this.send();}if(e.key==='Escape'){e.stopPropagation();void this.close();}});
    document.body.append(this.panel);this.renderFiles();
    this.body.focus();if(message&&!message.draft)this.body.setSelectionRange(0,0);
    this.beforeUnload=e=>{if(this.hold||this.version!==this.savedVersion){e.preventDefault();e.returnValue='';}};
    window.addEventListener('beforeunload',this.beforeUnload);
  }
  addressField(key,values) {
    const chips=h('div',{class:'mail-address-chips'}),input=h('input',{type:'text','aria-label':key.toUpperCase(),placeholder:key==='to'?'name@example.com':'Add address',autocomplete:'off'});
    const state={values:[...values],input,chips};this.recipients[key]=state;
    const render=()=>{chips.replaceChildren(...state.values.map((a,i)=>h('span',{class:'chip'},a.name||a.address,button('×',()=>{state.values.splice(i,1);render();this.dirty();}))));};
    const commit=()=>{
      const parts=input.value.split(/[,;]+/).map(x=>x.trim()).filter(Boolean);if(!parts.length)return true;
      const parsed=parts.map(text=>{const m=/^(.*?)\s*<([^<>]+)>$/.exec(text);return {name:m?m[1].replace(/^"|"$/g,'').trim():'',address:m?m[2]:text};});
      if(parsed.some(a=>!addressValid(a.address))){input.setCustomValidity('Use an address like name@example.com.');return false;}
      input.setCustomValidity('');for(const a of parsed)if(!state.values.some(v=>v.address.toLowerCase()===a.address.toLowerCase()))state.values.push(a);
      input.value='';render();this.dirty();return true;
    };state.commit=commit;
    input.addEventListener('input',()=>input.setCustomValidity(''));
    input.addEventListener('blur',commit);
    input.addEventListener('keydown',e=>{if(['Enter',',',';','Tab'].includes(e.key)&&input.value.trim()){if(e.key!=='Tab')e.preventDefault();if(!commit())input.reportValidity();}});
    render();return h('label',{class:'mail-address-row'},h('span',{text:key.toUpperCase()}),chips,input);
  }
  renderFiles(){this.files.replaceChildren(...this.attachments.map((a,i)=>h('div',{class:'mail-compose-file'},h('span',{text:`${a.filename} (${fileSize(a.size||0)})`}),button('Remove',()=>{this.attachments.splice(i,1);this.renderFiles();this.dirty();}))));}
  async addFiles(files) {
    if(this.hold)return;
    const total=this.attachments.reduce((n,a)=>n+(a.size||0),0)+files.reduce((n,f)=>n+f.size,0);
    if(total>ATTACHMENT_LIMIT||this.attachments.length+files.length>50){toast('Use at most 50 attachments, totaling 18 MB or less.',{error:true});return;}
    this.reading=true;this.status.textContent='Reading files...';this.sendButton.disabled=true;
    try{
      for(const f of files){const content=await new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=reject;r.onload=()=>resolve(String(r.result).split(',')[1]);r.readAsDataURL(f);});this.attachments.push({filename:f.name,type:f.type||'application/octet-stream',size:f.size,content});}
      this.renderFiles();this.dirty();
    }catch{toast('A file could not be read. Try attaching it again.',{error:true});}
    finally{this.reading=false;this.sendButton.disabled=false;}
  }
  dirty(){if(this.hold)return;this.sendId=null;this.version++;this.status.textContent='Unsaved';clearTimeout(this.timer);this.timer=setTimeout(()=>void this.save(),2500);}
  snapshot(){
    for(const r of Object.values(this.recipients))if(!r.commit()){r.input.reportValidity();throw Error('Check the recipient addresses.');}
    return {from:this.from.value,to:[...this.recipients.to.values],cc:[...this.recipients.cc.values],bcc:[...this.recipients.bcc.values],subject:this.subject.value,text:this.body.value,
      attachments:this.attachments.map(a=>a.source?{filename:a.filename,type:a.type,source:a.source}:{filename:a.filename,type:a.type,content:a.content}),
      ...(this.related?{related:this.related}:{}),...(this.draftUid?{draftUid:this.draftUid}:{})};
  }
  async save(){
    clearTimeout(this.timer);if(!this.panel||this.reading)return false;
    const save=this.saving.catch(()=>{}).then(async()=>{
      if(!this.panel)return false;
      if(this.version===this.savedVersion&&this.draftUid)return true;
      let data;try{data=this.snapshot();}catch(error){this.status.textContent=error.message;return false;}
      const version=this.version,savedAttachments=this.attachments.slice();
      this.status.textContent='Saving...';
      try{
        const draft=await api(`/api/mail/${this.account.id}/draft`,{method:'POST',body:data});this.draftUid=draft.uid;this.savedVersion=version;
        this.attachments=this.attachments.map(a=>{const index=savedAttachments.indexOf(a);return a.source&&index>=0?{...a,source:{folder:draft.folder,uid:draft.uid,index}}:a;});
        this.status.textContent=this.version===version?'Saved':'Unsaved';this.changed();return true;
      }catch(error){this.status.textContent=`Could not save. ${error.message}`;return false;}
    });this.saving=save;return save;
  }
  minimize(){if(!this.panel)return;this.panel.classList.toggle('minimized');void this.save();}
  restore(){this.panel?.classList.remove('minimized');this.body?.focus();}
  async close(){if(this.hold){this.minimize();return false;}if(this.reading){toast('Wait for the files to finish loading.');return false;}if(!await this.save())return false;this.remove();return true;}
  remove(){clearTimeout(this.timer);window.removeEventListener('beforeunload',this.beforeUnload);this.panel?.remove();this.panel=null;this.changed();}
  async discard(){if(this.hold)this.undo();await this.saving;if(this.draftUid){try{await api(`/api/mail/${this.account.id}/discard`,{method:'POST',body:{uid:this.draftUid}});}catch(error){toast(error.message,{error:true});return;}}this.remove();}
  undo(){if(!this.hold||this.hold.started)return;clearTimeout(this.hold.timer);this.hold.toast.remove();this.hold=null;this.lock(false);this.restore();this.status.textContent='Saved';}
  lock(locked){for(const el of this.panel.querySelectorAll('input,textarea,select,button'))el.disabled=locked;}
  async send(){
    if(!this.panel||this.hold||this.reading||this.submitting)return;
    let input;try{input=this.snapshot();if(!input.to.length&&!input.cc.length&&!input.bcc.length)throw Error('Add a recipient.');}catch(error){toast(error.message,{error:true});return;}
    this.submitting=true;this.lock(true);
    if(!await this.save()){this.submitting=false;this.lock(false);return;}
    // The id stays the same until the text changes, so a retry after a lost response cannot send twice.
    input=this.snapshot();input.draftUid=this.draftUid;input.sendId=this.sendId||=crypto.randomUUID();this.lock(true);
    const cancel=button('Undo',()=>this.undo());const note=h('div',{class:'mail-undo',role:'status'},h('span',{text:'Sending in 10 seconds.'}),cancel);document.body.append(note);
    this.hold={toast:note,timer:setTimeout(async()=>{
      this.hold.started=true;note.replaceChildren(h('span',{text:'Sending...'}));
      try{const result=await api(`/api/mail/${this.account.id}/send`,{method:'POST',body:input});this.hold=null;note.remove();this.remove();toast(result.warning||'Message sent.',{ms:result.warning?15000:4000});}
      catch(error){this.hold=null;note.remove();this.lock(false);this.status.textContent=`Send failed. ${error.message}`;this.restore();toast(error.message,{error:true,ms:12000});}
      finally{this.submitting=false;}
    },10_000)};this.submitting=false;
  }
}
