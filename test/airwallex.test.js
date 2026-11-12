'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var M = require('../lib/mandate.js');
var C = require('../lib/catalog.js');
var AWX = require('../lib/airwallex.js');

var NOW = Date.now();
var product = C.PRODUCTS[0];

function fixture() {
  var q = C.quoteFor(product, { now: NOW });
  var a = M.createApproval(q, { now: NOW });
  var m = M.issueMandate(a, { now: NOW });
  var charge = { amountCents: a.totalCents, currency: 'USD', merchantId: m.merchant.id, mcc: m.merchant.mcc, merchantName: m.merchant.name, fingerprint: a.fingerprint };
  return { q: q, a: a, m: m, charge: charge };
}

test('defaults to SANDBOX-MOCK with no credentials', function () {
  assert.equal(AWX.createAdapter({ env: {} }).mode, 'SANDBOX-MOCK');
  assert.equal(AWX.createAdapter({ env: { AIRWALLEX_CLIENT_ID: 'x' } }).mode, 'SANDBOX-MOCK');
  assert.equal(AWX.createAdapter({ env: { AIRWALLEX_CLIENT_ID: 'x', AIRWALLEX_API_KEY: 'y', AIRWALLEX_CARDHOLDER_ID: 'z', ACCESSOS_MODE: 'mock' } }).mode, 'SANDBOX-MOCK');
});

test('switches to SANDBOX when both env vars are set', function () {
  var ad = AWX.createAdapter({ env: { AIRWALLEX_CLIENT_ID: 'x', AIRWALLEX_API_KEY: 'y', AIRWALLEX_CARDHOLDER_ID: 'z' }, fetch: function () {} });
  assert.equal(ad.mode, 'SANDBOX');
});

test('refuses production hosts', function () {
  assert.throws(function () {
    AWX.createAdapter({ env: { AIRWALLEX_CLIENT_ID: 'x', AIRWALLEX_API_KEY: 'y', AIRWALLEX_CARDHOLDER_ID: 'z', AIRWALLEX_BASE_URL: 'https://api.airwallex.com' }, fetch: function () {} });
  }, /sandbox/);
});

test('card request binds limit, single use, currency, MCC and expiry', function () {
  var f = fixture();
  var req = AWX.buildCardRequest(f.m, { cardholderId: 'ch_1' });
  var c = req.authorization_controls;
  assert.equal(c.allowed_transaction_count, 'SINGLE');
  assert.deepEqual(c.allowed_currencies, ['USD']);
  assert.deepEqual(c.allowed_merchant_categories, [f.m.merchant.mcc]);
  assert.equal(c.transaction_limits.currency, 'USD');
  assert.deepEqual(c.transaction_limits.limits[0], { amount: f.m.limitCents / 100, interval: 'PER_TRANSACTION' });
  assert.match(c.active_to, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0000$/);
  assert.equal(req.form_factor, 'VIRTUAL');
  assert.equal(req.metadata.mandate_id, f.m.id);
});

test('mock: approved charge pays, then the card closes', async function () {
  var f = fixture();
  var ad = AWX.createMockAdapter();
  var card = await ad.createMandateCard(f.m);
  var r = await ad.authorize(card, f.m, f.charge);
  assert.equal(r.approved, true);
  var rep = await ad.reportResult(card, r);
  assert.equal(rep.cardStatus, 'CLOSED');
  assert.equal(rep.receipt.status, 'PAID');
});

test('mock: over-limit is stopped by AccessOS before reaching the network', async function () {
  var f = fixture();
  var ad = AWX.createMockAdapter();
  var card = await ad.createMandateCard(f.m);
  var r = await ad.authorize(card, f.m, Object.assign({}, f.charge, { amountCents: f.charge.amountCents + 1 }));
  assert.equal(r.approved, false);
  assert.equal(r.reason, 'OVER_LIMIT');
  assert.equal(r.network, 'NOT_SENT');
});

test('mock: the card itself also declines over-limit, wrong MCC and reuse (defense in depth)', async function () {
  var f = fixture();
  var ad = AWX.createMockAdapter();
  var card = await ad.createMandateCard(f.m);
  var over = await ad.networkCharge(card, { amountCents: f.m.limitCents + 100, currency: 'USD', mcc: f.m.merchant.mcc, merchantId: f.m.merchant.id });
  assert.equal(over.failure_reason, 'LIMIT_EXCEEDED');
  var mcc = await ad.networkCharge(card, { amountCents: 100, currency: 'USD', mcc: '7995', merchantId: f.m.merchant.id });
  assert.equal(mcc.failure_reason, 'MERCHANT_CATEGORY_NOT_ALLOWED');
  var other = await ad.networkCharge(card, { amountCents: 100, currency: 'USD', mcc: f.m.merchant.mcc, merchantId: 'm_amazon' });
  assert.equal(other.failure_reason, 'MERCHANT_BRAND_NOT_ALLOWED');
  var ok = await ad.networkCharge(card, { amountCents: 100, currency: 'USD', mcc: f.m.merchant.mcc, merchantId: f.m.merchant.id });
  assert.equal(ok.process_result, 'APPROVED');
  var again = await ad.networkCharge(card, { amountCents: 100, currency: 'USD', mcc: f.m.merchant.mcc, merchantId: f.m.merchant.id });
  assert.equal(again.failure_reason, 'TRANSACTION_USAGE_DISABLED');
});

test('sandbox: uses the documented endpoints and headers (fake fetch)', async function () {
  var f = fixture();
  var calls = [];
  function fakeFetch(url, init) {
    calls.push({ url: url, init: init });
    var path = url.replace(AWX.SANDBOX_URL, '');
    var body = {};
    if (path === '/api/v1/authentication/login') body = { token: 'tok', expires_at: new Date(Date.now() + 1800000).toISOString().replace('Z', '+0000') };
    else if (path === '/api/v1/issuing/cards/create') body = { card_id: '7f687fe6-dcf4-4462-92fa-80335301d9d2', card_status: 'ACTIVE' };
    else if (path === '/api/v1/simulation/issuing/create') body = { process_result: 'APPROVED', card_transaction_id: 'txn_1' };
    else if (/\/api\/v1\/issuing\/cards\/.+\/update$/.test(path)) body = { card_status: 'CLOSED' };
    return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(JSON.stringify(body)); } });
  }
  var ad = AWX.createSandboxAdapter({ clientId: 'cid', apiKey: 'key', cardholderId: 'ch', fetch: fakeFetch });
  var card = await ad.createMandateCard(f.m);
  var r = await ad.authorize(card, f.m, f.charge);
  var rep = await ad.reportResult(card, r);

  assert.equal(calls[0].url, AWX.SANDBOX_URL + '/api/v1/authentication/login');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-client-id'], 'cid');
  assert.equal(calls[0].init.headers['x-api-key'], 'key');
  assert.equal(calls[1].url, AWX.SANDBOX_URL + '/api/v1/issuing/cards/create');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok');
  var created = JSON.parse(calls[1].init.body);
  assert.equal(created.cardholder_id, 'ch');
  assert.equal(created.authorization_controls.allowed_transaction_count, 'SINGLE');
  var sim = JSON.parse(calls[2].init.body);
  assert.equal(calls[2].url, AWX.SANDBOX_URL + '/api/v1/simulation/issuing/create');
  assert.equal(sim.card_id, '7f687fe6-dcf4-4462-92fa-80335301d9d2');
  assert.equal(sim.transaction_amount, f.charge.amountCents / 100);
  assert.equal(sim.transaction_currency, 'USD');
  assert.equal(sim.single_phase, true);
  assert.equal(calls[3].url, AWX.SANDBOX_URL + '/api/v1/issuing/cards/7f687fe6-dcf4-4462-92fa-80335301d9d2/update');
  assert.deepEqual(JSON.parse(calls[3].init.body), { card_status: 'CLOSED' });
  assert.equal(calls.length, 4, 'token is reused, not fetched per call');
  assert.equal(r.approved, true);
  assert.equal(rep.cardStatus, 'CLOSED');
});

test('sandbox: a blocked charge never calls Airwallex', async function () {
  var f = fixture();
  var n = 0;
  var ad = AWX.createSandboxAdapter({ clientId: 'c', apiKey: 'k', cardholderId: 'h', fetch: function () { n++; return Promise.reject(new Error('should not be called')); } });
  var r = await ad.authorize({ cardId: 'x' }, f.m, Object.assign({}, f.charge, { merchantId: 'm_amazon' }));
  assert.equal(r.reason, 'WRONG_MERCHANT');
  assert.equal(n, 0);
});
