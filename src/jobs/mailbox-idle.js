// Server push for new mail alerts: one dedicated IMAP connection per alerting account, INBOX open.
// imapflow idles on its own and emits `exists` when mail arrives; a burst of events runs onMail once.
// The 5 minute poll in mailbox-alerts.js stays as the safety net. Logs carry no content.
export class MailboxIdle {
  constructor({store, onMail, debounce = 2000, minDelay = 2000, maxDelay = 5 * 60_000, stableAfter = 60_000, now = Date.now}) {
    Object.assign(this, {store, onMail, debounce, minDelay, maxDelay, stableAfter, now});
    this.watchers = new Map(); this.stopped = false; this.timer = null; this.busy = false; this.again = false;
  }
  start() {
    for (const account of (this.store.definitions || []).filter(a => a.alerts && !a.hidden)) {
      const w = {id: account.id, client: null, retry: null, failures: 0, openedAt: 0, attempts: 0};
      // Without readable certificates (Mac preview, tests) nothing starts.
      if (this.connect(w)) this.watchers.set(account.id, w);
    }
  }
  connect(w) {
    if (this.stopped) return false;
    let client;
    try { client = this.store.watchClient(w.id); } catch { client = null; }
    if (!client) { w.client = null; return false; }
    w.client = client; w.attempts++;
    client.on('exists', () => { if (w.client === client) this.trigger(); });
    client.on('error', () => this.lost(w, client)); // Closes this client once and schedules the reconnect.
    client.on('close', () => this.lost(w, client));
    void (async () => {
      try {
        await client.connect(); // PREAUTH, as in the store.
        await client.mailboxOpen(await this.store.role(client, 'inbox'));
        if (w.client !== client) return;
        w.openedAt = this.now();
        // Mail that arrived while the watcher was away (or failing) is picked up at once; start() already ticks for the first.
        if (w.attempts > 1) this.trigger();
      } catch {
        if (w.client !== client) return;
        console.warn('[mailbox-idle] connect failed');
        this.lost(w, client);
      }
    })();
    return true;
  }
  lost(w, client) {
    if (w.client !== client) return;
    w.client = null;
    try { client.close(); } catch {}
    if (this.stopped || w.retry) return;
    if (w.openedAt && this.now() - w.openedAt >= this.stableAfter) w.failures = 0;
    w.openedAt = 0;
    const delay = Math.min(this.maxDelay, this.minDelay * 2 ** Math.min(w.failures++, 20));
    w.retry = setTimeout(() => { w.retry = null; this.connect(w); }, delay);
    w.retry.unref?.();
  }
  trigger() {
    if (this.stopped) return;
    if (this.busy) { this.again = true; return; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.fire(); }, this.debounce);
    this.timer.unref?.();
  }
  async fire() {
    this.busy = true;
    try { await this.onMail(); }
    catch { console.warn('[mailbox-idle] alert run failed'); }
    finally {
      this.busy = false;
      if (this.again) { this.again = false; this.trigger(); }
    }
  }
  shutdown() {
    this.stopped = true;
    clearTimeout(this.timer); this.timer = null;
    for (const w of this.watchers.values()) {
      clearTimeout(w.retry); w.retry = null;
      const client = w.client; w.client = null;
      try { client?.close(); } catch {}
    }
  }
}
