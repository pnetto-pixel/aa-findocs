import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDividendPayments } from '../lib/dividend-reconciliation.js';
const api = (date,totalReceived=15,ticker='JPM') => ({date,totalReceived,ticker,source:'api',incomeType:'dividend'});
const broker = (date,totalReceived=15,ticker='JPM') => ({...api(date,totalReceived,ticker),source:'fidelity'});
test('weekend/month/year boundary duplicates prefer exact broker cash and date', () => {
 for (const [estimated,actual] of [['2026-10-31','2026-11-02'],['2026-11-02','2026-10-31'],['2026-12-31','2027-01-02']]) {
  const credit=broker(actual);const input=[api(estimated),credit];
  assert.deepEqual(reconcileDividendPayments(input), {events:[credit],matchedCount:1});assert.equal(input.length,2);
 }
});
test('different amounts, tickers, months far apart and taxes are preserved', () => {
 const input=[api('2026-10-31',20),api('2026-10-31',15,'XYZ'),api('2026-10-20'),{...api('2026-10-31'),incomeType:'tax'},broker('2026-11-02')];
 assert.deepEqual(reconcileDividendPayments(input),{events:input,matchedCount:0});
});
test('cent tolerance, combined account credits and one-to-one closest matching', () => {
 const credits=[broker('2026-11-02',10),broker('2026-11-02',5)];
 const input=[api('2026-10-30'),api('2026-10-31',15.01),...credits];
 const result=reconcileDividendPayments(input);assert.equal(result.matchedCount,1);assert.deepEqual(result.events,[input[0],...credits]);
 assert.equal(reconcileDividendPayments([api('2026-10-31',15.02),broker('2026-11-02')]).matchedCount,0);
});

mock.module('../lib/auth.js',{exports:{authenticate:async()=>({ok:true,storageKey:'test:holdings'})}});
const writes=[];
mock.module('../lib/redis.js',{exports:{getRedis:()=>({get:async key=>key==='dividends:paydates:v1:JPM'?JSON.stringify([{exDate:'2026-10-01',payDate:'2026-10-31'}]):null,set:async (...args)=>writes.push(args)})}});
const {default:handler}=await import('../api/dividends.js');
const originalFetch=globalThis.fetch;
after(()=>globalThis.fetch=originalFetch);
test('endpoint JPM 31-Oct / 2-Nov returns one actual credit; futures and unrelated past payouts survive', async () => {
 globalThis.fetch=async url=>{assert.match(url,/query2.finance.yahoo.com/);return {ok:true,json:async()=>({chart:{result:[{events:{dividends:{one:{date:Date.parse('2026-10-01T12:00:00Z')/1000,amount:1.5}}}}]}})}};
 const request=async(todayISO,bondIncome)=>{let status,body;await handler({method:'POST',body:{transactions:[{id:'buy',ticker:'JPM',side:'buy',date:'2020-01-01',qty:10,assetClass:'Stocks'}],bondIncome,todayISO}},{status(s){status=s;return this},json(b){body=b;return this}});assert.equal(status,200);return body};
 const income=[{kind:'dividend',date:'2026-11-02',ticker:'JPM',amount:15,source:'simplefin'}];
 const result=await request('2026-11-02',income);assert.equal(result.events.length,1);assert.equal(result.events[0].source,'fidelity');assert.equal(result.events[0].date,'2026-11-02');assert.equal(result.events[0].totalReceived,15);assert.equal(result.meta.crossMonthPaymentsReconciled,1);assert.match(writes.at(-1)[0],/:dividends:v13:/);
 const prior=await request('2026-10-31',income);assert.equal(prior.events.length,1);assert.equal(prior.events[0].date,'2026-10-31');assert.equal(prior.events[0].source,'api');
 const different=await request('2026-11-02',[{...income[0],amount:30}]);assert.equal(different.events.length,2);
});

test('shared client cache ignores old duplicated responses and refreshes all consumers', async () => {
 const originalStorage=globalThis.localStorage;
 const store=new Map();globalThis.localStorage={get length(){return store.size},key:i=>[...store.keys()][i],getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)};
 try {
  const {divCacheHash,getDivCacheEntry,fetchDividendsCached}=await import('../src/lib/dividendsCache.js');
  const transactions=[],bondIncome=[],day='2026-11-02';const hash=divCacheHash({transactions,bondIncome,day});
  store.set('divCache:v1:'+hash,JSON.stringify({cachedAt:day,data:{events:[api('2026-10-31'),broker(day)]}}));
  assert.equal(getDivCacheEntry(hash),null);
  globalThis.fetch=async()=>({ok:true,json:async()=>({events:[broker(day)]})});
  const result=fetchDividendsCached({auth:{},transactions,bondIncome,todayISO:day});assert.equal(result.cached,null);
  assert.equal((await result.fresh).events.length,1);assert.equal(getDivCacheEntry(hash).events.length,1);assert.ok(store.has('divCache:v2:'+hash));
 } finally { if(originalStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=originalStorage; }
});
