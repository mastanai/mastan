import {createStripe, riyadhDay} from '../clients/stripe.js';
import {createClientsStore, TAGS, FIELDS, OVERLAY, normalizePersonId} from '../clients/store.js';
import {buildPeople, kpis, publicPerson} from '../clients/people.js';
import {createCanary} from '../clients/canary.js';
import {readFleet} from '../clients/fleet.js';
import {createBilling} from '../clients/billing.js';
import {createDeals} from '../clients/deals.js';

export function createClientsRoutes(ctx, {readJson, onlyKeys, fail, json}, {stripeTransport, canaryFetch, now = Date.now} = {}) {
  const stripe = createStripe(ctx.config, {stripeTransport, now}), store = createClientsStore(ctx.db);
  const billing = createBilling(ctx, {transport: stripeTransport || globalThis.fetch, now, onEvent: (id, text) => store.note(id, text, now()), alert: ctx.notifyOwner});
  const deals = createDeals({...ctx, billing, store}, {transport: stripeTransport || globalThis.fetch, now, onEvent: (id, text) => store.note(id, text, now())});
  const canary = createCanary(ctx.config, {canaryFetch, now});
  const refuse = message => Object.assign(fail(400, message), {expose: true});
  const fleetSnapshot = () => readFleet(ctx.fleetUsageFile || '/var/www/fleet-usage/data.json', now());
  const snapshot = async (refresh, saving = false) => {
    const [data, feed, fleet] = await Promise.all([stripe(refresh), saving && canary.cached() || canary(refresh), fleetSnapshot()]);
    return {data, feed, fleet, people: buildPeople(data, feed, store, now(), fleet)};
  };
  const validateServer = (server, fleet) => {
    if (server == null || server === '') return;
    if (typeof server !== 'string' || server.length > 64) throw refuse('Choose a valid server name, up to 64 characters.');
    if (fleet.state !== 'unavailable') {
      if (!fleet.servers.some(s => s.name === server)) throw refuse('Choose a server listed in Fleet.');
    } else if (!/^[A-Za-z0-9._-]+$/.test(server)) throw refuse('Use letters, numbers, dots, underscores, or hyphens for the server name.');
  };
  const save = (fields, options) => {
    try { return store.save(fields, options); }
    catch (error) { if (error.code === 'CLIENT_PERSON_LINKED') throw Object.assign(refuse(error.message), {status: 409, existing_id: error.existing_id}); if (['CLIENT_SERVER_LINKED','CLIENT_DEALS_OPEN'].includes(error.code)) throw refuse(error.message); throw error; }
  };
  function validate(input, allowed) {
    onlyKeys(input, allowed);
    for (const [key, value] of Object.entries(input)) {
      if (key === 'people_origin' && !['public','other',''].includes(value)) throw refuse('Choose a valid People contact.');
      if (key === 'person_id' && value !== '' && !normalizePersonId(value)) throw refuse('Choose a person with a visible number or Telegram id.');
      if (key === 'llm_covered') { if (![null, 0, 1].includes(value)) throw refuse('Choose Yes, No, or Unknown.'); continue; }
      if (key === 'server' && value === null) continue;
      if (value === null && key === 'tag') continue;
      if (typeof value !== 'string' || value.length > (key === 'notes' ? 8000 : key === 'text' ? 1000 : key === 'email' ? 320 : 200)) throw refuse('Text is too long or invalid.');
      if (key === 'tag' && !TAGS.includes(value)) throw refuse('Choose a valid tag.');
      if (['follow_up', 'last_contact'].includes(key) && value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw refuse('Use a valid date.');
      if (key === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw refuse('Use a valid email.');
    }
    return input;
  }
  const savePerson = (person, patch) => {
    const fields = Object.fromEntries((person.manual ? FIELDS : OVERLAY).filter(k => person[k] !== undefined).map(k => [k, person[k]]));
    // Keep an unset coverage unset; displaying a plan default must not store it.
    if (person.llm_default) fields.llm_covered = null;
    if (person.tag_default) fields.tag = null;
    return save({...fields, ...patch}, {ids: person._rows.map(r => r.id), stripe_customer_id: person.stripe_customer_id || null,
      canary_user_id: person.canary_user_id || person._billing_user || null, now: now()});
  };
  const billingOf = person => person._rows.map(r => billing.view(r.id)).find(Boolean) || null;
  const routes = async (req, res, path, session) => {
    if (!session || session.operator) throw fail(404);
    if (path === '/api/clients' && ['GET', 'HEAD'].includes(req.method)) {
      const {data, feed, fleet, people} = await snapshot(new URL(req.url, 'http://x').searchParams.get('refresh') === '1');
      for (const p of people) {
        p.billing = billingOf(p);
        const clientId = p._rows.map(r => r.id).find(id => deals.view(id).current || deals.view(id).history.length);
        if (clientId) await deals.refresh(clientId);
        const deal = clientId ? deals.view(clientId) : {current: null, history: []};
        p.deal = deal.current; p.deal_history = deal.history;
        p.deal_ending = Boolean(p.deal?.state === 'active' && p.deal.ends_at && p.deal.ends_at >= now() && p.deal.ends_at <= now() + 7 * 86400_000);
        if (p.deal_ending && p.action_rank > 1) { p.action_rank = 1; p.action_reason = 'Deal ends within 7 days'; }
      }
      return json(res, 200, {...data, deals: {ready: deals.connected(), mode: (await deals.keyState()).mode}, people: people.map(p => publicPerson(p)), kpis: kpis(people, data.mode), feed: {state: feed.state, generated_at: feed.generated_at, warning: feed.warning},
        servers: fleet.servers.filter(s => s.kind === 'Client').map(({name, client}) => ({name, client}))});
    }
    if (path === '/api/clients/person-ids') {
      if (req.method !== 'POST') throw fail(405);
      onlyKeys(await readJson(req), []);
      return json(res, 200, {person_ids: store.rows().map(r => r.person_id).filter(Boolean)});
    }
    if (['/api/clients/deals/preview', '/api/clients/deals/apply', '/api/clients/deals/end', '/api/clients/deals/copy', '/api/clients/deals/send'].includes(path)) {
      if (req.method !== 'POST') throw fail(405);
      const input = await readJson(req, 4 * 1024), action = path.split('/').pop();
      onlyKeys(input, ['id', ...(action === 'preview' || action === 'apply' ? ['kind','plan','duration','months','value','reason','note', ...(action === 'apply' ? ['cancel_paid'] : [])] : action === 'send' ? ['text','language'] : action === 'copy' ? ['language'] : [])]);
      if (input.cancel_paid !== undefined && typeof input.cancel_paid !== 'boolean') throw refuse('Review the deal before applying.');
      if (typeof input.id !== 'string' || !input.id || input.id.length > 200 || input.id.startsWith('sample:')) throw refuse('Choose a real person.');
      const {people, data} = await snapshot(false), person = people.find(p => p.id === input.id || p._rows.some(r => r.id === input.id));
      if (!person || person.sample) throw fail(404);
      person.billing = billingOf(person);
      if (data.mode === 'sample' && ['apply','send','end'].includes(action)) throw refuse('Sample data cannot apply deals or send messages.');
      if (action === 'preview') { const {user_id, price_id, product_id, ...value} = await deals.preview(person, input); return json(res, 200, value); }
      const clientId = person._rows.map(r => r.id).find(id => deals.view(id).current || billing.view(id)) || savePerson(person, {});
      let result;
      try {
        if (action === 'apply') result = await deals.apply(clientId, person, input);
        if (action === 'end') result = await deals.end(clientId);
        if (action === 'copy') result = deals.copy(clientId, input.language || person.language);
        if (action === 'send') result = await deals.send(clientId, person, input.text, input.language);
      } catch (error) {
        if (['apply','end','send'].includes(action)) store.note(clientId, ({apply: 'Apply', end: 'End deal', send: 'Send'}[action]) + ' failed. ' + (error.expose ? error.message : 'Please try again.'), now());
        if (error.expose) throw error;
        throw refuse('Stripe did not answer. Nothing changed.');
      }
      return json(res, 200, result);
    }
    if (['/api/clients/billing/send', '/api/clients/billing/days', '/api/clients/billing/stop'].includes(path)) {
      if (req.method !== 'POST') throw fail(405);
      const input = await readJson(req, 4 * 1024);
      onlyKeys(input, ['id', 'amount', 'days']);
      const {people} = await snapshot(false), person = people.find(p => p.id === input.id || p._rows.some(r => r.id === input.id));
      if (!person || person.sample) throw fail(404);
      const clientId = person._rows.map(r => r.id).find(id => billing.view(id));
      if (!clientId) throw refuse('Connect this client to a server first.');
      try {
        if (path.endsWith('/send')) await billing.send(clientId, input.amount);
        else if (path.endsWith('/days')) billing.giveDays(clientId, input.days);
        else await billing.stop(clientId);
      } catch (error) {
        if (error.expose) throw Object.assign(fail(error.status || 400, error.message), {expose: true});
        throw Object.assign(fail(502, 'Stripe did not answer. Nothing changed.'), {expose: true});
      }
      return json(res, 200, {ok: true});
    }
    if (!['/api/clients', '/api/clients/update', '/api/clients/log', '/api/clients/delete'].includes(path)) throw fail(404);
    if (req.method !== 'POST') throw fail(405);
    const input = await readJson(req, 16 * 1024);
    if (path === '/api/clients') {
      const value = validate(input, FIELDS);
      if (value.person_id) value.person_id = normalizePersonId(value.person_id);
      if (!value.name?.trim()) throw refuse('Add a name.');
      validateServer(value.server, await fleetSnapshot());
      let id;
      try { id = save(value, {now: now()}); } catch (error) { if (error.existing_id) return json(res, 409, {error: error.message, existing_id: error.existing_id}); throw error; }
      return json(res, 201, {ok: true, id});
    }
    const {id, ...patch} = input;
    if (typeof id !== 'string' || !id || id.length > 200) throw refuse('Choose a valid person.');
    if (id.startsWith('sample:')) throw refuse('Sample rows cannot be saved.');
    const {people, fleet} = await snapshot(false, true), person = people.find(p => p.id === id || p._rows.some(r => r.id === id));
    if (!person || person.sample) throw fail(404);
    if (path === '/api/clients/delete') {
      onlyKeys(input, ['id']);
      if (person._rows.some(r => deals.view(r.id).current)) throw refuse('End their deal before deleting this lead.');
      if (billingOf(person)?.connected) throw refuse('This client has a connected server. Stop billing and disconnect it first.');
      store.remove(person._rows.map(r => r.id));
    } else if (path === '/api/clients/log') {
      validate(input, ['id', 'text']);
      if (!patch.text?.trim()) throw refuse('Add a contact note.');
      store.log(savePerson(person, {}), patch.text.trim(), now(), riyadhDay(now()));
    } else {
      validate(input, ['id', ...(person.manual ? FIELDS : OVERLAY)]);
      validateServer(patch.server, fleet);
      if (person.manual && patch.name !== undefined && !patch.name.trim()) throw refuse('Add a name.');
      try { savePerson(person, patch); } catch (error) { if (error.existing_id) return json(res, 409, {error: error.message, existing_id: error.existing_id}); throw error; }
    }
    return json(res, 200, {ok: true});
  };
  routes.billing = billing;
  routes.deals = deals;
  deals.start();
  billing.start();
  return routes;
}
