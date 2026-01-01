// Shared People list. Callers keep it only in memory and release it when their view closes.
(() => {
  MM.loadPeople = async () => (await MM.api('/api/fleet/people', {method: 'POST', body: {}})).people.people;
  MM.pickablePerson = p => !p.masked && !['You', 'ID not found'].includes(p.id) && /^(?:\+\d+|Telegram \d+|WhatsApp hidden \d+)$/.test(p.id);
  MM.personFields = p => ({name: p.name || p.id, phone: p.id, person_id: p.id, source: 'People', people_origin: p.servers?.includes('prod-01') ? 'public' : 'other', country: p.country || '', language: p.language || ''});
})();
