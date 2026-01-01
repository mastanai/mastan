// One lazy, serialized connection per account. Neither protocol library logs content.
import {ImapFlow} from 'imapflow';
import {loadAccounts, credentials} from './config.js';
import {parseMessage, publicMessage, mailError, hasAttachment, mimeTree, validateCompose, composeRaw, smtpTransport} from './message.js';
import {parseSearch, groupThreads, idsOf} from '../web/public/mail-helpers.js';

const OP_TIMEOUT = 45_000, MAX_RAW = 32 * 1024 * 1024;
const fields = {uid: true, envelope: true, flags: true, size: true, bodyStructure: true, headers: ['References','In-Reply-To','Message-ID','Content-Type'], source: {start: 0, maxLength: 4096}};
const roleOf = f => f.specialUse?.replace('\\','').toLowerCase() || (f.path.toLowerCase() === 'inbox' ? 'inbox' : 'other');
const flagView = flags => ({seen: flags.has('\\Seen'), flagged: flags.has('\\Flagged'), answered: flags.has('\\Answered'), draft: flags.has('\\Draft')});
const header = (buffer, key) => new RegExp(`^${key}:([^]*?)(?=\\r?\\n[^ \\t]|$)`, 'im').exec(String(buffer || ''))?.[1]?.replace(/\r?\n[ \t]+/g,' ').trim() || '';
export class MailStore {
  constructor({config, accounts = loadAccounts(config), clientFactory = options => new ImapFlow(options), transport = smtpTransport, now = Date.now, readCredentials = credentials} = {}) {
    Object.assign(this, {config, definitions: accounts, clientFactory, transport, now, readCredentials});
    this.states = new Map(); this.stopped = false; this.sent = new Map();
  }
  definition(id) { const a = this.definitions.find(a => a.id === id && !a.hidden); if (!a) throw mailError(404, 'Mailbox not found.'); return a; }
  async getAccount(id) { const a=this.definition(id); return {id:a.id,label:a.label,addresses:a.addresses,alerts:!!a.alerts}; }
  state(id) { if (!this.states.has(id)) this.states.set(id, {queue: Promise.resolve(), client: null, failures: 0, retryAt: 0}); return this.states.get(id); }
  clientOptions(account, tls) {
    return {host: account.host, port: account.imapPort, secure: true, tls: {...tls, rejectUnauthorized: true, minVersion: 'TLSv1.2'}, logger: false,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000, maxIdleTime: 240_000};
  }
  // A separate, unconnected client with the same certificate and TLS options, for the IDLE watcher. Null without readable credentials.
  watchClient(id) { const account = this.definition(id), tls = this.readCredentials(account); return tls && !this.stopped ? this.clientFactory(this.clientOptions(account, tls)) : null; }
  disconnect(state, {smtp = true} = {}) { const client = state.client; state.client = null; client?.close(); if (smtp) { state.transport?.close(); state.transport = null; } }
  async run(id, action, timeout = OP_TIMEOUT) {
    const account = this.definition(id), state = this.state(id), deadline = this.now() + timeout;
    const work = state.queue.catch(() => {}).then(async () => {
      if (this.stopped || this.now() >= deadline) throw mailError(503, 'The mailbox is busy. Try again.');
      let timer;
      try {
        return await Promise.race([(async () => {
          const tls = this.readCredentials(account);
          if (!tls) throw mailError(503, 'The mailbox certificate or key is missing or unreadable.', 'CERT');
          if (!state.client?.usable) {
            if (this.now() < state.retryAt) throw mailError(503, 'Could not reach the mail server. Trying again.');
            this.disconnect(state);
            const client = this.clientFactory(this.clientOptions(account, tls));
            state.client = client;
            client.on('error', () => {
              if (!this.stopped && state.client === client) {
                state.retryAt = this.now() + Math.min(60_000, 1000 * 2 ** Math.min(++state.failures, 6));
                // An IMAP drop must not cut a submission that is already talking to SMTP.
                this.disconnect(state, {smtp: false});
              }
            }); // Reconnection is performed on the next queued operation.
            client.on('close', () => { if (state.client === client) state.client = null; });
            await client.connect(); // PREAUTH sets AUTHENTICATED; options.auth is deliberately absent.
          }
          const result = await action(state.client, account, tls);
          state.failures = 0; state.retryAt = 0;
          return result;
        })(), new Promise((_, reject) => { timer = setTimeout(() => { this.disconnect(state); reject(mailError(504, 'The mail server took too long. Try again.', 'TIMEOUT')); }, Math.max(1, deadline - this.now())); })]);
      } catch (error) {
        // A certificate problem or an SMTP refusal says nothing about the IMAP connection.
        if (!error.status || error.status >= 500 && !['CERT', 'SMTP'].includes(error.code)) {
          this.disconnect(state); state.retryAt = this.now() + Math.min(60_000, 1000 * 2 ** Math.min(++state.failures, 6));
          console.warn('[mailbox] operation failed', /^[A-Z0-9_]{1,30}$/.test(error.code || '') ? error.code : 'CONNECTION');
        }
        if (error.status) throw error;
        throw mailError(503, 'Could not reach the mail server. Trying again.');
      } finally { clearTimeout(timer); }
    });
    state.queue = work;
    // Bound queue waiting too. The queued callback checks deadline before touching IMAP.
    let timer;
    try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(mailError(504, 'The mailbox is busy. Try again.')), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async accounts() {
    return Promise.all(this.definitions.filter(a => !a.hidden).map(async a => {
      const view = {id: a.id, label: a.label, addresses: a.addresses, alerts: !!a.alerts, connected: false, unread: 0};
      if (!this.readCredentials(a)) return {...view, reason: 'The mailbox certificate or key is missing or unreadable.'};
      try { const folders = await this.folders(a.id); return {...view, connected: true, unread: folders.find(f => f.role === 'inbox')?.unread || 0}; }
      catch (e) { return {...view, reason: e.message}; }
    }));
  }
  async folders(id) {
    return this.run(id, async client => (await client.list({statusQuery: {messages: true, unseen: true}}))
      .filter(f => !f.flags.has('\\Noselect')).map(f => ({path: f.path, name: f.name, role: roleOf(f), total: f.status?.messages || 0, unread: f.status?.unseen || 0})));
  }
  async locked(client, folder, fn) { const lock = await client.getMailboxLock(folder); try { return await fn(); } finally { lock.release(); } }
  async validFolder(client, path) {
    const folder = (await client.list()).find(f => f.path === path && !f.flags.has('\\Noselect'));
    if (!folder) throw mailError(404, 'Folder not found.'); return folder;
  }
  async role(client, name) {
    const folder = (await client.list()).find(f => roleOf(f) === name && !f.flags.has('\\Noselect'));
    if (!folder) throw mailError(409, `This mailbox has no ${name} folder.`); return folder.path;
  }
  async existing(client, uids) {
    const found = await client.search({uid: uids.join(',')}, {uid: true});
    if (uids.some(uid => !found.includes(uid))) throw mailError(404, 'A message was moved or removed. Refresh the folder.');
  }
  async rows(client, folder, uids) {
    if (!uids.length) return [];
    const rows = await client.fetchAll(uids.join(','), fields, {uid: true});
    return Promise.all(rows.map(async m => {
      let snippet = '';
      try { const p = await parseMessage(m.source); snippet = p.text.replace(/\s+/g,' ').trim().slice(0,140); } catch {}
      return {uid: m.uid, folder, from: m.envelope?.from?.[0] || {name:'',address:''}, to: m.envelope?.to || [], cc: m.envelope?.cc || [],
        subject: m.envelope?.subject || '(no subject)', date: m.envelope?.date?.toISOString?.() || new Date(0).toISOString(),
        ...flagView(m.flags), hasAttachment: hasAttachment(m.bodyStructure), report: /(?:report-type|application\/(?:tlsrpt|dmarc))/i.test(String(m.headers || '')) || mimeTree(m.bodyStructure).some(p=>/(?:multipart\/report|application\/(?:tlsrpt|dmarc))/i.test(p.type || '')), size: m.size, snippet,
        messageId: m.envelope?.messageId || header(m.headers,'Message-ID'), inReplyTo: m.envelope?.inReplyTo || header(m.headers,'In-Reply-To'), references: idsOf(header(m.headers,'References'))};
    }));
  }
  async list(id, {folder, page = 1, search = '', allFolders = false, starred = false} = {}) {
    return this.run(id, async client => {
      await this.validFolder(client, folder);
      const query = parseSearch(search), attachment = query.attachment; delete query.attachment;
      if (starred) query.flagged = true;
      const folders = allFolders ? (await client.list()).filter(f => !f.flags.has('\\Noselect') && !['trash','junk'].includes(roleOf(f))).slice(0,20).map(f => f.path) : [folder];
      let results = [], total = 0, partial = false;
      for (const path of folders) await this.locked(client, path, async () => {
        const uids = (await client.search(Object.keys(query).length ? query : {all: true}, {uid: true})).sort((a,b) => b-a);
        if (!allFolders && !attachment) { total = uids.length; results = await this.rows(client, path, uids.slice((page-1)*50, page*50)); }
        else {
          const limit = allFolders ? 100 : 500; partial ||= uids.length > limit;
          const rows = await this.rows(client,path,uids.slice(0,limit)); results.push(...rows.filter(r => !attachment || r.hasAttachment));
        }
      });
      if (allFolders || attachment) { results.sort((a,b) => Date.parse(b.date)-Date.parse(a.date)); total=results.length; results=results.slice((page-1)*50,page*50); }
      return {messages: results, threads: groupThreads(results), total, page, hasMore: page*50 < total, partial};
    });
  }
  async rawLocked(client, uid) {
    const meta = await client.fetchOne(uid, {uid:true,size:true,flags:true}, {uid:true});
    if (!meta) throw mailError(404,'Message not found.');
    if (meta.size > MAX_RAW) throw mailError(413,'This message is too large to open here.');
    const full = await client.fetchOne(uid,{source:true},{uid:true});
    if (!full?.source) throw mailError(404,'Message not found.');
    return {raw: full.source, ...flagView(meta.flags), uid, size: meta.size};
  }
  async raw(id, folder, uid) { return this.run(id,async client => { await this.validFolder(client,folder); return this.locked(client,folder,async () => (await this.rawLocked(client,uid)).raw); }); }
  async message(id, folder, uid) { return this.run(id,async client => { await this.validFolder(client,folder); return this.locked(client,folder,async () => { const {raw,...row}=await this.rawLocked(client,uid); return publicMessage(await parseMessage(raw,{...row,folder})); }); }); }
  async allAttachments(id,folder,uid) { return (await parseMessage(await this.raw(id,folder,uid))).attachments; }
  async attachment(id, folder, uid, index) { const attachments = await this.allAttachments(id,folder,uid); const a=attachments[index]; if (!a) throw mailError(404,'Attachment not found.'); return a; }
  async conversation(id, folder, uid) {
    const seed = await this.message(id,folder,uid);
    if (seed.draft) return [seed];
    const rows = await this.run(id,async client => {
      const sent = await this.role(client,'sent').catch(() => null);
      const refs = [...new Set([...idsOf(seed.references),...idsOf(seed.inReplyTo),...idsOf(seed.messageId)])].slice(-10);
      const queries=refs.flatMap(ref => [{header:{'Message-ID':ref}},{header:{References:ref}},{header:{'In-Reply-To':ref}}]);
      const candidates=[];
      for (const path of [...new Set([folder,sent].filter(Boolean))]) await this.locked(client,path,async () => {
        const found=await client.search(queries.length ? {or:queries} : {subject: seed.subject.replace(/^(re:\s*)+/i,'')},{uid:true});
        const rows=await this.rows(client,path,found.sort((a,b)=>b-a).slice(0,30));
        candidates.push(...rows.filter(m=>path!==sent || this.definition(id).addresses.some(a=>a.address.toLowerCase()===m.from.address?.toLowerCase())));
      });
      return groupThreads([seed,...candidates.filter(r => !(r.folder===folder && r.uid===uid))]).find(g => g.messages.some(m => m.folder===folder && m.uid===uid))?.messages || [seed];
    });
    const messages=[];
    for (const row of rows.slice(0,20)) messages.push(row.folder===folder && row.uid===uid ? seed : await this.message(id,row.folder,row.uid));
    return messages.sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
  }
  async flags(id,folder,uids,flags) {
    return this.run(id, async client => { await this.validFolder(client,folder); return this.locked(client,folder,async () => {
      await this.existing(client,uids);
      for (const [key,value] of Object.entries(flags)) await client[value ? 'messageFlagsAdd' : 'messageFlagsRemove'](uids.join(','),[key==='seen'?'\\Seen':'\\Flagged'],{uid:true});
      return {ok:true};
    }); });
  }
  async move(id,folder,uids,{role,destination}) {
    return this.run(id,async client => {
      await this.validFolder(client,folder);
      const target=role ? await this.role(client,role==='notjunk'?'inbox':role) : (await this.validFolder(client,destination)).path;
      return this.locked(client,folder,async () => {
        await this.existing(client,uids);
        if (role==='junk' || role==='notjunk') {
          await client.messageFlagsAdd(uids.join(','),[role==='junk'?'$Junk':'$NotJunk'],{uid:true});
          await client.messageFlagsRemove(uids.join(','),[role==='junk'?'$NotJunk':'$Junk'],{uid:true});
        }
        if (folder!==target) await client.messageMove(uids.join(','),target,{uid:true});
        return {ok:true};
      });
    });
  }
  async draftCheck(client,account,uid) {
    const meta=await client.fetchOne(uid,{flags:true,envelope:true},{uid:true});
    if (!meta || !meta.flags.has('\\Draft') || !account.addresses.some(a=>a.address.toLowerCase()===meta.envelope?.from?.[0]?.address?.toLowerCase())) throw mailError(404,'Draft not found.');
  }
  async draftDelete(client,account,uid) {
    const folder=await this.role(client,'drafts');
    return this.locked(client,folder,async () => {
      await this.draftCheck(client,account,uid);
      await client.messageDelete(uid,{uid:true});
    });
  }
  async saveDraft(id,input) {
    return this.run(id,async (client,account) => {
      const fields=validateCompose(account,input,{draft:true});
      if(input.related) fields.headers={'X-Mastan-Draft':Buffer.from(JSON.stringify(input.related)).toString('base64')};
      const raw=await composeRaw(fields,true), folder=await this.role(client,'drafts');
      if (input.draftUid) await this.locked(client,folder,()=>this.draftCheck(client,account,input.draftUid));
      const result=await this.locked(client,folder,()=>client.append(folder,raw,['\\Draft','\\Seen']));
      if (!result?.uid) throw mailError(503,'The draft could not be saved.');
      if (input.draftUid) await this.draftDelete(client,account,input.draftUid);
      return {uid:Number(result.uid),folder};
    });
  }
  async deleteDraft(id,uid) { return this.run(id,async(client,account)=>{await this.draftDelete(client,account,uid);return {ok:true};}); }
  async send(id,input) {
    const requestKey=`${id}:${input.sendId}`;
    if (this.sent.has(requestKey)) return this.sent.get(requestKey);
    let accepted=false;
    const interrupted={ok:true,warning:'Sent. The server could not finish saving the copy or updating the draft. Do not send it again.'};
    const work=this.run(id,async(client,account,tls)=>{
      const fields=validateCompose(account,input), raw=await composeRaw(fields), sentFolder=await this.role(client,'sent');
      if (input.related) { await this.validFolder(client,input.related.folder); await this.locked(client,input.related.folder,()=>this.existing(client,[input.related.uid])); }
      if (input.draftUid) { const folder=await this.role(client,'drafts'); await this.locked(client,folder,()=>this.draftCheck(client,account,input.draftUid)); }
      const transport=this.transport(account,tls);this.state(id).transport=transport;
      let recipientWarning='';
      try {
        const result=await transport.sendMail({envelope:{from:fields.from.address,to:[...fields.to,...fields.cc,...fields.bcc].map(a=>a.address)},raw});
        accepted=true;this.sent.set(requestKey,Promise.resolve(interrupted));
        if (result.rejected?.length) recipientWarning='Sent to the accepted recipients. Some recipients were refused. Check Sent before sending to those addresses again.';
      } catch (error) {
        if (error.status) throw error;
        const reason=String(error.response || error.message || '').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,240);
        throw mailError(502, `Could not send. ${reason || 'The mail server refused the message.'} Your draft is saved.`, 'SMTP');
      } finally { transport.close();if(this.state(id).transport===transport)this.state(id).transport=null; }
      // SMTP acceptance is final. Cleanup failure must never offer an automatic resend.
      let warning=recipientWarning;
      try { await this.locked(client,sentFolder,()=>client.append(sentFolder,raw,['\\Seen'])); }
      catch { warning='Sent, but the copy could not be saved to Sent. Your draft was kept. Do not send it again.'; }
      try {
        if (input.related) await this.locked(client,input.related.folder,()=>client.messageFlagsAdd(input.related.uid,[input.related.mode==='forward'?'$Forwarded':'\\Answered'],{uid:true}));
        if (input.draftUid && !warning) await this.draftDelete(client,account,input.draftUid);
      } catch { warning ||= 'Sent. The original message or draft could not be updated. Do not send it again.'; }
      return {ok:true,warning};
    },120_000);
    const promise=work.then(result=>{this.sent.set(requestKey,Promise.resolve(result));return result;},error=>{
      if(accepted)return interrupted;
      this.sent.delete(requestKey);throw error;
    });
    this.sent.set(requestKey,promise);
    if(this.sent.size>200) this.sent.delete(this.sent.keys().next().value);
    return promise;
  }
  async newMail(id,previous) {
    return this.run(id,async client=>{
      const folder=await this.role(client,'inbox');
      return this.locked(client,folder,async()=>{
        const uidValidity=String(client.mailbox.uidValidity), topUid=Math.max(0,Number(client.mailbox.uidNext)-1);
        if(!previous || previous.uidValidity!==uidValidity) return {uidValidity,topUid,folder,messages:[]};
        if(topUid<=previous.topUid) return {uidValidity,topUid,folder,messages:[]};
        const uids=await client.search({uid:`${previous.topUid+1}:*`,seen:false},{uid:true});
        const rows=await this.rows(client,folder,uids.filter(u=>u>previous.topUid).sort((a,b)=>a-b).slice(0,500));
        return {uidValidity,topUid,folder,messages:rows.filter(m=> !m.report && !/\b(dmarc|tls.?rpt|report domain|aggregate report)\b/i.test(m.subject) && !/^(dmarc|tlsrpt|tls-rpt|postmaster.*report)@/i.test(m.from.address))};
      });
    });
  }
  async shutdown() { this.stopped=true; for(const state of this.states.values()) this.disconnect(state); }
}
