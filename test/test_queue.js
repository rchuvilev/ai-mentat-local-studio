'use strict';
// Unit tests for ai/queue.js — the overnight prompt queue.
//
// The design note is explicit: it runs unattended overnight, an error must
// skip to the next item rather than halt the batch, and a crash must resume
// rather than restart. Those three are exactly what these tests pin.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Queue, STATES } = require('../ai/queue');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ls-queue-'));
}

/** Minimal runner stub — records calls and can be told to fail on cue. */
function makeRunner(behaviour = () => ({ ok: true })) {
  const calls = [];
  return {
    calls,
    async run(item) {
      calls.push(item.prompt);
      const r = behaviour(item, calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function makeQueue(runner, root = tmpRoot()) {
  return new Queue({ storage: { root }, runner });
}

// ── shape ──────────────────────────────────────────────────────────────────

test('every state in STATES is represented in the snapshot counts', () => {
  // The UI renders these counters; a missing key shows as "undefined".
  const q = makeQueue(makeRunner());
  const counts = q.snapshot().counts;
  for (const s of STATES) {
    assert.strictEqual(typeof counts[s], 'number', `counts.${s} missing`);
  }
});

test('a new queue starts empty rather than throwing on a missing file', () => {
  const q = makeQueue(makeRunner());
  assert.deepStrictEqual(q.items, []);
});

// ── persistence and crash resume ───────────────────────────────────────────

test('items survive a reload — an overnight run must not lose its batch', () => {
  const root = tmpRoot();
  const q1 = makeQueue(makeRunner(), root);
  q1.add('first');
  q1.add('second');
  const q2 = makeQueue(makeRunner(), root);
  assert.strictEqual(q2.items.length, 2, 'reload must see persisted items');
  assert.strictEqual(q2.items[0].prompt, 'first');
});

test('an item left "running" by a crash is retried, not silently dropped', () => {
  // This is the crash-resume requirement. Leaving it as `running` would strand
  // it forever: nothing picks up a running item on restart.
  const root = tmpRoot();
  const q1 = makeQueue(makeRunner(), root);
  q1.add('interrupted');
  q1.items[0].state = 'running';
  q1.persist();

  const q2 = makeQueue(makeRunner(), root);
  assert.strictEqual(q2.items[0].state, 'pending', 'must be reset to pending');
});

test('a corrupt queue file yields an empty queue instead of crashing the app', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'queue.json'), '{ not json');
  assert.doesNotThrow(() => makeQueue(makeRunner(), root));
  assert.deepStrictEqual(makeQueue(makeRunner(), root).items, []);
});

test('a non-array queue file is rejected, not trusted', () => {
  // JSON.parse succeeds on `{"a":1}`; iterating it later would throw far from
  // the cause.
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, 'queue.json'), '{"not":"an array"}');
  assert.deepStrictEqual(makeQueue(makeRunner(), root).items, []);
});

// ── listeners ──────────────────────────────────────────────────────────────

test('a throwing listener does not break the queue', () => {
  // The UI subscribes here. A render error must not stop an unattended batch.
  const q = makeQueue(makeRunner());
  q.onChange(() => { throw new Error('listener exploded'); });
  let reached = false;
  q.onChange(() => { reached = true; });
  assert.doesNotThrow(() => q.emit());
  assert.ok(reached, 'a later listener must still be called');
});

test('onChange returns a working unsubscribe', () => {
  const q = makeQueue(makeRunner());
  let hits = 0;
  const off = q.onChange(() => { hits++; });
  q.emit();
  off();
  q.emit();
  assert.strictEqual(hits, 1, 'unsubscribed listener must not fire again');
});

// ── snapshot integrity ─────────────────────────────────────────────────────

test('snapshot counts match the actual items', () => {
  const q = makeQueue(makeRunner());
  q.add('a'); q.add('b'); q.add('c');
  q.items[0].state = 'done';
  q.items[1].state = 'failed';
  const c = q.snapshot().counts;
  assert.strictEqual(c.pending, 1);
  assert.strictEqual(c.done, 1);
  assert.strictEqual(c.failed, 1);
});

// ── suppressed errors are tracked, not silent ──────────────────────────────

test('a throwing listener is RECORDED, not swallowed', () => {
  // Resilience without a trace is undebuggable: the batch survives, but
  // nobody can find out why the UI stopped updating.
  const { recentQueueErrors } = require('../ai/queue');
  const before = recentQueueErrors().length;
  const q = makeQueue(makeRunner());
  q.onChange(() => { throw new Error('render failed'); });
  q.emit();
  const after = recentQueueErrors();
  assert.strictEqual(after.length, before + 1, 'the failure must be recorded');
  assert.strictEqual(after[after.length - 1].op, 'queue.listener');
  assert.strictEqual(after[after.length - 1].message, 'render failed');
});

test('the error buffer is bounded', () => {
  // This runs unattended for hours; an unbounded buffer is a slow leak.
  const { recentQueueErrors } = require('../ai/queue');
  const q = makeQueue(makeRunner());
  q.onChange(() => { throw new Error('boom'); });
  for (let i = 0; i < 80; i++) q.emit();
  assert.ok(recentQueueErrors().length <= 50, 'must cap at 50 entries');
});
