const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {test,after}=require('node:test');
Object.assign(process.env,{DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'autotrade-charts-')),AI_PROVIDER:'ollama',AI_API_KEY:'test',HEADLESS:'1',BROKER:'alpaca'});
require('ts-node/register');
const {fitSeries,renderChart}=require('../src/ui/chart');
const {HeadlessUI}=require('../src/ui/headless');
const storage=require('../src/core/storage');
after(()=>storage.closeStorage());
const chart={kind:'price',label:'IBM',values:[232.76,227.21,225,220.56,219.45,219.45,225,222.78,221.67,221.67,220.56,219.45],dates:['2026-09-23','2026-09-24','2026-09-25','2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-05','2026-10-06','2026-10-07','2026-10-08']};
test('short series fill the TUI plot width while preserving observations and endpoints',()=>{
  const original=[...chart.values],fitted=fitSeries(chart.values,67);
  assert.equal(fitted.length,67);assert.equal(fitted[0],original[0]);assert.equal(fitted.at(-1),original.at(-1));
  for(const value of original)assert.ok(fitted.includes(value));
  assert.deepEqual(chart.values,original);
  for(const width of [40,80,120]){
    const rows=renderChart(chart,width).slice(1,-1);
    assert.equal(Math.max(...rows.map(row=>row.length)),width);
    assert.ok(rows.every(row=>row.length<=width));
  }
  const dense=fitSeries(Array.from({length:200},(_,i)=>i),40);
  assert.equal(dense.length,40);assert.equal(dense[0],0);assert.equal(dense.at(-1),199);
});
test('engine records and replays numeric chart payloads without preformatted graphics',()=>{
  const ui=new HeadlessUI();ui.showChart(chart);
  storage.closeStorage();
  const event=ui.feedAfter(0,10).find(entry=>entry.kind==='chart');
  assert.deepEqual(event.chart,chart);assert.equal(event.text,'IBM');
  assert.doesNotMatch(JSON.stringify(event),/[┼╮╯╰─┤]/);
  const comparison={kind:'comparison',a:{label:'IBM',values:[100,102,101]},b:{label:'SPY',values:[200,201,199]}};
  ui.showChart(comparison);
  assert.deepEqual(ui.feedAfter(event.seq,10)[0].chart,comparison);
  const rows=renderChart(comparison,80).filter(row=>/[┼┤]/.test(row));
  assert.ok(rows.length>0);assert.ok(rows.every(row=>row.length===80));
});
