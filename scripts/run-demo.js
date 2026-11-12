#!/usr/bin/env node
/*
 * End-to-end AccessOS story in the terminal.
 *   node scripts/run-demo.js            -> SANDBOX-MOCK (default, no keys needed)
 *   AIRWALLEX_CLIENT_ID=... AIRWALLEX_API_KEY=... AIRWALLEX_CARDHOLDER_ID=... node scripts/run-demo.js
 *                                       -> live Airwallex sandbox
 * Prints the audit log: goal -> plan -> new info -> revised decision -> payment result.
 */
'use strict';
var M = require('../lib/mandate.js');
var C = require('../lib/catalog.js');
var A = require('../lib/agent.js');
var AWX = require('../lib/airwallex.js');

var NEED = 'I need a visual timer to help me stay on task. Under $40, here within 7 days, quiet, easy returns.';

async function main() {
  var adapter = AWX.createAdapter();
  var log = new A.AuditLog();
  var now = Date.now();
  log.add('MODE', 'Airwallex adapter: ' + adapter.mode);

  // 1. Goal
  var need = A.parseNeed(NEED);
  log.add('GOAL', 'Buy ' + A.describeNeed(need) + '.', need);

  // 2. Plan
  log.add('PLAN', A.planText(need).join(' '));

  // 3. Shortlist + comparison
  var sl = A.buildShortlist(need, { now: now, log: log });
  A.compareInPlainWords(sl.shortlist).forEach(function (l) { log.add('COMPARE', l); });
  var pick = sl.shortlist[0];

  // 4. Person approves exact item / store / total / terms
  var approval = M.createApproval(pick.quote, { now: now, budgetCents: need.budgetCents });
  log.add('APPROVAL', 'You approved ' + approval.productName + ' from ' + approval.merchant.name + ' for ' +
    M.formatMoney(approval.totalCents, 'USD') + ', ' + approval.terms.returnDays + '-day returns.', { approvalId: approval.id, fingerprint: approval.fingerprint });

  // 5. New info: store re-checked right before paying — the sale ended.
  var fresh = C.quoteFor(pick.product, { now: now, itemCents: pick.product.priceCents + 200 });
  var diff = M.compareQuote(approval, fresh);
  log.add('NEW_INFO', 'Re-checked ' + approval.merchant.domain + ' before paying. ' + diff.changes.map(function (c) { return c.plain; }).join(' '), diff);

  // 6. The old approval can no longer pay for the new total.
  var oldMandate = M.issueMandate(approval, { now: now });
  var tryOld = M.checkCharge(oldMandate, { amountCents: M.quoteTotalCents(fresh), currency: 'USD', merchantId: fresh.merchant.id, fingerprint: M.termsFingerprint(fresh) }, { now: now });
  log.add('BLOCKED', 'Tried old approval on new price: ' + tryOld.plain, tryOld);

  // 7. Revised decision: still best and still under budget -> ask again.
  var stillUnder = M.quoteTotalCents(fresh) <= need.budgetCents;
  log.add('REVISION', stillUnder
    ? 'Still the best fit and still under your limit. Paused and asked you to approve the new total.'
    : 'New total is over your limit. Switching to the next option.');
  var approval2 = M.createApproval(fresh, { now: now, budgetCents: need.budgetCents });
  log.add('APPROVAL', 'You approved again: ' + M.formatMoney(approval2.totalCents, 'USD') + '.', { approvalId: approval2.id });

  // 8. Mandate + Airwallex single-use card locked to amount + merchant
  var mandate = M.issueMandate(approval2, { now: now });
  var card = await adapter.createMandateCard(mandate);
  log.add('MANDATE', 'One-time card ' + card.maskedPan + ' issued. Limit ' + M.formatMoney(mandate.limitCents, 'USD') + ', only at ' + mandate.merchant.name + ', expires in 30 min.', { mandateId: mandate.id, cardId: card.cardId, controls: card.controls });

  // 9. Guardrail checks
  var over = await adapter.authorize(card, mandate, { amountCents: mandate.limitCents + 500, currency: 'USD', merchantId: mandate.merchant.id, mcc: mandate.merchant.mcc, fingerprint: mandate.fingerprint });
  log.add('BLOCKED', 'Agent tried $5 more: ' + over.plain);
  var wrong = await adapter.authorize(card, mandate, { amountCents: mandate.limitCents, currency: 'USD', merchantId: C.MERCHANTS.amazon.id, mcc: '5999', fingerprint: mandate.fingerprint });
  log.add('BLOCKED', 'Agent tried another store: ' + wrong.plain);

  // 10. The real charge
  var charge = { amountCents: approval2.totalCents, currency: 'USD', merchantId: mandate.merchant.id, mcc: mandate.merchant.mcc, merchantName: mandate.merchant.name, fingerprint: M.termsFingerprint(fresh) };
  var result = await adapter.authorize(card, mandate, charge);
  mandate = M.recordUse(mandate, { allowed: result.approved });
  log.add('PAYMENT', (result.approved ? 'Paid ' : 'Not paid ') + M.formatMoney(charge.amountCents, 'USD') + ' at ' + mandate.merchant.name + '. ' + result.plain, { network: result.network, transactionId: result.transactionId });

  var report = await adapter.reportResult(card, result);
  log.add('RESULT', 'Card closed. Receipt ' + report.receipt.receiptId + '.', report.receipt);

  var again = await adapter.authorize(card, mandate, charge);
  log.add('BLOCKED', 'Tried to pay a second time: ' + again.plain);

  log.entries.forEach(function (e) { console.log('[' + e.kind.padEnd(8) + '] ' + e.text); });
  if (process.argv.indexOf('--json') >= 0) console.log(JSON.stringify(log.entries, null, 2));
}

main().catch(function (e) { console.error('AccessOS demo failed:', e.message); if (e.body) console.error(JSON.stringify(e.body)); process.exit(1); });
