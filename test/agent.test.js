'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var A = require('../lib/agent.js');
var C = require('../lib/catalog.js');

var NOW = Date.UTC(2026, 10, 12, 15, 0, 0);

test('parses budget, timing, quiet and returns from plain words', function () {
  var n = A.parseNeed('I need a visual timer to help me stay on task. Under $40, here within 7 days, quiet, easy returns.');
  assert.equal(n.budgetCents, 4000);
  assert.equal(n.withinDays, 7);
  assert.equal(n.quiet, true);
  assert.equal(n.easyReturns, true);
  assert.equal(n.category, 'visual-timer');
  assert.equal(A.parseNeed('timer under $25.50 in a week').budgetCents, 2550);
  assert.equal(A.parseNeed('timer under $25.50 in a week').withinDays, 7);
});

test('shortlist drops over-budget items and explains why', function () {
  var log = new A.AuditLog(function () { return NOW; });
  var r = A.buildShortlist(A.parseNeed('visual timer under $40, quiet, easy returns'), { now: NOW, log: log });
  assert.ok(r.shortlist.length <= 3 && r.shortlist.length > 0);
  var ex = r.excluded.map(function (x) { return x.product.id; });
  assert.ok(ex.indexOf('tt-original-8') >= 0);
  assert.match(r.excluded[0].excludedBecause, /over your/);
  assert.equal(log.entries[0].kind, 'ACTION');
});

test('quiet + easy returns ranks the 12-month-return, no-ticking timer first', function () {
  var r = A.buildShortlist(A.parseNeed('visual timer under $40, quiet, easy returns'), { now: NOW });
  assert.equal(r.shortlist[0].product.id, 'tt-mod-home');
});

test('every shortlisted item carries a source and evidence links', function () {
  var r = A.buildShortlist(A.parseNeed('visual timer under $40'), { now: NOW });
  r.shortlist.forEach(function (row) {
    assert.match(row.product.source, /^https:\/\//);
    assert.ok(row.product.evidence.length > 0);
    row.product.evidence.forEach(function (e) { assert.match(e.url, /^https:\/\//); });
  });
});

test('delivery deadline filters slow items', function () {
  var r = A.buildShortlist(A.parseNeed('visual timer under $40 within 3 days'), { now: NOW });
  r.shortlist.forEach(function (row) { assert.ok(row.product.deliveryDays <= 3); });
});

test('plain-language comparison is short sentences', function () {
  var r = A.buildShortlist(A.parseNeed('visual timer under $40, quiet, easy returns'), { now: NOW });
  var lines = A.compareInPlainWords(r.shortlist);
  assert.ok(lines.length >= 2 && lines.length <= 4);
  lines.forEach(function (l) { assert.ok(l.length < 140, l); });
});

test('catalog quotes are whole cents', function () {
  C.PRODUCTS.forEach(function (p) {
    var q = C.quoteFor(p, { now: NOW });
    [q.itemCents, q.shippingCents, q.taxCents].forEach(function (n) { assert.equal(Math.floor(n), n); });
  });
});
