// Independent of Gmail. The checkpoint holds only account id, UIDVALIDITY and UID.
// Notices go to canary Mastan (WhatsApp) first; Telegram `notify` is the fallback so nothing is lost.
import {safeLine} from './mail-alerts.js';
const cleanAddress = value => String(value||'').replace(/[`*\[\]()<>#~|\s\x00-\x1f\x7f]/g,'').slice(0,120);
const riyadhDay = at => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Riyadh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at)).replace(/-/g,'');
const failureCode = error => /^[A-Z0-9_]{1,20}$/.test(error?.code||'') ? error.code : 'ERROR';
const HEALTH_TEXT = '📧 Mail alerts problem\nMailbox alerts have been failing for an hour. You may be missing mail.';
export class MailboxAlerts {
  constructor({db,store,notify,send=null,origin='https://me.example.com',now=Date.now}) { Object.assign(this,{db,store,notify,send,origin,now}); this.running=false; this.again=false; this.stopped=false; this.failures=new Map(); }
  state(id,value) {
    const key=`mailbox_alerts:${id}`;
    if(value===undefined) { try { const state=JSON.parse(this.db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value || 'null'); return state && typeof state.uidValidity==='string' && /^\d+$/.test(state.uidValidity) && Number.isInteger(state.topUid) && state.topUid>=0 && state.topUid<=4294967295 ? state : null; } catch { return null; } }
    this.db.prepare('INSERT INTO kv(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated').run(key,JSON.stringify(value),Date.now());
  }
  // Every line is capped so a notice stays well under canary's 700 character limit.
  link(account,folder,uid) { return `${this.origin}/mail#${encodeURIComponent(account.id)}/${encodeURIComponent(folder).slice(0,80)}${uid===undefined?'':'/'+uid}`.slice(0,200); }
  accountAddress(account) { return cleanAddress(account.addresses?.[0]?.address) || safeLine(account.label||account.id,60); }
  recipient(account,m) {
    const own=new Set((account.addresses||[]).map(a=>String(a.address).toLowerCase()));
    const hit=[...(m.to||[]),...(m.cc||[])].find(a=>own.has(String(a?.address||'').toLowerCase()));
    return hit ? cleanAddress(hit.address) : this.accountAddress(account);
  }
  messageNotice(account,uidValidity,folder,m) {
    const header='📧 New email', link=this.link(account,folder,m.uid);
    return {id:`mail:${account.id}:${uidValidity}:${m.uid}`,
      text:[header,this.recipient(account,m),`From: ${safeLine(m.from?.name,60)} <${cleanAddress(m.from?.address)}>`,`Subject: ${safeLine(m.subject)}`,link].join('\n'),
      fallback:[header,this.accountAddress(account),link].join('\n')};
  }
  summaryNotice(account,folder,messages) {
    const header='📧 New emails', link=this.link(account,folder);
    return {id:`mail:${account.id}:summary:${messages.at(-1).uid}`,text:[header,`${messages.length} new messages for ${this.accountAddress(account)}`,link].join('\n'),fallback:[header,link].join('\n')};
  }
  healthNotice() { return {id:`mail:health:${riyadhDay(this.now())}`,text:HEALTH_TEXT,fallback:HEALTH_TEXT}; }
  // Resolves once one path accepted the notice; throws only when canary and Telegram both failed.
  async deliver(notice) {
    if(this.send) {
      try { await this.send(notice); return 'canary'; }
      catch(error) { console.warn('[mailbox-alerts] canary notice failed', failureCode(error)); }
    }
    await this.notify(notice.text);
    return 'telegram';
  }
  async tick() {
    if(this.stopped || process.env.MASTAN_ME_MAIL_ALERTS==='off') return;
    // A push that lands during a run gets one more run afterwards instead of waiting for the poll.
    if(this.running) { this.again=true; return; }
    this.running=true;
    try {
      // Definitions are used here so one unavailable mailbox cannot stall the other accounts' alerts.
      const accounts=this.store.definitions || await this.store.accounts();
      for(const account of accounts.filter(a=>a.alerts && !a.hidden)) {
        try {
          const previous=this.state(account.id), next=await this.store.newMail(account.id,previous);
          if(previous && previous.uidValidity===next.uidValidity) {
            const messages=next.messages.filter(m=>m.uid>previous.topUid && !m.seen && !m.report && !/\b(dmarc|tls.?rpt|report domain|aggregate report)\b/i.test(m.subject)).sort((a,b)=>a.uid-b.uid);
            if(messages.length>5) await this.deliver(this.summaryNotice(account,next.folder,messages));
            else for(const m of messages) {
              await this.deliver(this.messageNotice(account,next.uidValidity,next.folder,m));
              // Advance after each accepted notice so a later failure does not duplicate earlier alerts.
              this.state(account.id,{uidValidity:next.uidValidity,topUid:m.uid});
            }
          }
          this.state(account.id,{uidValidity:next.uidValidity,topUid:next.topUid});
          this.failures.delete(account.id);
        } catch {
          const n=(this.failures.get(account.id)||0)+1; this.failures.set(account.id,n);
          console.warn('[mailbox-alerts] poll failed');
          if(n===12) await this.deliver(this.healthNotice()).catch(()=>{});
        }
      }
    } finally {
      this.running=false;
      if(this.again) { this.again=false; void this.tick(); }
    }
  }
  start() { void this.tick(); this.timer=setInterval(()=>void this.tick(),5*60_000); this.timer.unref(); }
  shutdown() { this.stopped=true; this.again=false; clearInterval(this.timer); }
}
