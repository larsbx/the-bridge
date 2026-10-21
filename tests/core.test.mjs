import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { Store, monthBounds, previousMonths } from '../src/db.mjs';
import { Plaid } from '../src/plaid.mjs';
import { keyFromHex, createSession, readSession, csrfToken, validateCsrf, passwordMatches, seal, unseal } from '../src/security.mjs';

const key = keyFromHex('ab'.repeat(32),'test key');
const otherKey = keyFromHex('cd'.repeat(32),'test key');
const mockTransaction = (id, amount, category='FOOD_AND_DRINK') => ({
  transaction_id:id,account_id:'account-1',date:'2026-10-20',name:'Coffee',
  amount,pending:false,iso_currency_code:'USD',personal_finance_category:{primary:category,detailed:'COFFEE'}
});
const testAccount = (id,type,current) => ({
  account_id:id,name:type+' account',mask:'1234',type,subtype:type==='credit'?'credit card':'checking',
  balances:{current,available:null,limit:null,iso_currency_code:'USD'}
});
function withStore(run) {
  const directory=mkdtempSync(join(tmpdir(),'the-bridge-'));
  const store=new Store(join(directory,'finance.sqlite'),key);
  try {return run(store);} finally {store.close();rmSync(directory,{recursive:true,force:true});}
}
test('session integrity, expiry, CSRF and encrypted tokens',()=>{
  const issued=Date.now();
  const session=createSession(key,issued);
  assert.equal(readSession(key,session,issued),true);
  assert.equal(readSession(key,session.slice(0,-1)+(session.endsWith('x')?'y':'x'),issued),false);
  assert.equal(readSession(key,session,issued+13*60*60*1000),false);
  assert.equal(validateCsrf(key,session,csrfToken(key,session)),true);
  assert.equal(validateCsrf(otherKey,session,csrfToken(key,session)),false);
  assert.equal(passwordMatches('a long valid password','a long valid password'),true);
  assert.equal(passwordMatches('incorrect','a long valid password'),false);
  const ciphertext=seal(key,'access-sandbox-secret');
  assert.equal(ciphertext.includes('access-sandbox-secret'),false);
  assert.equal(unseal(key,ciphertext),'access-sandbox-secret');
  assert.throws(()=>unseal(otherKey,ciphertext));
});
test('month boundaries and chart chronology cross year boundary',()=>{
  assert.deepEqual(monthBounds('2026-12'),['2026-12-01','2027-01-01']);
  assert.equal(previousMonths('2026-01',6)[0],'2025-08');
  assert.throws(()=>monthBounds('2026-13'));
});
test('atomic Plaid updates, removals, pending reconciliation and idempotency',()=>{
  withStore(store=>{
    store.saveItem('item-1','access-token','Demo Bank');
    store.saveAccounts('item-1',[testAccount('account-1','depository',1000),testAccount('account-2','credit',250)]);
    const pending={...mockTransaction('pending',5),pending:true};
    const posted={...mockTransaction('posted',12.34),pending_transaction_id:'pending'};
    const transfer=mockTransaction('xfer',100,'TRANSFER_OUT');
    store.commitSync('item-1',[{added:[pending,transfer],modified:[],removed:[]}],'cursor-1');
    assert.equal(store.item('item-1').cursor,'cursor-1');
    store.commitSync('item-1',[{added:[posted],modified:[],removed:[]}],'cursor-2');
    let snapshot=store.snapshot('2026-10');
    assert.equal(snapshot.transactions.some(tx=>tx.transaction_id==='pending'),false);
    assert.equal(snapshot.totals.spending_cents,1234);
    assert.equal(snapshot.totals.cash_cents,100000);
    assert.equal(snapshot.totals.card_debt_cents,25000);
    assert.equal(snapshot.totals.net_liquid_cents,75000);
    store.commitSync('item-1',[{added:[],modified:[{...posted,amount:13.25}],removed:[]}],'cursor-3');
    assert.equal(store.snapshot('2026-10').totals.spending_cents,1325);
    store.commitSync('item-1',[{added:[],modified:[{...posted,amount:13.25}],removed:[]}],'cursor-3');
    assert.equal(store.snapshot('2026-10').totals.spending_cents,1325);
    store.commitSync('item-1',[{added:[],modified:[],removed:[{transaction_id:'posted'}]}],'cursor-4');
    snapshot=store.snapshot('2026-10');
    assert.equal(snapshot.totals.spending_cents,0);
    assert.equal(snapshot.items[0].cursor,'cursor-4');
  });
});
test('failed update does not advance cursor or partially commit pages',()=>{
  withStore(store=>{
    store.saveItem('item-2','secret','Demo');
    assert.throws(()=>store.commitSync('item-2',[
      {added:[mockTransaction('success',6)]},
      {added:[{...mockTransaction('failure',7),account_id:null}]}
    ],'should-not-commit'));
    assert.equal(store.item('item-2').cursor,null);
    assert.equal(store.snapshot('2026-10').transactions.length,0);
  });
});
test('Plaid sync retries from ORIGINAL cursor after a pagination mutation',async()=>{
  const seen=[];
  let requests=0;
  const plaid=new Plaid({env:'sandbox',clientId:'test',secret:'test'});
  plaid.post=async (path,body)=>{
    seen.push(body.cursor);
    requests++;
    if (requests===1) return {added:[],modified:[],removed:[],next_cursor:'midpoint',has_more:true};
    if (requests===2) {
      const e=new Error('mutation');e.code='TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';throw e;
    }
    return {added:[mockTransaction('ok',1)],modified:[],removed:[],next_cursor:'final',has_more:false};
  };
  const result=await plaid.syncPages('token','original');
  assert.deepEqual(seen,['original','midpoint','original']);
  assert.equal(result.cursor,'final');
  assert.equal(result.pages.length,1);
});
test('Plaid signed webhook verifies body, signature, age and algorithm',async()=>{
  const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const keyJwk={...publicKey.export({format:'jwk'}),kid:'a-test-key',alg:'ES256',use:'sig',expired_at:null};
  const plaid=new Plaid({env:'sandbox',clientId:'test',secret:'test'});
  plaid.post=async()=>({key:keyJwk});
  const raw=Buffer.from('{"webhook_type":"TRANSACTIONS","item_id":"one"}');
  const now=Date.now();
  const header=Buffer.from(JSON.stringify({alg:'ES256',kid:keyJwk.kid,typ:'JWT'})).toString('base64url');
  const claims={iat:Math.floor(now/1000),request_body_sha256:createHash('sha256').update(raw).digest('hex')};
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input=header+'.'+payload;
  const signature=sign('sha256',Buffer.from(input),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const jwt=input+'.'+signature;
  assert.equal(await plaid.verifyWebhook(raw,jwt,now),true);
  assert.equal(await plaid.verifyWebhook(Buffer.from('tampered'),jwt,now),false);
  assert.equal(await plaid.verifyWebhook(raw,jwt,now+6*60*1000),false);
  assert.equal(await plaid.verifyWebhook(raw,'eyJhbGciOiJub25lIn0.'+payload+'.'+signature,now),false);
});
