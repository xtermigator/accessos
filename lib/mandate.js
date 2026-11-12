/*
 * AccessOS mandate engine — all money logic lives here, in code, not in prompts.
 *
 * An Approval is what the person said "yes" to: one item, one merchant, one total,
 * one set of terms (returns, delivery). A Mandate is the spending authority issued
 * from that approval. The agent can only spend through a mandate, and a mandate
 * only allows a charge that matches the approval exactly:
 *   - amount  <= approved total (integer cents, same currency)
 *   - merchant == approved merchant
 *   - terms   == approved terms (fingerprint match)
 *   - single use, not expired, not revoked
 * If the merchant's quote changes after approval, compareQuote() says whether the
 * person has to approve again. Price drops are allowed; everything else re-asks.
 *
 * Works in Node (require) and in the browser (window.AccessOS.mandate).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.AccessOS = root.AccessOS || {}; root.AccessOS.mandate = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_TTL_MS = 30 * 60 * 1000; // a mandate lives 30 minutes

  var REASONS = {
    OK: 'OK',
    OVER_LIMIT: 'OVER_LIMIT',
    WRONG_MERCHANT: 'WRONG_MERCHANT',
    WRONG_CURRENCY: 'WRONG_CURRENCY',
    TERMS_CHANGED: 'TERMS_CHANGED',
    EXPIRED: 'EXPIRED',
    ALREADY_USED: 'ALREADY_USED',
    NOT_ACTIVE: 'NOT_ACTIVE',
    INVALID_AMOUNT: 'INVALID_AMOUNT',
    NOT_APPROVED: 'NOT_APPROVED'
  };

  // Plain-language explanation for each reason (shown to the person and in the audit log).
  var PLAIN = {
    OK: 'Payment matches what you approved.',
    OVER_LIMIT: 'Blocked: the charge is more than you approved.',
    WRONG_MERCHANT: 'Blocked: this is not the store you approved.',
    WRONG_CURRENCY: 'Blocked: the charge is in a different currency.',
    TERMS_CHANGED: 'Blocked: the terms changed since you approved. You need to approve again.',
    EXPIRED: 'Blocked: your approval timed out. You need to approve again.',
    ALREADY_USED: 'Blocked: this approval was already used once.',
    NOT_ACTIVE: 'Blocked: this approval was cancelled.',
    INVALID_AMOUNT: 'Blocked: the amount is not valid.',
    NOT_APPROVED: 'Blocked: nothing has been approved yet.'
  };

  function assertCents(n, name) {
    if (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n || n < 0) {
      throw new Error(name + ' must be a whole, non-negative number of cents');
    }
  }

  function quoteTotalCents(quote) {
    assertCents(quote.itemCents, 'itemCents');
    assertCents(quote.shippingCents || 0, 'shippingCents');
    assertCents(quote.taxCents || 0, 'taxCents');
    return quote.itemCents + (quote.shippingCents || 0) + (quote.taxCents || 0);
  }

  // Stable JSON (sorted keys) so the same terms always give the same fingerprint.
  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canonical(value[k]);
    }).join(',') + '}';
  }

  // FNV-1a 32-bit. A tamper-evident fingerprint for comparison, not a security hash.
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // The fields an approval is bound to. Anything here changing = a different deal.
  function boundTerms(quote) {
    return {
      productId: quote.productId,
      merchantId: quote.merchant.id,
      currency: quote.currency,
      totalCents: quoteTotalCents(quote),
      returnDays: quote.terms.returnDays,
      restockingFeePct: quote.terms.restockingFeePct || 0,
      returnMethod: quote.terms.returnMethod || '',
      deliveryByISO: quote.terms.deliveryByISO
    };
  }

  function termsFingerprint(quote) {
    return fnv1a(canonical(boundTerms(quote)));
  }

  var counter = 0;
  function makeId(prefix, now) {
    counter += 1;
    return prefix + '_' + now.toString(36) + '_' + counter.toString(36);
  }

  /** What the person approves with one tap. */
  function createApproval(quote, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    if (!quote || !quote.merchant || !quote.terms) throw new Error('quote needs merchant and terms');
    var total = quoteTotalCents(quote);
    if (total <= 0) throw new Error('total must be more than zero');
    if (opts.budgetCents != null && total > opts.budgetCents) {
      throw new Error('total is over the budget the person gave');
    }
    return {
      id: makeId('appr', now),
      approvedAt: now,
      approvedBy: opts.approvedBy || 'user',
      productId: quote.productId,
      productName: quote.productName,
      merchant: { id: quote.merchant.id, name: quote.merchant.name, domain: quote.merchant.domain, mcc: quote.merchant.mcc },
      currency: quote.currency,
      totalCents: total,
      terms: JSON.parse(JSON.stringify(quote.terms)),
      fingerprint: termsFingerprint(quote),
      bound: boundTerms(quote)
    };
  }

  /**
   * Compare a fresh merchant quote against what was approved.
   * Returns { same, requiresReapproval, changes:[{field, from, to, plain, needsApproval}] }
   */
  function compareQuote(approval, newQuote) {
    var a = approval.bound;
    var b = boundTerms(newQuote);
    var changes = [];
    function add(field, from, to, plain, needsApproval) {
      changes.push({ field: field, from: from, to: to, plain: plain, needsApproval: needsApproval });
    }
    if (a.productId !== b.productId) add('productId', a.productId, b.productId, 'The item is different.', true);
    if (a.merchantId !== b.merchantId) add('merchantId', a.merchantId, b.merchantId, 'The store is different.', true);
    if (a.currency !== b.currency) add('currency', a.currency, b.currency, 'The currency is different.', true);
    if (a.totalCents !== b.totalCents) {
      var up = b.totalCents > a.totalCents;
      add('totalCents', a.totalCents, b.totalCents,
        up ? 'The total went up by ' + formatMoney(b.totalCents - a.totalCents, b.currency) + ', to ' + formatMoney(b.totalCents, b.currency) + '.'
           : 'The total went down by ' + formatMoney(a.totalCents - b.totalCents, b.currency) + ', to ' + formatMoney(b.totalCents, b.currency) + '. You pay less.',
        up);
    }
    if (a.returnDays !== b.returnDays) {
      var shorter = b.returnDays < a.returnDays;
      add('returnDays', a.returnDays, b.returnDays,
        'Return window changed from ' + a.returnDays + ' to ' + b.returnDays + ' days.', shorter);
    }
    if (a.restockingFeePct !== b.restockingFeePct) {
      add('restockingFeePct', a.restockingFeePct, b.restockingFeePct,
        'Restocking fee changed from ' + a.restockingFeePct + '% to ' + b.restockingFeePct + '%.', b.restockingFeePct > a.restockingFeePct);
    }
    if (a.returnMethod !== b.returnMethod) add('returnMethod', a.returnMethod, b.returnMethod, 'How you return it changed.', true);
    if (a.deliveryByISO !== b.deliveryByISO) {
      var later = String(b.deliveryByISO) > String(a.deliveryByISO);
      add('deliveryByISO', a.deliveryByISO, b.deliveryByISO,
        'Delivery date changed from ' + a.deliveryByISO + ' to ' + b.deliveryByISO + '.', later);
    }
    var requires = changes.some(function (c) { return c.needsApproval; });
    return { same: changes.length === 0, requiresReapproval: requires, changes: changes };
  }

  /** Issue spending authority bound to an approval. */
  function issueMandate(approval, opts) {
    opts = opts || {};
    if (!approval || !approval.id) throw new Error(REASONS.NOT_APPROVED);
    var now = opts.now != null ? opts.now : Date.now();
    return {
      id: makeId('mdt', now),
      approvalId: approval.id,
      status: 'ACTIVE', // ACTIVE -> USED | REVOKED
      singleUse: true,
      currency: approval.currency,
      limitCents: approval.totalCents,
      merchant: approval.merchant,
      fingerprint: approval.fingerprint,
      issuedAt: now,
      expiresAt: now + (opts.ttlMs || DEFAULT_TTL_MS),
      uses: 0
    };
  }

  /**
   * Check a charge against a mandate. Pure: returns a decision, never mutates.
   * charge = { amountCents, currency, merchantId, fingerprint }
   */
  function checkCharge(mandate, charge, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    function no(reason) { return { allowed: false, reason: reason, plain: PLAIN[reason] }; }
    if (!mandate) return no(REASONS.NOT_APPROVED);
    if (mandate.status === 'REVOKED') return no(REASONS.NOT_ACTIVE);
    if (mandate.status === 'USED' || (mandate.singleUse && mandate.uses >= 1)) return no(REASONS.ALREADY_USED);
    if (mandate.status !== 'ACTIVE') return no(REASONS.NOT_ACTIVE);
    if (now > mandate.expiresAt) return no(REASONS.EXPIRED);
    if (typeof charge.amountCents !== 'number' || Math.floor(charge.amountCents) !== charge.amountCents || charge.amountCents <= 0) {
      return no(REASONS.INVALID_AMOUNT);
    }
    if (charge.merchantId !== mandate.merchant.id) return no(REASONS.WRONG_MERCHANT);
    if (charge.currency !== mandate.currency) return no(REASONS.WRONG_CURRENCY);
    if (charge.amountCents > mandate.limitCents) return no(REASONS.OVER_LIMIT);
    if (charge.fingerprint !== mandate.fingerprint) return no(REASONS.TERMS_CHANGED);
    return { allowed: true, reason: REASONS.OK, plain: PLAIN.OK };
  }

  /** Apply a decision: on success, the single-use mandate is spent. Returns a new mandate. */
  function recordUse(mandate, decision) {
    var m = JSON.parse(JSON.stringify(mandate));
    if (decision.allowed) { m.uses += 1; if (m.singleUse) m.status = 'USED'; }
    return m;
  }

  function revoke(mandate) {
    var m = JSON.parse(JSON.stringify(mandate));
    m.status = 'REVOKED';
    return m;
  }

  function formatMoney(cents, currency) {
    var sign = cents < 0 ? '-' : '';
    var abs = Math.abs(cents);
    var symbol = currency === 'USD' || !currency ? '$' : currency + ' ';
    return sign + symbol + Math.floor(abs / 100) + '.' + ('0' + (abs % 100)).slice(-2);
  }

  return {
    REASONS: REASONS,
    PLAIN: PLAIN,
    quoteTotalCents: quoteTotalCents,
    termsFingerprint: termsFingerprint,
    boundTerms: boundTerms,
    createApproval: createApproval,
    compareQuote: compareQuote,
    issueMandate: issueMandate,
    checkCharge: checkCharge,
    recordUse: recordUse,
    revoke: revoke,
    formatMoney: formatMoney,
    _canonical: canonical
  };
});
