const assert = require('node:assert/strict');
const { createEngine, STORAGE_KEY, fixtures } = require('../dist/demo-engine.js');
const makeStore = () => { const map=new Map();return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),map}; };
let ticks=0;const now=()=>new Date(Date.UTC(2026,9,1,0,0,ticks++)).toISOString();
function finish(e) { e.run();assert.equal(e.getState().status,'waiting_approval');assert.equal(e.step(),false);e.approve();e.run();assert.equal(e.getState().status,'retryable_failure');e.retry();e.run();assert.equal(e.getState().status,'completed'); }
const storage=makeStore();let e=createEngine({storage,now});
assert.equal(e.getState().status,'idle');assert.equal(e.approve(),false);assert.equal(e.retry(),false);
e.start();assert.equal(e.start(),false);e.step();assert.equal(e.getState().retrieval.length,2);assert.ok(e.getState().retrieval.every(x=>x.active&&x.tenantId===fixtures.tenantId));
e.step();e.pause();const paused=e.getState();assert.equal(e.step(),false);
e=createEngine({storage,now});assert.equal(e.getState().status,'paused');assert.deepEqual(e.getState(),paused);e.resume();finish(e);
const complete=e.getState();assert.equal(complete.memories.length,2);assert.equal(complete.memoryVersion,2);assert.equal(complete.conflict.resolved,true);assert.equal(complete.attempt,2);assert.equal(complete.checks.length,7);assert.ok(complete.checks.every(x=>x.pass));assert.equal(complete.mission.status,'awaiting_acceptance');assert.equal(complete.draft.sent,false);assert.ok(complete.events.every(x=>x.kind==='executed_local_fixture'&&x.model===null&&x.provider===null&&x.tokens===null&&x.cost.amount===0));
assert.equal(e.accept(),true);assert.equal(e.accept(),false);assert.equal(e.getState().customer.status,'open');assert.equal(e.getState().mission.status,'accepted');
const finalEventCount=e.getState().events.length;e.run();e.step();assert.equal(e.getState().events.length,finalEventCount);
storage.setItem('unrelated','keep');e.reset();assert.equal(storage.getItem(STORAGE_KEY),null);assert.equal(storage.getItem('unrelated'),'keep');assert.equal(e.getState().status,'idle');assert.equal(createEngine({storage}).getState().status,'idle');
e=createEngine({storage,now});e.start('missing_wiki');e.run();assert.equal(e.getState().status,'blocked');assert.equal(e.getState().retrieval.length,0);assert.equal(e.approve(),false);e.publishWiki();finish(e);assert.ok(e.getState().checks.every(x=>x.pass));
e=createEngine({now});e.start('bad_claim');finish(e);assert.equal(e.getState().checks.find(x=>x.id==='fact').pass,false);assert.equal(e.accept(),false);assert.equal(e.getState().mission.status,'awaiting_acceptance');
const blockedStore={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');},removeItem(){throw new Error('blocked');}};e=createEngine({storage:blockedStore,now});e.start();assert.equal(e.getPersistence().mode,'memory-only');assert.ok(e.getPersistence().warning);
const corrupt=makeStore();corrupt.setItem(STORAGE_KEY,'not-json');assert.equal(createEngine({storage:corrupt}).getState().status,'idle');
assert.equal(fixtures.historical.kind,'committed_report_excerpt');assert.equal(fixtures.historical.judge.costUsd,null);assert.equal(fixtures.historical.aggregate.groundedWikiEvidence,0);assert.equal(fixtures.historical.judge.finalVerdict,'needs_review');assert.ok(fixtures.historical.limitations.includes('没有完整原始事件 JSON'));
// Every checkpoint can restore without duplicated completed events, including approval and retry gates.
for(let checkpoint=0;checkpoint<9;checkpoint++){
 const store=makeStore();let run=createEngine({storage:store,now});run.start();for(let i=0;i<checkpoint;i++){if(run.getState().status==='waiting_approval')run.approve();if(run.getState().status==='retryable_failure')run.retry();run.step();}
 const before=run.getState();run=createEngine({storage:store,now});assert.deepEqual(run.getState(),before);
}
console.log('PASS: deterministic flow, tenant/source filtering, version conflict, pause/reload/resume, approval gate, idempotent retry, acceptance boundary, missing knowledge recovery, failing claims, terminal no-op, storage denial/corruption, reset isolation, historical provenance and checkpoint restoration. No model/service calls.');
