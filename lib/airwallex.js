/*
 * Airwallex Issuing adapter for AccessOS (Kit 2: intent-bound purchase with virtual-card controls).
 *
 * Interface (same in both modes, all methods return Promises):
 *   createMandateCard(mandate)        -> { cardId, maskedPan, status, controls, request }
 *   authorize(card, mandate, charge)  -> { approved, reason, plain, network, transactionId }
 *   reportResult(card, result)        -> { cardId, cardStatus, receipt }
 *
 * Modes
 *   SANDBOX-MOCK (default): in-memory card that enforces the same controls Airwallex would
 *     (per-transaction limit, single use, allowed MCC, allowed currency, active_to).
 *   SANDBOX (live): real calls to https://api.sandbox.airwallex.com. Turned on when
 *     AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY are set (and ACCESSOS_MODE is not "mock").
 *     Production hosts are refused: this demo only spends test money.
 *
 * Call shapes follow the public Airwallex API reference (version 2026-08-21):
 *   POST /api/v1/authentication/login              headers x-client-id, x-api-key -> { token, expires_at }
 *   POST /api/v1/issuing/cards/create              authorization_controls.{allowed_transaction_count,
 *                                                  transaction_limits{currency,limits[{amount,interval}]},
 *                                                  allowed_currencies, allowed_merchant_categories, active_to}
 *   GET  /api/v1/issuing/merchant_brands?name=...  -> items[{id,name}] (optional brand lock)
 *   POST /api/v1/simulation/issuing/create         sandbox-only test authorization -> process_result APPROVED|DECLINED
 *   POST /api/v1/issuing/cards/{id}/update         { card_status: "CLOSED" } once the purchase is done
 * Amounts in Airwallex are in major units (e.g. 37.91 USD); AccessOS keeps cents internally.
 *
 * Defense in depth: AccessOS checks every charge against the mandate in code BEFORE it ever
 * reaches the card network, and the card itself carries the same limits.
 */
(function (root, factory) {
  var M = (typeof module === 'object' && module.exports) ? require('./mandate.js') : root.AccessOS.mandate;
  var api = factory(M);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.AccessOS = root.AccessOS || {}; root.AccessOS.airwallex = api; }
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  var SANDBOX_URL = 'https://api.sandbox.airwallex.com';
  var API_VERSION = '2026-08-21';

  function toMajor(cents) { return Math.round(cents) / 100; }

  /** Build the exact Create-a-Card body for a mandate (shared by both modes, so tests can check it). */
  function buildCardRequest(mandate, cfg) {
    cfg = cfg || {};
    var limit = toMajor(mandate.limitCents);
    var controls = {
      allowed_transaction_count: 'SINGLE',
      allowed_currencies: [mandate.currency],
      transaction_limits: {
        currency: mandate.currency,
        limits: [
          { amount: limit, interval: 'PER_TRANSACTION' },
          { amount: limit, interval: 'ALL_TIME' }
        ]
      },
      active_to: new Date(mandate.expiresAt).toISOString().replace(/\.\d{3}Z$/, '+0000')
    };
    if (mandate.merchant.mcc) controls.allowed_merchant_categories = [mandate.merchant.mcc];
    if (cfg.merchantBrandId) controls.allowed_merchant_brands = { ids: [cfg.merchantBrandId] };
    return {
      request_id: 'accessos-' + mandate.id,
      cardholder_id: cfg.cardholderId || '00000000-0000-0000-0000-000000000000',
      created_by: cfg.createdBy || 'AccessOS Demo',
      form_factor: 'VIRTUAL',
      is_personalized: false,
      program: { purpose: 'COMMERCIAL' },
      nick_name: 'AccessOS ' + mandate.merchant.name.slice(0, 20),
      authorization_controls: controls,
      metadata: {
        mandate_id: mandate.id,
        approval_id: mandate.approvalId,
        terms_fp: mandate.fingerprint,
        merchant_id: mandate.merchant.id
      }
    };
  }

  function receiptFor(card, result) {
    return {
      receiptId: 'rcpt_' + String(card.mandateId).replace(/^mdt_/, ''),
      merchant: card.merchantName,
      amount: M.formatMoney(result.amountCents, card.currency),
      amountCents: result.amountCents,
      card: card.maskedPan,
      status: result.approved ? 'PAID' : 'NOT PAID',
      reason: result.plain,
      mandateId: card.mandateId,
      mode: card.mode
    };
  }

  /* ================= SANDBOX-MOCK ================= */
  function createMockAdapter(cfg) {
    cfg = cfg || {};
    var cards = {};
    var seq = 0;
    var clock = cfg.clock || function () { return Date.now(); };

    function networkDecision(card, txn) {
      // What Airwallex card controls would do on the network side.
      if (card.status !== 'ACTIVE') return 'CARD_INACTIVE';
      if (card.controls.allowed_transaction_count === 'SINGLE' && card.successCount >= 1) return 'TRANSACTION_USAGE_DISABLED';
      if (card.controls.active_to && clock() > Date.parse(card.controls.active_to.replace('+0000', 'Z'))) return 'OUT_OF_ALLOWED_TIME_RANGE';
      if (card.controls.allowed_currencies.indexOf(txn.currency) < 0) return 'CURRENCY_NOT_ALLOWED';
      var cats = card.controls.allowed_merchant_categories;
      if (cats && cats.length && cats.indexOf(txn.mcc) < 0) return 'MERCHANT_CATEGORY_NOT_ALLOWED';
      if (card.lockedMerchantId && txn.merchantId !== card.lockedMerchantId) return 'MERCHANT_BRAND_NOT_ALLOWED';
      var per = card.controls.transaction_limits.limits.filter(function (l) { return l.interval === 'PER_TRANSACTION'; })[0];
      if (per && toMajor(txn.amountCents) > per.amount) return 'LIMIT_EXCEEDED';
      return null;
    }

    return {
      mode: 'SANDBOX-MOCK',
      createMandateCard: function (mandate) {
        var req = buildCardRequest(mandate, cfg);
        seq += 1;
        var last4 = ('000' + ((4242 + seq * 37) % 10000)).slice(-4);
        var card = {
          cardId: 'mock_card_' + seq,
          maskedPan: '**** **** **** ' + last4,
          status: 'ACTIVE',
          controls: req.authorization_controls,
          lockedMerchantId: mandate.merchant.id, // stands in for allowed_merchant_brands
          merchantName: mandate.merchant.name,
          currency: mandate.currency,
          mandateId: mandate.id,
          successCount: 0,
          mode: 'SANDBOX-MOCK',
          request: req
        };
        cards[card.cardId] = card;
        return Promise.resolve(card);
      },
      /** Raw network attempt that skips AccessOS's own check. Used to prove the card also holds the line. */
      networkCharge: function (card, txn) {
        var c = cards[card.cardId];
        var fail = networkDecision(c, txn);
        if (!fail) c.successCount += 1;
        return Promise.resolve({ process_result: fail ? 'DECLINED' : 'APPROVED', failure_reason: fail || undefined, transaction_id: 'mock_txn_' + c.cardId + '_' + (c.successCount + (fail ? 100 : 0)) });
      },
      authorize: function (card, mandate, charge) {
        var decision = M.checkCharge(mandate, charge, { now: clock() });
        if (!decision.allowed) {
          return Promise.resolve({ approved: false, reason: decision.reason, plain: decision.plain, network: 'NOT_SENT', amountCents: charge.amountCents });
        }
        return this.networkCharge(card, { amountCents: charge.amountCents, currency: charge.currency, mcc: charge.mcc, merchantId: charge.merchantId })
          .then(function (r) {
            return {
              approved: r.process_result === 'APPROVED',
              reason: r.process_result === 'APPROVED' ? 'OK' : r.failure_reason,
              plain: r.process_result === 'APPROVED' ? decision.plain : 'The card declined it: ' + r.failure_reason,
              network: r.process_result,
              transactionId: r.transaction_id,
              amountCents: charge.amountCents
            };
          });
      },
      reportResult: function (card, result) {
        var c = cards[card.cardId];
        c.status = 'CLOSED';
        return Promise.resolve({ cardId: c.cardId, cardStatus: c.status, receipt: receiptFor(c, result) });
      },
      _cards: cards
    };
  }

  /* ================= SANDBOX (live) ================= */
  function createSandboxAdapter(cfg) {
    var base = (cfg.baseUrl || SANDBOX_URL).replace(/\/$/, '');
    if (!/sandbox/.test(base) && !cfg.allowNonSandbox) {
      throw new Error('AccessOS only talks to the Airwallex sandbox. Refusing ' + base);
    }
    var fetchImpl = cfg.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchImpl) throw new Error('fetch is not available (Node 18+ required)');
    if (!cfg.clientId || !cfg.apiKey) throw new Error('AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY are required for sandbox mode');
    if (!cfg.cardholderId) throw new Error('AIRWALLEX_CARDHOLDER_ID is required to create cards (create one in the sandbox first)');
    var token = null, tokenExp = 0;

    function call(method, path, body, extraHeaders) {
      var headers = Object.assign({ 'Content-Type': 'application/json', 'x-api-version': cfg.apiVersion || API_VERSION }, extraHeaders || {});
      return fetchImpl(base + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
        .then(function (res) {
          return res.text().then(function (txt) {
            var data; try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { raw: txt }; }
            if (!res.ok) {
              var err = new Error('Airwallex ' + method + ' ' + path + ' failed: ' + res.status + ' ' + (data.code || '') + ' ' + (data.message || ''));
              err.status = res.status; err.body = data; throw err;
            }
            return data;
          });
        });
    }
    function login() {
      if (token && Date.now() < tokenExp - 60000) return Promise.resolve(token);
      return call('POST', '/api/v1/authentication/login', null, { 'x-client-id': cfg.clientId, 'x-api-key': cfg.apiKey })
        .then(function (d) { token = d.token; tokenExp = d.expires_at ? Date.parse(d.expires_at.replace('+0000', 'Z')) : Date.now() + 25 * 60000; return token; });
    }
    function authed(method, path, body) {
      return login().then(function (t) { return call(method, path, body, { Authorization: 'Bearer ' + t }); });
    }
    function findBrand(name) {
      if (!cfg.useMerchantBrands) return Promise.resolve(null);
      return authed('GET', '/api/v1/issuing/merchant_brands?name=' + encodeURIComponent(name) + '&page_size=5')
        .then(function (d) { return d.items && d.items[0] ? d.items[0].id : null; })
        .catch(function () { return null; });
    }

    return {
      mode: 'SANDBOX',
      createMandateCard: function (mandate) {
        return findBrand(mandate.merchant.name.split(' ')[0]).then(function (brandId) {
          var req = buildCardRequest(mandate, Object.assign({}, cfg, { merchantBrandId: brandId }));
          return authed('POST', '/api/v1/issuing/cards/create', req).then(function (d) {
            return {
              cardId: d.card_id,
              maskedPan: d.card_number || '(masked)',
              status: d.card_status,
              controls: req.authorization_controls,
              merchantName: mandate.merchant.name,
              currency: mandate.currency,
              mandateId: mandate.id,
              mode: 'SANDBOX',
              request: req,
              raw: d
            };
          });
        });
      },
      networkCharge: function (card, txn) {
        // Sandbox-only simulated authorization against the real card and its real controls.
        return authed('POST', '/api/v1/simulation/issuing/create', {
          card_id: card.cardId,
          transaction_amount: toMajor(txn.amountCents),
          transaction_currency: txn.currency,
          merchant_category_code: txn.mcc,
          merchant_info: txn.merchantName || 'AccessOS demo merchant',
          single_phase: true
        });
      },
      authorize: function (card, mandate, charge) {
        var decision = M.checkCharge(mandate, charge);
        if (!decision.allowed) {
          return Promise.resolve({ approved: false, reason: decision.reason, plain: decision.plain, network: 'NOT_SENT', amountCents: charge.amountCents });
        }
        return this.networkCharge(card, charge).then(function (r) {
          var ok = r.process_result === 'APPROVED';
          return { approved: ok, reason: ok ? 'OK' : r.failure_reason, plain: ok ? decision.plain : 'The card declined it: ' + r.failure_reason,
            network: r.process_result, transactionId: r.card_transaction_id || r.network_transaction_id, amountCents: charge.amountCents, raw: r };
        });
      },
      reportResult: function (card, result) {
        return authed('POST', '/api/v1/issuing/cards/' + card.cardId + '/update', { card_status: 'CLOSED' })
          .then(function (d) { return { cardId: card.cardId, cardStatus: d.card_status || 'CLOSED', receipt: receiptFor(card, result) }; });
      }
    };
  }

  /** Pick the mode from config/env. Mock unless both credentials are present. */
  function createAdapter(cfg) {
    cfg = cfg || {};
    var env = cfg.env || (typeof process !== 'undefined' && process.env ? process.env : {});
    var wantMock = (cfg.mode || env.ACCESSOS_MODE || '').toLowerCase() === 'mock';
    var clientId = cfg.clientId || env.AIRWALLEX_CLIENT_ID;
    var apiKey = cfg.apiKey || env.AIRWALLEX_API_KEY;
    if (!wantMock && clientId && apiKey) {
      return createSandboxAdapter(Object.assign({}, cfg, {
        clientId: clientId, apiKey: apiKey,
        baseUrl: cfg.baseUrl || env.AIRWALLEX_BASE_URL || SANDBOX_URL,
        cardholderId: cfg.cardholderId || env.AIRWALLEX_CARDHOLDER_ID,
        createdBy: cfg.createdBy || env.AIRWALLEX_CREATED_BY,
        useMerchantBrands: cfg.useMerchantBrands != null ? cfg.useMerchantBrands : env.AIRWALLEX_USE_MERCHANT_BRANDS === '1'
      }));
    }
    return createMockAdapter(cfg);
  }

  return { createAdapter: createAdapter, createMockAdapter: createMockAdapter, createSandboxAdapter: createSandboxAdapter, buildCardRequest: buildCardRequest, SANDBOX_URL: SANDBOX_URL, API_VERSION: API_VERSION };
});
