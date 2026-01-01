#!/usr/bin/python3 -B
import datetime, json, sqlite3, sys

try:
    db = sqlite3.connect('file:/var/lib/mastan-public/me.sqlite?mode=ro', uri=True)
    db.execute('PRAGMA query_only=ON')
    user_columns = {c[0] for c in db.execute('SELECT * FROM users LIMIT 0').description}
    plan_table = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='public_plans'").fetchone()
    plan_columns = {c[0] for c in db.execute('SELECT * FROM public_plans LIMIT 0').description} if plan_table else set()
    free_clause = 'COALESCE(u.free_forever,0)=1' if 'free_forever' in user_columns else '0'
    if 'free_forever' in plan_columns:
        free_clause += ' OR EXISTS(SELECT 1 FROM public_plans p WHERE p.user_id=u.user_id AND p.free_forever=1)'
    # An Order button tap with no answers yet still belongs on the list. The table appears with the first tap.
    has_intents = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='public_order_intents'").fetchone()
    intent_clause = 'OR EXISTS(SELECT 1 FROM public_order_intents o WHERE o.user_id=u.user_id)' if has_intents else ''
    intent_rows = """UNION ALL SELECT o.user_id,o.plan,'Tapped Order, no details yet',NULL,'','',o.created_at,NULL FROM public_order_intents o
          WHERE NOT EXISTS(SELECT 1 FROM public_private_requests p WHERE p.user_id=o.user_id)""" if has_intents else ''
    # Cash payers have no Stripe customer; the first logged cash start is when they began paying.
    has_cash_log = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='public_cash_log'").fetchone()
    cash_since = "(SELECT min(l.at) FROM public_cash_log l WHERE l.user_id=b.user_id AND l.event='started')" if has_cash_log else 'NULL'
    billing_columns = {c[0] for c in db.execute('SELECT * FROM public_billing LIMIT 0').description}
    cash_flag = "CASE WHEN b.subscription_id LIKE 'cash\\_%' ESCAPE '\\' THEN 1 ELSE 0 END" if 'subscription_id' in billing_columns else '0'
    cancel_flag = 'COALESCE(b.cancel_at_period_end,0)' if 'cancel_at_period_end' in billing_columns else '0'
    cutoff = int((datetime.datetime.now(datetime.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) - datetime.timedelta(days=399)).timestamp() * 1000)
    query = f"""
    WITH eligible AS (
      SELECT u.user_id FROM users u WHERE COALESCE(u.is_test,0)=0 AND COALESCE(u.minor,0)=0
        AND ({free_clause} OR EXISTS(SELECT 1 FROM public_billing b WHERE b.user_id=u.user_id)
          OR EXISTS(SELECT 1 FROM public_private_requests r WHERE r.user_id=u.user_id) {intent_clause})
    ), daily AS (
      SELECT c.user_id, strftime('%Y-%m-%d',c.created_at/1000,'unixepoch') AS day, sum(c.micros) AS micros
      FROM public_costs c JOIN eligible e ON e.user_id=c.user_id WHERE c.created_at>=?
      GROUP BY c.user_id, day
    )
    SELECT json_object('version',1,
      'private_requests',json((SELECT json_group_array(json_object(
        'user_id',r.user_id,'plan',r.plan,'business',r.business,'people',r.people,'identity',r.identity,
        'language',r.language,'requested_at',r.requested_at,'ready_at',r.ready_at,
        'contact',json((SELECT json_object('channel',i.channel,'address_digits',i.address_digits)
          FROM identities i WHERE i.user_id=r.user_id ORDER BY i.created_at DESC LIMIT 1))))
        FROM (SELECT user_id,plan,business,people,identity,language,requested_at,ready_at FROM public_private_requests
          {intent_rows}) r JOIN eligible e ON e.user_id=r.user_id)),
      'billing',json((SELECT json_group_array(json_object(
        'user_id',b.user_id,'customer_id',b.customer_id,'plan',b.plan,'status',b.status,
        'period_start',b.period_start,'period_end',b.period_end,'payment_problem',b.payment_problem,
        'cash',{cash_flag},'cancelling',{cancel_flag},
        'cash_since',{cash_since},
        'period_micros',(SELECT COALESCE(sum(c.micros),0) FROM public_costs c
          WHERE c.user_id=b.user_id AND c.created_at>=b.period_start AND c.created_at<b.period_end)))
        FROM public_billing b JOIN eligible e ON e.user_id=b.user_id)),
      'costs',json((SELECT json_group_array(json_object('user_id',user_id,'day',day,'micros',micros)) FROM daily)))
    """
    feed = json.loads(db.execute(query, (cutoff,)).fetchone()[0])
    fields = ['user_id', 'status', 'minor', 'plan', 'source', 'free_forever', 'language']
    selected = ','.join(k for k in fields if k in user_columns)
    users = db.execute('SELECT ' + selected + ' FROM users WHERE COALESCE(is_test,0)=0')
    columns = [c[0] for c in users.description]
    accounts = [dict(zip(columns, r)) for r in users.fetchall()]
    plan_rows = {}
    if plan_columns:
        selected_plans = ','.join(k for k in fields if k in plan_columns)
        cursor = db.execute('SELECT ' + selected_plans + ' FROM public_plans')
        names = [c[0] for c in cursor.description]
        plan_rows = {r['user_id']: r for r in (dict(zip(names, row)) for row in cursor.fetchall())}
    identity_columns = {c[0] for c in db.execute('SELECT * FROM identities LIMIT 0').description}
    identity_fields = 'channel,kind,address_digits' if 'kind' in identity_columns else "channel,'pn',address_digits"
    for account in accounts:
        plan = plan_rows.get(account['user_id'], {})
        for field in ['plan', 'source', 'free_forever']:
            account[field] = plan.get(field, account.get(field))
        account['minor'] = bool(account.get('minor'))
        account['free_forever'] = bool(account.get('free_forever'))
        for field in fields:
            account.setdefault(field, None)
        account['identities'] = [dict(zip(['channel', 'kind', 'address_digits'], row)) for row in db.execute('SELECT ' + identity_fields + ' FROM identities WHERE user_id=?', (account['user_id'],))]
    feed['accounts'] = accounts
    db.close()
    feed['generated_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    print(json.dumps(feed, ensure_ascii=False, separators=(',',':')))
except Exception as error:
    print(type(error).__name__, file=sys.stderr)
    sys.exit(1)
