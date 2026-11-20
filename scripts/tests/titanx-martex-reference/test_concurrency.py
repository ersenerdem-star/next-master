#!/usr/bin/env python3
"""True two-connection race on disposable Docker PostgreSQL only."""
import json, subprocess, time, secrets, os

container=os.environ.get('TITANX_TEST_CONTAINER','')
if not container.startswith('codex-titanx-ref-test-'):
    raise SystemExit('TITANX_TEST_CONTAINER must identify an isolated codex-titanx-ref-test-* container')
base=['docker','exec',container,'psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-U','postgres','-d','titanx_test']
def sql(q):
    return subprocess.run(base+['-c',q],capture_output=True,text=True,check=True).stdout.strip()

sql("update public.catalog_external_sources set is_active=true")
sql("update public.catalog_products set oem_no=null,vehicle=null where product_code='BL119001'")
data={'organization_id':'11111111-1111-4111-8111-111111111111','brand_id':'22222222-2222-4222-8222-222222222222',
 'product_code':'BL119001','source_url':'https://sklep.martextruck.pl/partscatalogue/example.aspx','source_sha256':secrets.token_hex(32),
 'observed_at':'2026-11-20T11:52:00Z','source_description_pl':'SILNIK DMUCHAWY MB ACTROS',
 'observed_references':[{'manufacturer':'MB','code':'0018308708'}], 'selected_oem':[{'manufacturer':'MB','code':'0018308708'}],
 'selected_vehicles':['MB ACTROS'],'evidence':{'primary_brand':'TITANX','primary_code':'BL119001','collector_html_sha256_verified':True}}
payload=json.dumps(data).replace("'","''")
obs=sql("set request.jwt.claim.role='service_role'; select public.stage_martex_reference_v2('"+payload+"'::jsonb)->>'id'")
assert len(obs)==36, obs
q="set application_name='titanx_race_writer'; begin; update public.catalog_products set oem_no='EXISTING 000',vehicle='Existing vehicle' where product_code='BL119001'; select pg_sleep(5); commit;"
proc=subprocess.Popen(base+['-c',q],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
    for _ in range(60):
        if sql("select count(*) from pg_stat_activity where application_name='titanx_race_writer' and wait_event='PgSleep'")=='1': break
        time.sleep(.05)
    else: raise AssertionError('writer never locked product')
    before=time.monotonic()
    result=json.loads(sql("set request.jwt.claim.role='service_role'; select public.apply_martex_reference_v2('"+obs+"'::uuid)::text"))
    waited=time.monotonic()-before
    assert waited>=1.0, f'expected lock wait, observed {waited:.2f}s'
    assert result['outcomes']['oem_no']=='existing_preserved',result
    assert result['outcomes']['vehicle']=='existing_preserved',result
    assert result['after']['oem_no']=='EXISTING 000' and result['after']['vehicle']=='Existing vehicle',result
    assert sql("select count(*) from public.catalog_product_identifiers where catalog_product_id='33333333-3333-4333-8333-333333333333' and source_record_id is not null")=='2'
    assert sql("select buy_price from public.supplier_prices")=='12'
    print(f'PASS: two real sessions, apply waited {waited:.2f}s for row lock, concurrent values and price preserved')
finally:
    try: proc.communicate(timeout=10)
    except subprocess.TimeoutExpired: proc.kill()

# Two workers process the same fresh observation concurrently; the second must
# wait on the observation lock and then reuse the first completed event.
data['source_sha256']=secrets.token_hex(32)
payload=json.dumps(data).replace("'","''")
obs=sql("set request.jwt.claim.role='service_role'; select public.stage_martex_reference_v2('"+payload+"'::jsonb)->>'id'")
q="set application_name='titanx_race_apply'; set request.jwt.claim.role='service_role'; begin; select public.apply_martex_reference_v2('"+obs+"'::uuid); select pg_sleep(5); commit;"
proc=subprocess.Popen(base+['-c',q],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
    for _ in range(60):
        if sql("select count(*) from pg_stat_activity where application_name='titanx_race_apply' and wait_event='PgSleep'")=='1': break
        time.sleep(.05)
    else: raise AssertionError('first apply never locked observation')
    before=time.monotonic()
    result=json.loads(sql("set request.jwt.claim.role='service_role'; select public.apply_martex_reference_v2('"+obs+"'::uuid)::text"))
    waited=time.monotonic()-before
    assert waited>=1.0 and result['status']=='already_processed',(waited,result)
    assert sql("select count(*) from public.catalog_martex_reference_events_v2 where observation_id='"+obs+"'::uuid")=='1'
    print(f'PASS: duplicate workers waited {waited:.2f}s, one event was committed')
finally:
    try: proc.communicate(timeout=10)
    except subprocess.TimeoutExpired: proc.kill()
