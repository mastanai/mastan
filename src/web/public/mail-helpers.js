// Shared, pure mailbox rules. Used by the browser, store and network-free tests.
export const ATTACHMENT_LIMIT = 18 * 1024 * 1024; // JSON base64 plus fields fits nginx's 25 MiB.
export const addressValid = value => typeof value === 'string' && value.length <= 254 && /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(value);
export const idsOf = value => [...String(Array.isArray(value) ? value.join(' ') : value || '').matchAll(/<[^<>\s]{1,250}>/g)].map(m => m[0]).slice(-30);
export const normalizedSubject = value => String(value || '').replace(/^(?:(?:re|fw|fwd):\s*)+/i, '').trim().toLowerCase();
export function parseSearch(value = '') {
  const query = {}, words = [];
  for (const token of String(value).match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    const match = /^(from|to|subject|has|is):(.*)$/i.exec(token);
    const text = (match ? match[2] : token).replace(/^"|"$/g, '');
    if (!match) { words.push(text); continue; }
    const key = match[1].toLowerCase();
    if (['from','to','subject'].includes(key)) { if (text) query[key] = text; }
    else if (key === 'has' && text === 'attachment') query.attachment = true;
    else if (key === 'is' && text === 'unread') query.seen = false;
    else if (key === 'is' && text === 'starred') query.flagged = true;
    else words.push(token);
  }
  if (words.length) query.text = words.join(' ');
  return query;
}
export function groupThreads(rows) {
  const groups = [], parents = rows.map((_, i) => i), keys = new Map();
  const root = i => parents[i] === i ? i : (parents[i] = root(parents[i]));
  const join = (a, b) => { parents[root(b)] = root(a); };
  const participants = row => new Set([row.from, ...(row.to || []), ...(row.cc || [])].filter(Boolean).map(a => a.address?.toLowerCase()).filter(Boolean));
  rows.forEach((row, i) => {
    if (row.draft) return;
    for (const id of [...idsOf(row.messageId), ...idsOf(row.inReplyTo), ...idsOf(row.references)]) {
      if (keys.has(id)) join(i, keys.get(id)); else keys.set(id, i);
    }
    for (let j = 0; j < i; j++) {
      // An explicit, different reference chain wins over a subject coincidence.
      if (rows[j].draft) continue;
      if (idsOf(row.references).length || idsOf(rows[j].references).length) continue;
      const subject = normalizedSubject(row.subject), a = participants(row), b = participants(rows[j]);
      if (subject && subject === normalizedSubject(rows[j].subject) && [...a].some(x => b.has(x))) join(i, j);
    }
  });
  const byRoot = new Map();
  rows.forEach((row, i) => { const key = root(i); if (!byRoot.has(key)) { const g = []; groups.push(g); byRoot.set(key, g); } byRoot.get(key).push(row); });
  return groups.map(messages => {
    messages.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.uid - a.uid);
    return {...messages[0], count: messages.length, seen: messages.every(m => m.seen), flagged: messages.some(m => m.flagged), hasAttachment: messages.some(m => m.hasAttachment), messages};
  }).sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.uid - a.uid);
}
export function replyFields(message, account, mode = 'reply', ownAddresses = account.addresses) {
  const own = new Set(ownAddresses.map(a => a.address.toLowerCase()));
  const unique = list => [...new Map(list.filter(a => a?.address && !own.has(a.address.toLowerCase())).map(a => [a.address.toLowerCase(), a])).values()];
  const recipients = message.replyTo?.length ? message.replyTo : own.has(message.from?.address?.toLowerCase()) ? message.to || [] : [message.from];
  const to = mode === 'forward' ? [] : unique(mode === 'replyAll' ? [...recipients, ...(message.to || [])] : recipients);
  const cc = mode === 'replyAll' ? unique(message.cc || []).filter(a => !to.some(t => t.address.toLowerCase() === a.address.toLowerCase())) : [];
  const forwarded = mode === 'forward';
  const subject = `${forwarded ? 'Fwd:' : 'Re:'} ${String(message.subject || '').replace(forwarded ? /^(?:fwd?:\s*)+/i : /^(?:re:\s*)+/i, '')}`;
  const label = a => a ? `${a.name ? a.name + ' ' : ''}<${a.address}>` : '';
  const when = mailDateTime(message.date, new Date(0)) || String(message.date || ''); // Always with the year in quoted mail.
  const quote = forwarded ? `\n\nForwarded message\nFrom: ${label(message.from)}\nDate: ${when}\nSubject: ${message.subject}\nTo: ${(message.to || []).map(label).join(', ')}\n\n${message.text || ''}`
    : `\n\nOn ${when}, ${label(message.from)} wrote:\n${String(message.text || '').split('\n').map(l => '> ' + l).join('\n')}`;
  return {to, cc, bcc: [], subject, text: quote, inReplyTo: forwarded ? '' : idsOf(message.messageId)[0] || '',
    references: forwarded ? [] : [...new Set([...idsOf(message.references), ...idsOf(message.messageId)])].slice(-30),
    related: {folder: message.folder, uid: message.uid, mode: forwarded ? 'forward' : 'reply'}, attachments: forwarded ? (message.attachments || []).map(a => ({...a, source: {folder: message.folder, uid: message.uid, index: a.index}})) : []};
}
export function mailDate(value, now = new Date()) {
  const d = new Date(value); if (Number.isNaN(d.getTime())) return '';
  const parts = date => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Riyadh', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(date).map(p => [p.type, p.value]));
  const a = parts(d), b = parts(now);
  if (a.year === b.year && a.month === b.month && a.day === b.day) return `${a.hour}:${a.minute}`;
  return `${a.day} ${a.month}${a.year === b.year ? '' : ' ' + a.year}`;
}
// Reading-pane header: always the time, plus the year when it is not this year.
export function mailDateTime(value, now = new Date()) {
  const d = new Date(value); if (Number.isNaN(d.getTime())) return '';
  const parts = date => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Riyadh', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(date).map(p => [p.type, p.value]));
  const a = parts(d), b = parts(now);
  return `${a.day} ${a.month}${a.year === b.year ? '' : ' ' + a.year} ${a.hour}:${a.minute}`;
}
// "to me, Mira Veylan" style recipient summary. Own addresses read as "me".
export function recipientSummary(message, ownAddresses = []) {
  const own = new Set(ownAddresses.map(a => String(a.address || a).toLowerCase()));
  const names = [...(message.to || []), ...(message.cc || []), ...(message.bcc || [])].filter(a => a?.address)
    .map(a => own.has(a.address.toLowerCase()) ? 'me' : (a.name || a.address));
  const unique = [...new Set(names)];
  return unique.length ? `to ${unique.slice(0, 3).join(', ')}${unique.length > 3 ? ` and ${unique.length - 3} more` : ''}` : 'to undisclosed recipients';
}
export const fileSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
