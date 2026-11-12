/* AccessOS web demo. One decision per screen. All money rules come from lib/mandate.js. */
(function () {
  'use strict';
  var AO = window.AccessOS;
  var M = AO.mandate, C = AO.catalog, A = AO.agent, AWX = AO.airwallex;

  var EXAMPLE = 'I need a visual timer to help me stay on task. Under $40, here within 7 days, quiet, easy returns.';
  var STEPS = ['Your need', 'The plan', 'Options', 'Compare', 'Approve', 'Check the store', 'Pay', 'Done'];

  var state;
  function reset() {
    state = {
      now: Date.now(),
      log: new A.AuditLog(),
      adapter: AWX.createMockAdapter(),
      needText: EXAMPLE,
      need: null, shortlist: [], excluded: [], pick: null,
      approval: null, fresh: null, diff: null, mandate: null, card: null,
      result: null, report: null, guard: []
    };
  }

  /* ---------- helpers ---------- */
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(c) { return M.formatMoney(c, 'USD'); }
  function dateWords(iso) {
    var d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }
  function simple() { return document.body.classList.contains('simple'); }

  function log(kind, text, data) {
    state.log.add(kind, text, data);
    var li = document.createElement('li');
    li.innerHTML = '<span class="kind k-' + esc(kind) + '">' + esc(kind.replace('_', ' ')) + '</span> ' + esc(text);
    $('log').appendChild(li);
    li.scrollIntoView({ block: 'nearest' });
  }

  function show(stepIndex, html, after) {
    $('progress').textContent = 'Step ' + (stepIndex + 1) + ' of ' + STEPS.length + ': ' + STEPS[stepIndex];
    var s = $('screen');
    s.innerHTML = '<div class="fade-in">' + html + '</div>';
    var h = s.querySelector('h1');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
    s.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () { handlers[b.getAttribute('data-go')](b); });
    });
    if (after) after(s);
  }

  /* ---------- screens ---------- */
  function screenNeed() {
    show(0,
      '<h1>What do you need?</h1>' +
      '<p class="lead">Say it in your own words. Add a price limit and when you need it.</p>' +
      '<label class="big" for="need">Your need</label>' +
      '<textarea id="need" aria-describedby="needhelp">' + esc(state.needText) + '</textarea>' +
      '<p id="needhelp" class="small detail">Example: "a quiet visual timer under $40, here in a week, easy returns".</p>' +
      '<div class="actions"><button class="primary" data-go="plan">Find options</button></div>');
  }

  function screenPlan() {
    var n = state.need;
    var steps = A.planText(n);
    show(1,
      '<h1>Here is my plan</h1>' +
      '<div class="card"><p class="lead"><strong>Goal:</strong> ' + esc(A.describeNeed(n)) + '.</p></div>' +
      '<ol class="plain">' + (simple() ? steps.slice(0, 3) : steps).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<div class="notice ok"><strong>I will never pay without your tap.</strong> And I can only pay the exact amount, at the exact store, you approve.</div>' +
      '<div class="actions"><button class="primary" data-go="shortlist">Show me options</button><button data-go="restart">Change my need</button></div>');
  }

  function quietTag(p) {
    if (p.quiet === 'yes') return '<span class="tag ok">No ticking</span>';
    if (p.quiet === 'unknown') return '<span class="tag warn">Ticking: unknown</span>';
    return '<span class="tag bad">Ticks</span>';
  }

  function itemCard(row, i) {
    var p = row.product;
    return '<article class="card' + (i === 0 ? ' pick' : '') + '" aria-labelledby="it' + i + '">' +
      '<h2 class="item" id="it' + i + '">' + (i === 0 ? 'Best fit: ' : '') + esc(p.name) + '</h2>' +
      '<p class="price">' + money(row.totalCents) + ' <span class="small">total with shipping and tax</span></p>' +
      '<p>' + quietTag(p) + '<span class="tag ok">' + p.returnDays + '-day returns</span> <span class="small">at ' + esc(row.merchant.name) + '</span></p>' +
      '<p>' + esc(p.plainWhy) + '</p>' +
      (row.cautions.length ? '<p class="small"><strong>Heads up:</strong> ' + esc(row.cautions.join(' ')) + '</p>' : '') +
      '<details class="detail"><summary>Where these facts came from</summary><ul class="plain">' +
        p.evidence.map(function (e) { return '<li>' + esc(e.claim) + ' – <a href="' + esc(e.url) + '" target="_blank" rel="noopener">source<span class="sr"> (opens new tab)</span></a></li>'; }).join('') +
        (p.shippingAssumed ? '<li>Shipping cost and delivery days: demo assumption, not read from the store.</li>' : '') +
      '</ul></details>' +
      '</article>';
  }

  function screenShortlist() {
    var list = state.shortlist;
    var shown = simple() ? list.slice(0, 2) : list;
    show(2,
      '<h1>' + (shown.length < list.length ? 'Here are my top ' + shown.length : 'I found ' + list.length + ' good options') + '</h1>' +
      '<p class="lead">Ranked for you: no ticking, easy returns, then price.</p>' +
      shown.map(itemCard).join('') +
      (state.excluded.length ? '<details class="detail"><summary>Left out (' + state.excluded.length + ')</summary><ul class="plain">' +
        state.excluded.map(function (r) { return '<li>' + esc(r.product.name) + ': ' + esc(r.excludedBecause) + '</li>'; }).join('') + '</ul></details>' : '') +
      '<div class="actions"><button class="primary" data-go="compare">Compare them simply</button></div>');
  }

  function screenCompare() {
    var list = state.shortlist;
    var lines = A.compareInPlainWords(list);
    var table = '<table class="compare detail"><caption class="small">Side by side</caption><thead><tr><th scope="col">Item</th><th scope="col">Total</th><th scope="col">Arrives</th><th scope="col">Returns</th><th scope="col">Ticking</th></tr></thead><tbody>' +
      list.map(function (r) {
        return '<tr><th scope="row">' + esc(r.product.name) + '<br><span class="small">' + esc(r.merchant.name) + '</span></th><td>' + money(r.totalCents) + '</td><td>' +
          esc(dateWords(r.quote.terms.deliveryByISO)) + '</td><td>' + r.product.returnDays + ' days</td><td>' + (r.product.quiet === 'yes' ? 'None' : 'Unknown') + '</td></tr>';
      }).join('') + '</tbody></table>';
    var choices = (simple() ? list.slice(0, 1) : list).map(function (r, i) {
      return '<button class="' + (i === 0 ? 'primary' : '') + '" data-go="choose" data-id="' + esc(r.product.id) + '">' + (i === 0 ? 'Go with my pick: ' : 'Choose ') + esc(r.merchant.name) + '</button>';
    }).join('');
    show(3,
      '<h1>In plain words</h1>' +
      '<ul class="plain lead">' + lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
      table +
      '<p><strong>My pick:</strong> ' + esc(list[0].product.name) + '. It is quiet and the easiest to return if it does not help.</p>' +
      '<div class="actions">' + choices + '</div>');
  }

  function approvalCard(a, title) {
    return '<section class="card approval" aria-labelledby="apprtitle">' +
      '<h2 id="apprtitle">' + esc(title) + '</h2>' +
      '<p class="big-amount">' + money(a.totalCents) + '</p>' +
      '<dl>' +
        '<dt>Item</dt><dd>' + esc(a.productName) + '</dd>' +
        '<dt>Store</dt><dd>' + esc(a.merchant.name) + ' (' + esc(a.merchant.domain) + ')</dd>' +
        '<dt>Returns</dt><dd>' + a.terms.returnDays + ' days. ' + esc(a.terms.returnMethod) + '.</dd>' +
        '<dt>Arrives by</dt><dd>' + esc(dateWords(a.terms.deliveryByISO)) + '</dd>' +
      '</dl>' +
      '<p class="small">This approval only covers this amount, this store and these terms. If anything changes, I will ask you again.</p>' +
    '</section>';
  }

  function screenApprove() {
    show(4,
      '<h1>Approve this purchase?</h1>' +
      approvalCard(state.approval, 'You are approving') +
      '<div class="actions"><button class="primary" data-go="approve">Approve ' + money(state.approval.totalCents) + '</button><button data-go="compare">Not yet</button></div>');
  }

  function screenRecheck() {
    var d = state.diff;
    if (d.same || !d.requiresReapproval) {
      show(5,
        '<h1>The store still matches</h1>' +
        '<div class="notice ok">I checked ' + esc(state.approval.merchant.domain) + ' again right before paying. ' +
        (d.same ? 'Nothing changed.' : esc(d.changes.map(function (c) { return c.plain; }).join(' '))) + '</div>' +
        '<div class="actions"><button class="primary" data-go="issue">Get my one-time card</button></div>');
      return;
    }
    var under = M.quoteTotalCents(state.fresh) <= state.need.budgetCents;
    show(5,
      '<h1>Something changed. I paused.</h1>' +
      '<div class="notice"><strong>New info:</strong> I checked ' + esc(state.approval.merchant.domain) + ' again right before paying. ' +
        esc(d.changes.map(function (c) { return c.plain; }).join(' ')) + '</div>' +
      '<div class="notice bad detail">Your first approval cannot pay this. It was for ' + money(state.approval.totalCents) + '. I tried; it was blocked.</div>' +
      '<p class="lead"><strong>What I think now:</strong> ' + (under
        ? 'It is still the best fit and still under your ' + money(state.need.budgetCents) + ' limit. Approve the new total, or pick another.'
        : 'It is now over your limit. Pick another option.') + '</p>' +
      (under ? approvalCard(M.createApproval(state.fresh, { now: state.now }), 'New total to approve') : '') +
      '<div class="actions">' + (under ? '<button class="primary" data-go="reapprove">Approve ' + money(M.quoteTotalCents(state.fresh)) + '</button>' : '') +
      '<button data-go="compare">Pick another</button></div>');
  }

  function screenMandate() {
    var m = state.mandate, c = state.card;
    show(6,
      '<h1>Your one-time card is ready</h1>' +
      '<div class="card approval"><p class="big-amount">' + money(m.limitCents) + '</p><dl>' +
        '<dt>Card</dt><dd>' + esc(c.maskedPan) + ' (virtual, single use)</dd>' +
        '<dt>Only at</dt><dd>' + esc(m.merchant.name) + '</dd>' +
        '<dt>Max charge</dt><dd>' + money(m.limitCents) + '</dd>' +
        '<dt>Expires</dt><dd>in 30 minutes</dd>' +
      '</dl><p class="small">Issued through the Airwallex Issuing adapter (' + esc(state.adapter.mode) + ').</p></div>' +
      '<details class="detail"><summary>The Airwallex card request</summary><pre>' + esc(JSON.stringify(c.request, null, 2)) + '</pre></details>' +
      '<section class="card detail" aria-labelledby="gt"><h2 id="gt">Try to break it</h2><p class="small">These are what a buggy or tricked agent might try.</p>' +
        '<div class="actions"><button data-go="tryover">Charge $5 more</button><button data-go="trywrong">Pay a different store</button></div>' +
        '<div id="guardout" aria-live="polite"></div></section>' +
      '<div class="actions"><button class="primary" data-go="pay">Pay ' + money(m.limitCents) + ' now</button></div>');
  }

  function screenDone() {
    var r = state.report.receipt;
    var ok = state.result.approved;
    show(7,
      '<h1>' + (ok ? 'Done. You paid ' + esc(r.amount) + '.' : 'Not paid.') + '</h1>' +
      '<div class="notice ' + (ok ? 'ok' : 'bad') + '">' + esc(r.reason) + ' The card is now closed, so it cannot be used again.</div>' +
      '<section class="card" aria-labelledby="rc"><h2 id="rc">Receipt</h2><dl class="approval" style="border:0">' +
        '<dt>Item</dt><dd>' + esc(state.approval.productName) + '</dd>' +
        '<dt>Store</dt><dd>' + esc(r.merchant) + '</dd>' +
        '<dt>Paid</dt><dd>' + esc(r.amount) + '</dd>' +
        '<dt>Returns</dt><dd>' + state.approval.terms.returnDays + ' days</dd>' +
        '<dt>Card</dt><dd>' + esc(r.card) + ' (closed)</dd>' +
        '<dt>Receipt no.</dt><dd>' + esc(r.receiptId) + '</dd>' +
      '</dl></section>' +
      '<p class="small detail">Mode: ' + esc(r.mode) + '. No real money moved.</p>' +
      '<div class="actions"><button class="primary" data-go="restart">Start over</button></div>');
  }

  /* ---------- actions ---------- */
  var handlers = {
    restart: function () { reset(); $('log').innerHTML = ''; screenNeed(); },
    plan: function () {
      state.needText = $('need').value.trim() || EXAMPLE;
      state.need = A.parseNeed(state.needText);
      if (state.need.budgetCents == null) state.need.budgetCents = 4000;
      if (!state.need.category) state.need.category = 'visual-timer';
      log('GOAL', 'Buy ' + A.describeNeed(state.need) + '.');
      log('PLAN', A.planText(state.need).slice(0, 4).join(' '));
      screenPlan();
    },
    shortlist: function () {
      var r = A.buildShortlist(state.need, { now: state.now, log: state.log });
      // mirror the ACTION entry the agent just wrote
      var last = state.log.entries[state.log.entries.length - 1];
      state.log.entries.pop(); log(last.kind, last.text, last.data);
      state.shortlist = r.shortlist; state.excluded = r.excluded;
      if (!r.shortlist.length) {
        show(2, '<h1>Nothing fits yet</h1><p class="lead">' + esc(A.compareInPlainWords([])[0]) + '</p><div class="actions"><button class="primary" data-go="restart">Change my need</button></div>');
        return;
      }
      screenShortlist();
    },
    compare: function () { screenCompare(); },
    choose: function (btn) {
      var id = btn.getAttribute('data-id');
      state.pick = state.shortlist.filter(function (r) { return r.product.id === id; })[0];
      state.approval = M.createApproval(state.pick.quote, { now: state.now, budgetCents: state.need.budgetCents });
      log('DECISION', 'Chose ' + state.pick.product.name + ' at ' + state.pick.merchant.name + '. Waiting for your approval.');
      screenApprove();
    },
    approve: function () {
      log('APPROVAL', 'You approved ' + money(state.approval.totalCents) + ' at ' + state.approval.merchant.name + ', ' + state.approval.terms.returnDays + '-day returns.');
      var p = state.pick.product;
      var change = $('demochange').checked;
      state.fresh = C.quoteFor(p, { now: state.now, itemCents: change ? p.priceCents + 200 : p.priceCents });
      state.diff = M.compareQuote(state.approval, state.fresh);
      if (state.diff.requiresReapproval) {
        log('NEW_INFO', 'Re-checked ' + state.approval.merchant.domain + ': item price ' + money(p.priceCents) + ' → ' + money(state.fresh.itemCents) + '. ' + state.diff.changes.map(function (c) { return c.plain; }).join(' '));
        var oldM = M.issueMandate(state.approval, { now: state.now });
        var tryOld = M.checkCharge(oldM, { amountCents: M.quoteTotalCents(state.fresh), currency: 'USD', merchantId: state.fresh.merchant.id, fingerprint: M.termsFingerprint(state.fresh) }, { now: state.now });
        log('BLOCKED', 'Old approval on the new price: ' + tryOld.plain);
        log('REVISION', 'Paused. Asking you to approve the new total.');
      } else {
        log('ACTION', 'Re-checked ' + state.approval.merchant.domain + ': no change that needs you.');
      }
      screenRecheck();
    },
    reapprove: function () {
      state.approval = M.createApproval(state.fresh, { now: state.now, budgetCents: state.need.budgetCents });
      log('APPROVAL', 'You approved the new total: ' + money(state.approval.totalCents) + '.');
      handlers.issue();
    },
    issue: function () {
      if (!state.diff.requiresReapproval && !state.diff.same) {
        // price dropped: bind the mandate to the lower, current quote
        state.approval = M.createApproval(state.fresh, { now: state.now, budgetCents: state.need.budgetCents });
      }
      state.mandate = M.issueMandate(state.approval, { now: Date.now() });
      state.adapter.createMandateCard(state.mandate).then(function (card) {
        state.card = card;
        log('MANDATE', 'One-time card ' + card.maskedPan + ': max ' + money(state.mandate.limitCents) + ', only at ' + state.mandate.merchant.name + ', 30 min.');
        screenMandate();
      });
    },
    tryover: function () { guard({ amountCents: state.mandate.limitCents + 500 }, 'Charge $5 more'); },
    trywrong: function () { guard({ merchantId: C.MERCHANTS.amazon.id }, 'Pay a different store'); },
    pay: function (btn) {
      btn.disabled = true;
      var m = state.mandate;
      var charge = { amountCents: state.approval.totalCents, currency: 'USD', merchantId: m.merchant.id, mcc: m.merchant.mcc, merchantName: m.merchant.name, fingerprint: M.termsFingerprint(state.fresh) };
      state.adapter.authorize(state.card, m, charge).then(function (res) {
        state.result = res;
        state.mandate = M.recordUse(m, { allowed: res.approved });
        log('PAYMENT', (res.approved ? 'Paid ' : 'Not paid ') + money(charge.amountCents) + ' at ' + m.merchant.name + '. ' + res.plain);
        return state.adapter.reportResult(state.card, res);
      }).then(function (rep) {
        state.report = rep;
        log('RESULT', 'Card closed. Receipt ' + rep.receipt.receiptId + '.');
        screenDone();
      });
    }
  };

  function guard(override, label) {
    var m = state.mandate;
    var charge = Object.assign({ amountCents: m.limitCents, currency: 'USD', merchantId: m.merchant.id, mcc: m.merchant.mcc, fingerprint: m.fingerprint }, override);
    state.adapter.authorize(state.card, m, charge).then(function (res) {
      log('BLOCKED', label + ': ' + res.plain);
      var out = $('guardout');
      if (out) out.innerHTML += '<div class="notice bad"><strong>' + esc(label) + ':</strong> ' + esc(res.plain) + ' <span class="small">(never sent to the card network)</span></div>';
    });
  }

  /* ---------- toggles ---------- */
  function initToggles() {
    var simp = $('simplify'), lg = $('showlog');
    var saved = null;
    try { saved = localStorage.getItem('accessos.simple'); } catch (e) { /* file:// may block storage */ }
    simp.checked = saved === '1';
    document.body.classList.toggle('simple', simp.checked);
    simp.addEventListener('change', function () {
      document.body.classList.toggle('simple', simp.checked);
      try { localStorage.setItem('accessos.simple', simp.checked ? '1' : '0'); } catch (e) { /* ignore */ }
    });
    lg.addEventListener('change', function () { document.body.classList.toggle('nolog', !lg.checked); });
    $('mode').textContent = 'Test mode: ' + AWX.createMockAdapter().mode;
  }

  reset();
  initToggles();
  screenNeed();
  window.__accessos = { state: function () { return state; }, handlers: handlers };
})();
