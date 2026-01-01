import {randomUUID} from 'node:crypto';

export const TAGS = ['hot', 'warm', 'cold', 'not_sure', 'customer', 'lost'];
export const FIELDS = ['name', 'email', 'phone', 'company', 'tag', 'notes', 'source', 'follow_up', 'last_contact', 'llm_covered', 'server', 'person_id', 'country', 'language', 'people_origin'];
export const OVERLAY = FIELDS.filter(k => !['name', 'email', 'phone'].includes(k));
export function normalizePersonId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const channel = /^(Telegram|WhatsApp hidden) (\d+)$/.exec(text);
  if (channel) return channel[1] + ' ' + channel[2].replace(/^0+(?=\d)/, '');
  return /^[+\d ()-]+$/.test(text) && text.replace(/\D/g, '').length >= 5 ? '+' + text.replace(/\D/g, '') : null;
}
export const pickable = p => p?.masked !== true && !['You', 'ID not found'].includes(p?.id) && Boolean(normalizePersonId(p?.id));
export function createClientsStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, company TEXT,
    tag TEXT CHECK(tag IN ('hot','warm','cold','not_sure','customer','lost')), notes TEXT, source TEXT,
    follow_up TEXT, last_contact TEXT, llm_covered INTEGER CHECK(llm_covered IN (0,1)), server TEXT,
    stripe_customer_id TEXT UNIQUE, canary_user_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS client_events(id TEXT PRIMARY KEY, client_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS client_events_person ON client_events(client_id,at);`);
  if (!db.prepare('PRAGMA table_info(clients)').all().some(c => c.name === 'server')) db.exec('ALTER TABLE clients ADD COLUMN server TEXT');
  for (const field of ['person_id', 'country', 'language', 'people_origin']) if (!db.prepare('PRAGMA table_info(clients)').all().some(c => c.name === field)) db.exec('ALTER TABLE clients ADD COLUMN ' + field + ' TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS clients_person ON clients(person_id) WHERE person_id IS NOT NULL AND person_id != \'\'');
  const rows = () => db.prepare('SELECT * FROM clients ORDER BY updated_at,id').all();
  const events = ids => ids.flatMap(id => db.prepare('SELECT id,at,kind,text FROM client_events WHERE client_id=?').all(id)).sort((a, b) => b.at - a.at);
  const remove = ids => {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) { db.prepare('DELETE FROM client_events WHERE client_id=?').run(id); db.prepare('DELETE FROM clients WHERE id=?').run(id); }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const save = (fields, {ids = [], stripe_customer_id = null, canary_user_id = null, now = Date.now()} = {}) => {
    const id = ids[0] || randomUUID(), old = rows().filter(r => ids.includes(r.id));
    db.exec('BEGIN IMMEDIATE');
    try {
      if (fields.server && rows().some(r => r.server === fields.server && !ids.includes(r.id))) {
        throw Object.assign(new Error('This server is already linked to another person.'), {code: 'CLIENT_SERVER_LINKED'});
      }
      const identities = [fields.person_id, fields.phone].map(normalizePersonId).filter(Boolean);
      const duplicate = rows().find(r => !ids.includes(r.id) && [r.person_id, r.phone].map(normalizePersonId).filter(Boolean).some(id => identities.includes(id)));
      if (duplicate) throw Object.assign(new Error('This person is already in Clients.'), {code: 'CLIENT_PERSON_LINKED', existing_id: duplicate.id});
      for (const extra of ids.slice(1)) {
        if (db.prepare("SELECT name FROM sqlite_master WHERE name='client_deals'").get()) {
          const open = db.prepare("SELECT count(*) AS n FROM client_deals WHERE client_id IN (?,?) AND state!='ended'").get(id, extra).n;
          if (open > 1) throw Object.assign(new Error('Both entries have open deals. End one before merging them.'), {code:'CLIENT_DEALS_OPEN'});
          db.prepare('UPDATE client_deals SET client_id=? WHERE client_id=?').run(id, extra);
        }
        db.prepare('UPDATE client_events SET client_id=? WHERE client_id=?').run(id, extra);
        db.prepare('DELETE FROM clients WHERE id=?').run(extra);
      }
      const value = Object.fromEntries(FIELDS.map(k => [k, null]));
      for (const row of old) for (const k of FIELDS) if (row[k] !== null) value[k] = row[k];
      Object.assign(value, fields);
      db.prepare(`INSERT INTO clients(id,${FIELDS.join(',')},stripe_customer_id,canary_user_id,created_at,updated_at)
        VALUES(${Array(FIELDS.length + 5).fill('?').join(',')}) ON CONFLICT(id) DO UPDATE SET
        ${[...FIELDS, 'stripe_customer_id', 'canary_user_id', 'updated_at'].map(k => `${k}=excluded.${k}`).join(',')}`)
        .run(id, ...FIELDS.map(k => value[k]), stripe_customer_id, canary_user_id, old[0]?.created_at || now, now);
      db.exec('COMMIT'); return id;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const log = (id, text, at, today) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO client_events VALUES(?,?,?,?,?)').run(randomUUID(), id, at, 'contact', text);
      db.prepare('UPDATE clients SET last_contact=?,updated_at=? WHERE id=?').run(today, at, id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const note = (id, text, at) => db.prepare('INSERT INTO client_events VALUES(?,?,?,?,?)').run(randomUUID(), id, at, 'billing', text);
  return {rows, events, save, log, note, remove, match: (id, user) => db.prepare('UPDATE clients SET canary_user_id=? WHERE id=? AND canary_user_id IS NULL').run(user, id)};
}
