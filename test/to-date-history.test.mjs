import assert from 'node:assert/strict';
import { shiftCalendarMonths } from '../src/lib/periodComparison.js';
import { buildContributionHistory } from '../src/lib/contributionHistory.js';
import { buildAccumulatedInvestment } from '../src/lib/accumulatedInvestment.js';
const buy=(date,price,extra={})=>({date,price,qty:1,side:'buy',ticker:'VTI',currency:'USD',...extra});
const approx=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
assert.equal(shiftCalendarMonths('2024-02-29',-12),'2023-02-28');
assert.equal(shiftCalendarMonths('2026-05-31',-3),'2026-02-28');
assert.equal(shiftCalendarMonths('2026-01-31',-6),'2025-07-31');
for (const [groupBy,previousDate,afterPrevious] of [
 ['Quarter','2026-07-20','2026-08-01'],
 ['Half','2026-04-20','2026-05-01'],
 ['Year','2025-10-20','2025-11-01'],
]) {
 const tx=[buy('2024-01-01',100),buy('2025-10-20',100),buy('2025-11-01',900),
   buy(previousDate,200),buy(afterPrevious,800),buy('2026-10-20',400),buy('2026-11-01',9999)];
 const contribution=buildContributionHistory(tx,5,groupBy,'','','2026-10-30').at(-1);
 const accumulated=buildAccumulatedInvestment(tx,5,{groupBy,today:'2026-10-30'}).at(-1);
 const sumUntil=date=>tx.filter(t=>t.date<=date).reduce((s,t)=>s+t.price,0);
 const priorYear=groupBy==='Year'?300:100;
 const currentContribution=tx.filter(t=>t.date>=(groupBy==='Year'?'2026-01-01':groupBy==='Half'?'2026-07-01':'2026-10-01')&&t.date<='2026-10-30').reduce((s,t)=>s+t.price,0);
 approx(contribution.yoy,(currentContribution/priorYear-1)*100);
 approx(accumulated.yoy,(sumUntil('2026-10-30')/sumUntil('2025-10-30')-1)*100);
 if(groupBy!=='Year') {
   approx(contribution.previous,100); // 400 vs 200, excludes later 800
   approx(accumulated.previous,(sumUntil('2026-10-30')/sumUntil(groupBy==='Half'?'2026-04-30':'2026-07-30')-1)*100);
 } else assert.equal(contribution.previous,null);
 const filtered=buildContributionHistory(tx,5,groupBy,'2026-10-01','2026-10-30','2026-10-30').at(-1);
 approx(filtered.yoy,(400/priorYear-1)*100);
}
// Partial reference balance must not include a bond redemption after cutoff.
const bonds=[buy('2025-10-01',1000,{assetClass:'Bank Bonds'}),buy('2025-10-31',1000,{assetClass:'Bank Bonds',side:'sell'}),buy('2026-10-01',2000)];
for(const builder of [
 tx=>buildContributionHistory(tx,5,'Quarter','','','2026-10-30'),
 tx=>buildAccumulatedInvestment(tx,5,{groupBy:'Quarter',today:'2026-10-30'}),
]) approx(builder(bonds).at(-1).yoy,100);
console.log('To-date rates: QTD/HTD/YTD, both charts, filters, future exclusion, bond cutoff and leap/month-end clamping passed');
