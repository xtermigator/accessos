/*
 * AccessOS shopping agent (deterministic planner for the demo).
 * Reads a plain-language need, plans, filters, ranks, explains in plain words,
 * and writes every step to an audit log: GOAL -> PLAN -> ACTION -> NEW_INFO -> REVISION -> DECISION -> PAYMENT.
 * No LLM is required for the demo; parseNeed() is the place to plug one in.
 * Works in Node (require) and in the browser (window.AccessOS.agent).
 */
(function (root, factory) {
  var deps = (typeof module === 'object' && module.exports)
    ? { mandate: require('./mandate.js'), catalog: require('./catalog.js') }
    : { mandate: root.AccessOS.mandate, catalog: root.AccessOS.catalog };
  var api = factory(deps.mandate, deps.catalog);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.AccessOS = root.AccessOS || {}; root.AccessOS.agent = api; }
})(typeof self !== 'undefined' ? self : this, function (M, C) {
  'use strict';

  /* ---------- audit log ---------- */
  function AuditLog(clock) {
    this.entries = [];
    this.clock = clock || function () { return Date.now(); };
  }
  AuditLog.prototype.add = function (kind, text, data) {
    var e = { at: this.clock(), kind: kind, text: text };
    if (data !== undefined) e.data = data;
    this.entries.push(e);
    return e;
  };

  /* ---------- need parsing ---------- */
  var WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14 };

  function parseNeed(text) {
    var t = String(text || '').toLowerCase();
    var need = { raw: String(text || ''), budgetCents: null, withinDays: null, quiet: false, easyReturns: false, category: null };
    var money = t.match(/(?:under|below|less than|max|up to|budget(?: of)?|no more than)?\s*\$\s?(\d+(?:\.\d{1,2})?)/);
    if (money) need.budgetCents = Math.round(parseFloat(money[1]) * 100);
    var days = t.match(/(?:in|within|by)\s+(\d+|one|two|three|four|five|six|seven|ten|fourteen)\s+days?/);
    if (days) need.withinDays = WORD_NUMBERS[days[1]] || parseInt(days[1], 10);
    else if (/\b(a|one|this|next) week\b/.test(t)) need.withinDays = 7;
    else if (/tomorrow/.test(t)) need.withinDays = 1;
    need.quiet = /quiet|silent|no tick|not tick|noise/.test(t);
    need.easyReturns = /return/.test(t);
    if (/timer|stay on task|focus|time blind/.test(t)) need.category = 'visual-timer';
    return need;
  }

  function describeNeed(n) {
    var parts = [];
    parts.push(n.category === 'visual-timer' ? 'a visual timer' : 'the item you described');
    if (n.budgetCents != null) parts.push('total under ' + M.formatMoney(n.budgetCents, 'USD'));
    if (n.withinDays != null) parts.push('arrives within ' + n.withinDays + ' days');
    if (n.quiet) parts.push('no ticking');
    if (n.easyReturns) parts.push('easy returns');
    return parts.join(', ');
  }

  /* ---------- shortlist ---------- */
  function scoreQuote(p, q, need) {
    var total = M.quoteTotalCents(q);
    var score = 0, reasons = [], cautions = [];
    if (p.quiet === 'yes') { score += need.quiet ? 30 : 10; reasons.push('No ticking.'); }
    else if (p.quiet === 'unknown') { score -= need.quiet ? 15 : 0; cautions.push('The store does not say if it ticks.'); }
    if (p.returnDays >= 90) { score += need.easyReturns ? 30 : 10; reasons.push('Long return window: ' + p.returnDays + ' days.'); }
    else if (p.returnDays >= 30) { score += need.easyReturns ? 15 : 5; reasons.push(p.returnDays + '-day returns.'); }
    if (p.returnAssumed) cautions.push('Return window is our best guess, not read from the page.');
    if (need.budgetCents) score += Math.round(20 * (need.budgetCents - total) / need.budgetCents);
    if (p.deliveryDays <= 2) { score += 5; reasons.push('Fast delivery.'); }
    return { score: score, reasons: reasons, cautions: cautions, totalCents: total };
  }

  function buildShortlist(need, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    var products = opts.products || C.PRODUCTS;
    var log = opts.log;
    var kept = [], excluded = [];
    products.forEach(function (p) {
      if (need.category && need.category !== 'visual-timer') return;
      var q = C.quoteFor(p, { now: now });
      var s = scoreQuote(p, q, need);
      var why = null;
      if (need.budgetCents != null && s.totalCents > need.budgetCents) {
        why = 'Total ' + M.formatMoney(s.totalCents, 'USD') + ' is over your ' + M.formatMoney(need.budgetCents, 'USD') + ' limit.';
      } else if (need.withinDays != null && p.deliveryDays > need.withinDays) {
        why = 'Arrives in ' + p.deliveryDays + ' days. You need it within ' + need.withinDays + '.';
      }
      var row = { product: p, merchant: C.merchantOf(p), quote: q, score: s.score, reasons: s.reasons, cautions: s.cautions, totalCents: s.totalCents };
      if (why) { row.excludedBecause = why; excluded.push(row); } else kept.push(row);
    });
    kept.sort(function (a, b) { return b.score - a.score; });
    var shortlist = kept.slice(0, opts.max || 3);
    if (log) {
      log.add('ACTION', 'Checked ' + products.length + ' items from ' + Object.keys(C.MERCHANTS).length + ' stores. Kept ' + shortlist.length + '.',
        { kept: shortlist.map(function (r) { return r.product.id; }), excluded: excluded.map(function (r) { return { id: r.product.id, why: r.excludedBecause }; }) });
    }
    return { shortlist: shortlist, excluded: excluded };
  }

  /* ---------- plain-language comparison ---------- */
  function compareInPlainWords(shortlist) {
    if (!shortlist.length) return ['Nothing fits yet. Try a higher limit or a later date.'];
    var lines = [];
    var best = shortlist[0];
    var cheapest = shortlist.slice().sort(function (a, b) { return a.totalCents - b.totalCents; })[0];
    var fastest = shortlist.slice().sort(function (a, b) { return a.product.deliveryDays - b.product.deliveryDays; })[0];
    var longest = shortlist.slice().sort(function (a, b) { return b.product.returnDays - a.product.returnDays; })[0];
    lines.push('Best fit: ' + best.product.name + ' from ' + best.merchant.name + ', ' + M.formatMoney(best.totalCents, 'USD') + ' total.');
    if (cheapest !== best) lines.push('Cheapest: ' + cheapest.product.name + ', ' + M.formatMoney(cheapest.totalCents, 'USD') + '. ' + (cheapest.cautions[0] || ''));
    if (fastest !== best) lines.push('Fastest: ' + fastest.merchant.name + ', about ' + fastest.product.deliveryDays + ' days.');
    lines.push('Easiest to return: ' + longest.merchant.name + ' (' + longest.product.returnDays + ' days).');
    return lines.map(function (s) { return s.trim(); });
  }

  /* ---------- the whole story, end to end (used by CLI + tests) ---------- */
  function planText(need) {
    return [
      'Find items that match: ' + describeNeed(need) + '.',
      'Drop anything over your limit or too slow.',
      'Rank by: no ticking, easy returns, then price.',
      'Show you up to 3, with the page each fact came from.',
      'Ask you to approve one exact item, store, total and return terms.',
      'Issue a one-time card locked to that amount and store.',
      'Re-check the store right before paying. If anything changed, stop and ask again.'
    ];
  }

  return {
    AuditLog: AuditLog,
    parseNeed: parseNeed,
    describeNeed: describeNeed,
    buildShortlist: buildShortlist,
    compareInPlainWords: compareInPlainWords,
    planText: planText,
    scoreQuote: scoreQuote
  };
});
