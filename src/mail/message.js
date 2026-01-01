import PostalMime from 'postal-mime';
import MailComposer from 'nodemailer/lib/mail-composer';
import nodemailer from 'nodemailer';
import {sanitizeHtml} from './sanitize.js';
import {connect as connectTls} from 'node:tls';
import {randomUUID} from 'node:crypto';
import {ATTACHMENT_LIMIT, addressValid, idsOf} from '../web/public/mail-helpers.js';

export const mailError = (status, message, code = 'MAIL') => Object.assign(new Error(message), {status, expose: true, code});
export const safeFilename = name => String(name || 'attachment').replace(/[\x00-\x1f\x7f/\\"<>:|?*]/g, '_').slice(0,180).toWellFormed() || 'attachment';
export const mimeTree = tree => tree ? [tree, ...(tree.childNodes || []).flatMap(mimeTree)] : [];
export const hasAttachment = tree => mimeTree(tree).some(p => p.disposition?.toLowerCase() === 'attachment' || p.dispositionParameters?.filename || p.parameters?.name);
export async function parseMessage(raw, row = {}) {
  const parsed = await PostalMime.parse(raw);
  let related;
  if (row.draft) {
    try { const data = JSON.parse(Buffer.from(parsed.headers.find(h => h.key === 'x-mastan-draft')?.value || '', 'base64').toString()); if (data && ['reply','forward'].includes(data.mode) && typeof data.folder === 'string' && Number.isInteger(data.uid)) related = data; } catch {}
  }
  return {...row, related, from: parsed.from || row.from, to: parsed.to || [], cc: parsed.cc || [], bcc: parsed.bcc || [], replyTo: parsed.replyTo || [],
    subject: parsed.subject || '', date: parsed.date || row.date, text: parsed.text || '', html: parsed.html || '', hiddenImages: sanitizeHtml(parsed.html).hiddenImages,
    messageId: parsed.messageId || '', inReplyTo: parsed.inReplyTo || '', references: idsOf(parsed.references),
    headers: parsed.headers.filter(h => ['content-type','auto-submitted','list-id'].includes(h.key)),
    attachments: parsed.attachments.map((a, index) => ({index, filename: safeFilename(a.filename), type: a.mimeType || 'application/octet-stream',
      size: a.content.byteLength, contentId: (a.contentId || '').replace(/^<|>$/g,''), inline: a.disposition === 'inline', content: Buffer.from(a.content)}))};
}
export function publicMessage(message) {
  const {raw, ...view} = message;
  return {...view, attachments: message.attachments.map(({content, ...a}) => a)};
}
export function validateCompose(account, input, {draft = false} = {}) {
  if (!input || typeof input !== 'object') throw mailError(400, 'Check the message fields.');
  const from = account.addresses.find(a => a.address.toLowerCase() === String(input.from || '').toLowerCase());
  if (!from) throw mailError(400, 'Choose one of this mailbox’s From addresses.');
  const recipients = key => {
    if (!Array.isArray(input[key]) || input[key].length > 100) throw mailError(400, `Check the ${key.toUpperCase()} addresses.`);
    return input[key].map(a => {
      if (!addressValid(a?.address) || typeof (a.name || '') !== 'string' || /[\r\n]/.test(a.name || '') || (a.name || '').length > 200) throw mailError(400, `Check the ${key.toUpperCase()} addresses.`);
      return {address: a.address, name: a.name || ''};
    });
  };
  const to = recipients('to'), cc = recipients('cc'), bcc = recipients('bcc');
  if (!draft && !to.length && !cc.length && !bcc.length) throw mailError(400, 'Add a recipient.');
  if (typeof input.subject !== 'string' || input.subject.length > 998 || /[\r\n]/.test(input.subject) || typeof input.text !== 'string' || input.text.length > 500_000) throw mailError(400, 'The subject or message is too long.');
  if (!Array.isArray(input.attachments) || input.attachments.length > 50) throw mailError(400, 'Use at most 50 attachments.');
  let size = 0;
  const attachments = input.attachments.map(a => {
    if (!a || typeof a.filename !== 'string' || typeof a.content !== 'string') throw mailError(400, 'An attachment could not be read.');
    if (a.content.length > Math.ceil((ATTACHMENT_LIMIT - size) / 3) * 4) throw mailError(413, 'Attachments must total 18 MB or less.');
    const padding = a.content.endsWith('==') ? 2 : a.content.endsWith('=') ? 1 : 0;
    if (a.content.length % 4 || /[^a-z0-9+/=]/i.test(a.content) || a.content.indexOf('=') !== (padding ? a.content.length - padding : -1)) throw mailError(400, 'An attachment could not be read.');
    const content = Buffer.from(a.content, 'base64'); size += content.length;
    return {filename: safeFilename(a.filename), content, contentType: /^[\w.+-]+\/[\w.+-]+$/.test(a.type) ? a.type : 'application/octet-stream'};
  });
  if (size > ATTACHMENT_LIMIT) throw mailError(413, 'Attachments must total 18 MB or less.');
  return {from, to, cc, bcc, subject: input.subject, text: input.text, attachments,
    inReplyTo: idsOf(input.inReplyTo)[0] || undefined, references: idsOf(input.references),
    messageId: `<${randomUUID()}@mastan.ai>`, date: new Date(), disableFileAccess: true, disableUrlAccess: true};
}
export function composeRaw(fields, keepBcc = false) {
  const message = new MailComposer(fields).compile();
  message.keepBcc = keepBcc;
  return new Promise((resolve, reject) => message.build((error, raw) => error ? reject(error) : resolve(raw)));
}
// 10.2.1's customAuth passes sendCommand and resolves only on success. No password or manual SMTP parser needed.
export async function externalAuth(ctx) {
  const response = await ctx.sendCommand('AUTH EXTERNAL =');
  if (response.status !== 235) throw Object.assign(new Error(response.text || 'Certificate sign-in was refused.'), {code: 'EAUTH'});
}
export function smtpTransport(account, tls) {
  let socket;
  const mailer = nodemailer.createTransport({host: account.host, port: account.smtpPort, secure: true, name: 'me.example.com', tls,
    forceAuth: true, auth: {type: 'custom', method: 'EXTERNAL'}, customAuth: {EXTERNAL: externalAuth},
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 90_000, logger: false, debug: false,
    getSocket(_options, done) {
      let settled = false;
      try { socket = connectTls({host: account.host, port: account.smtpPort, servername: account.host, ...tls, rejectUnauthorized: true, minVersion: 'TLSv1.2'}); }
      catch (error) { done(error); return; } // tls.connect throws synchronously on unusable options.
      const timer = setTimeout(() => socket.destroy(Object.assign(new Error('Connection timed out.'), {code: 'ETIMEDOUT'})), 15_000);
      socket.once('secureConnect', () => { settled = true; clearTimeout(timer); done(null, {connection: socket, secured: true}); });
      socket.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); done(error); } });
      socket.once('close', () => { clearTimeout(timer); if (!settled) { settled = true; done(new Error('The connection closed.')); } });
    }});
  // SMTPTransport.close alone only releases authentication helpers. Own the socket so
  // operation deadlines and SIGTERM really cancel a pending submission.
  return {sendMail: message => mailer.sendMail(message), close() { socket?.destroy(); mailer.close(); }};
}
