'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var M = require('../lib/mandate.js');
var C = require('../lib/catalog.js');

var NOW = Date.UTC(2026, 10, 12, 15, 0, 0);
var product = C.PRODUCTS.filter(function (p) { return p.id === 'tt-mod-home'; })[0];

function setup() {
  var quote = C.quoteFor(product, { now: NOW });
  var approval = M.createApproval(quote, { now: NOW, budgetCents: 4000 });
  var mandate = M.issueMandate(approval, { now: NOW });
  var good = { amountCents: approval.totalCents, currency: 'USD', merchantId: quote.merchant.id, fingerprint: approval.fingerprint };
  return { quote: quote, approval: approval, mandate: mandate, good: good };
}

test('money is whole cents and totals add up', function () {
  var s = setup();
  assert.equal(s.quote.itemCents, 2595);
  assert.equal(M.quoteTotalCents(s.quote), s.quote.itemCents + s.quote.shippingCents + s.quote.taxCents);
  assert.equal(s.mandate.limitCents, s.approval.totalCents);
  assert.throws(function () { M.quoteTotalCents({ itemCents: 10.5, shippingCents: 0, taxCents: 0 }); });
});

test('exact approved charge is allowed', function () {
  var s = setup();
  var d = M.checkCharge(s.mandate, s.good, { now: NOW + 1000 });
  assert.equal(d.allowed, true);
  assert.equal(d.reason, M.REASONS.OK);
});

test('a smaller charge at the same store and terms is allowed', function () {
  var s = setup();
  var d = M.checkCharge(s.mandate, Object.assign({}, s.good, { amountCents: s.good.amountCents - 1 }), { now: NOW });
  assert.equal(d.allowed, true);
});

test('over-limit charge is blocked, even by one cent', function () {
  var s = setup();
  var d = M.checkCharge(s.mandate, Object.assign({}, s.good, { amountCents: s.good.amountCents + 1 }), { now: NOW });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, M.REASONS.OVER_LIMIT);
  assert.match(d.plain, /more than you approved/);
});

test('wrong merchant is blocked', function () {
  var s = setup();
  var d = M.checkCharge(s.mandate, Object.assign({}, s.good, { merchantId: C.MERCHANTS.amazon.id }), { now: NOW });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, M.REASONS.WRONG_MERCHANT);
});

test('wrong merchant is blocked even when the amount is also too high (merchant checked first)', function () {
  var s = setup();
  var d = M.checkCharge(s.mandate, Object.assign({}, s.good, { merchantId: 'm_evil', amountCents: 999999 }), { now: NOW });
  assert.equal(d.reason, M.REASONS.WRONG_MERCHANT);
});

test('wrong currency is blocked', function () {
  var s = setup();
  var d = M.checkCharge(s.mandate, Object.assign({}, s.good, { currency: 'EUR' }), { now: NOW });
  assert.equal(d.reason, M.REASONS.WRONG_CURRENCY);
});

test('terms change forces re-approval: price increase', function () {
  var s = setup();
  var fresh = C.quoteFor(product, { now: NOW, itemCents: product.priceCents + 200 });
  var diff = M.compareQuote(s.approval, fresh);
  assert.equal(diff.requiresReapproval, true);
  assert.ok(diff.changes.some(function (c) { return c.field === 'totalCents' && c.needsApproval; }));
  // and the old mandate cannot pay the new deal, even with a matching amount
  var d = M.checkCharge(s.mandate, { amountCents: s.approval.totalCents, currency: 'USD', merchantId: fresh.merchant.id, fingerprint: M.termsFingerprint(fresh) }, { now: NOW });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, M.REASONS.TERMS_CHANGED);
});

test('terms change forces re-approval: shorter return window, same price', function () {
  var s = setup();
  var fresh = C.quoteFor(product, { now: NOW, returnDays: 14 });
  assert.equal(M.quoteTotalCents(fresh), s.approval.totalCents);
  var diff = M.compareQuote(s.approval, fresh);
  assert.equal(diff.requiresReapproval, true);
  assert.equal(diff.changes[0].field, 'returnDays');
  var d = M.checkCharge(s.mandate, { amountCents: s.approval.totalCents, currency: 'USD', merchantId: fresh.merchant.id, fingerprint: M.termsFingerprint(fresh) }, { now: NOW });
  assert.equal(d.reason, M.REASONS.TERMS_CHANGED);
});

test('terms change forces re-approval: later delivery', function () {
  var s = setup();
  var fresh = C.quoteFor(product, { now: NOW, deliveryDays: 12 });
  assert.equal(M.compareQuote(s.approval, fresh).requiresReapproval, true);
});

test('price drop is reported but does not force re-approval', function () {
  var s = setup();
  var fresh = C.quoteFor(product, { now: NOW, itemCents: product.priceCents - 300 });
  var diff = M.compareQuote(s.approval, fresh);
  assert.equal(diff.same, false);
  assert.equal(diff.requiresReapproval, false);
  assert.match(diff.changes[0].plain, /You pay less/);
});

test('unchanged quote needs nothing', function () {
  var s = setup();
  var diff = M.compareQuote(s.approval, C.quoteFor(product, { now: NOW }));
  assert.equal(diff.same, true);
  assert.equal(diff.requiresReapproval, false);
});

test('re-approval issues a new mandate that pays the new total', function () {
  var s = setup();
  var fresh = C.quoteFor(product, { now: NOW, itemCents: product.priceCents + 200 });
  var a2 = M.createApproval(fresh, { now: NOW, budgetCents: 4000 });
  var m2 = M.issueMandate(a2, { now: NOW });
  var d = M.checkCharge(m2, { amountCents: a2.totalCents, currency: 'USD', merchantId: fresh.merchant.id, fingerprint: M.termsFingerprint(fresh) }, { now: NOW });
  assert.equal(d.allowed, true);
});

test('single use: second charge is blocked', function () {
  var s = setup();
  var d = M.checkCharge(s.mandate, s.good, { now: NOW });
  var used = M.recordUse(s.mandate, d);
  assert.equal(used.status, 'USED');
  assert.equal(M.checkCharge(used, s.good, { now: NOW }).reason, M.REASONS.ALREADY_USED);
  assert.equal(s.mandate.status, 'ACTIVE', 'recordUse must not mutate the original');
});

test('expired and revoked mandates are blocked', function () {
  var s = setup();
  assert.equal(M.checkCharge(s.mandate, s.good, { now: s.mandate.expiresAt + 1 }).reason, M.REASONS.EXPIRED);
  assert.equal(M.checkCharge(M.revoke(s.mandate), s.good, { now: NOW }).reason, M.REASONS.NOT_ACTIVE);
});

test('invalid amounts are blocked', function () {
  var s = setup();
  [0, -100, 12.5, NaN].forEach(function (amt) {
    assert.equal(M.checkCharge(s.mandate, Object.assign({}, s.good, { amountCents: amt }), { now: NOW }).reason, M.REASONS.INVALID_AMOUNT);
  });
});

test('approval refuses a total over the person\'s budget', function () {
  var expensive = C.PRODUCTS.filter(function (p) { return p.id === 'tt-original-8'; })[0];
  assert.throws(function () { M.createApproval(C.quoteFor(expensive, { now: NOW }), { now: NOW, budgetCents: 4000 }); }, /over the budget/);
});

test('fingerprint is stable regardless of key order', function () {
  assert.equal(M._canonical({ b: 1, a: { d: 2, c: 3 } }), M._canonical({ a: { c: 3, d: 2 }, b: 1 }));
});
