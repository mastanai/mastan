// mastan-me-admin auth commands: enrol, passkeys, revoke, sessions, test-login, import-passkeys.
// Links print once to the operator's terminal; only hashes are stored.
import {readFileSync} from 'node:fs';
import {config} from '../config.js';
import {openDb} from '../db.js';
import {enrol, operatorLink, listPasskeys, revokeCredential, listSessions, revokeAllSessions, importPasskeys,
  prune, ensureAuthTables, ENROL_TTL, OPERATOR_LINK_TTL, OPERATOR_SESSION_TTL} from '../web/auth.js';

function db() {
  const d = openDb();
  ensureAuthTables(d);
  prune(d);
  return d;
}
const minutes = ms => Math.round(ms / 60_000);
function noArgs(args) { if (args.length) throw new Error('Too many arguments'); }

export const commands = {
  'enrol': {
    help: 'One-time link to register a new passkey (single use, 10 minutes)',
    run(args) {
      noArgs(args);
      const value = enrol(db());
      console.log(`https://${config.host}/login#enrol=${value}`);
      console.log(`Single use. Expires in ${minutes(ENROL_TTL)} minutes. Registers a passkey for ${config.rpId}. Treat this link as private.`);
    },
  },
  'passkeys': {
    help: 'List passkeys (handle, origin, created)',
    run(args) {
      noArgs(args);
      const rows = listPasskeys(db());
      if (!rows.length) { console.log('No passkeys.'); return; }
      for (const r of rows) console.log(`${r.handle.padEnd(14)} ${r.origin.padEnd(6)} ${r.created}  ${r.transports.join(',')}`);
    },
  },
  'revoke': {
    help: '<handle>  Remove a passkey and its sessions',
    run(args) {
      if (args.length !== 1) throw new Error('Usage: mastan-me-admin revoke <handle>');
      if (!revokeCredential(db(), args[0])) throw new Error('Unknown passkey handle');
      console.log('Passkey and its sessions revoked.');
    },
  },
  'sessions': {
    help: '[--revoke-all]  List web sessions, or sign every session out',
    run(args) {
      if (args.length > 1 || (args.length === 1 && args[0] !== '--revoke-all')) throw new Error('Usage: mastan-me-admin sessions [--revoke-all]');
      if (args[0] === '--revoke-all') { console.log(`Sessions revoked: ${revokeAllSessions(db())}`); return; }
      const rows = listSessions(db());
      if (!rows.length) { console.log('No active sessions.'); return; }
      for (const r of rows) console.log(`${r.handle.padEnd(14)} ${r.kind.padEnd(9)} expires ${r.expires}`);
    },
  },
  'test-login': {
    help: 'Operator check: single-use sign-in link (10 minutes) for a 30 minute session',
    run(args) {
      noArgs(args);
      const value = operatorLink(db());
      console.log(`https://${config.host}/login#operator=${value}`);
      console.log(`Single use. Link expires in ${minutes(OPERATOR_LINK_TTL)} minutes; the session lasts ${minutes(OPERATOR_SESSION_TTL)} minutes and cannot change models. Treat this link as private.`);
    },
  },
  'import-passkeys': {
    help: '<json-file>  Copy Topic Board passkey rows [{id, public_key_b64, counter, transports, created}] (idempotent)',
    run(args) {
      if (args.length !== 1) throw new Error('Usage: mastan-me-admin import-passkeys <json-file>');
      let rows;
      try { rows = JSON.parse(readFileSync(args[0], 'utf8')); } catch { throw new Error('Could not read a JSON array from that file'); }
      const r = importPasskeys(db(), rows);
      console.log(`Passkeys imported: ${r.inserted} new, ${r.updated} counter updated, ${r.unchanged} already present.`);
    },
  },
};
