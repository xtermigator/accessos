/*
 * Bundled demo catalog. Real products and real store pages; each field says where it came from.
 *   "source"  = the product page the item came from
 *   "evidence"= the pages each claim came from
 *   fields marked assumed:true are demo assumptions (shipping cost, delivery days, MCC),
 *   NOT read from the store. Prices are a snapshot taken Nov 11, 2026 and can change.
 * Works in Node (require) and in the browser (window.AccessOS.catalog).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.AccessOS = root.AccessOS || {}; root.AccessOS.catalog = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SNAPSHOT = '2026-11-11';
  var TAX_RATE = 0.08625; // Suffolk County, NY combined sales tax, used for the demo estimate

  var MERCHANTS = {
    timetimer: { id: 'm_timetimer', name: 'Time Timer (official store)', domain: 'timetimer.com', mcc: '5999', mccAssumed: true },
    target:    { id: 'm_target',    name: 'Target',                      domain: 'target.com',    mcc: '5310', mccAssumed: true },
    amazon:    { id: 'm_amazon',    name: 'Amazon',                      domain: 'amazon.com',    mcc: '5999', mccAssumed: true }
  };

  var PRODUCTS = [
    {
      id: 'tt-mod-home',
      name: 'Time Timer MOD – Home Edition (60 min)',
      merchant: 'timetimer',
      priceCents: 2595,
      shippingCents: 695, shippingAssumed: true,
      deliveryDays: 5, deliveryAssumed: true,
      returnDays: 365, restockingFeePct: 0, returnMethod: 'Contact the store; they handle it',
      quiet: 'yes',
      plainWhy: 'Shows time as a shrinking colored disk. No ticking. Small enough for a desk.',
      source: 'https://www.timetimer.com/products/time-timer-mod-home-metallic-midnight',
      evidence: [
        { claim: 'Price $25.95', url: 'https://www.timetimer.com/products/time-timer-mod-home-metallic-midnight' },
        { claim: 'Return within 12 months for a full refund, no questions asked', url: 'https://www.timetimer.com/policies/refund-policy' },
        { claim: 'Silent operation (Home MOD listing)', url: 'https://www.target.com/p/time-timer-home-mod-60-minute-visual-timer-home-edition-with-silent-operation/-/A-1006040102' }
      ]
    },
    {
      id: 'tt-plus-target',
      name: 'Time Timer PLUS 60 Minute, white, with handle',
      merchant: 'target',
      priceCents: 2995,
      shippingCents: 599, shippingAssumed: true,
      deliveryDays: 4, deliveryAssumed: true,
      returnDays: 30, restockingFeePct: 0, returnMethod: 'By mail or in store',
      quiet: 'yes',
      plainWhy: 'Same kind of visual timer, bigger, with a carry handle. No ticking.',
      source: 'https://www.target.com/p/time-timer-plus-60-minute-visual-timer-portable-handle-for-classroom-or-office-with-silent-operation-white/-/A-1006040150',
      evidence: [
        { claim: 'Price $29.95, silent operation', url: 'https://www.target.com/p/time-timer-plus-60-minute-visual-timer-portable-handle-for-classroom-or-office-with-silent-operation-white/-/A-1006040150' },
        { claim: 'Return by mail or in store within 30 days', url: 'https://www.target.com/p/time-timer-plus-60-minute-visual-timer-portable-handle-for-classroom-or-office-with-silent-operation-white/-/A-1006040150' }
      ]
    },
    {
      id: 'secura-amazon',
      name: 'Secura 60-Minute Visual Timer (dark green)',
      merchant: 'amazon',
      priceCents: 1999,
      shippingCents: 0, shippingAssumed: true,
      deliveryDays: 2, deliveryAssumed: true,
      returnDays: 30, returnAssumed: true, restockingFeePct: 0, returnMethod: 'Amazon return (drop-off)',
      quiet: 'unknown',
      plainWhy: 'Cheapest. Small. Has a volume setting for the alarm. The listing does not say if it ticks.',
      source: 'https://www.amazon.com/Secura-60-Minute-Classroom-Countdown-Management/dp/B08CS7XTPX',
      evidence: [
        { claim: 'List price $19.99', url: 'https://www.amazon.com/Secura-60-Minute-Classroom-Countdown-Management/dp/B08CS7XTPX' },
        { claim: 'Return window: Amazon standard (assumed, not read from the page)', url: 'https://www.amazon.com/Secura-60-Minute-Classroom-Countdown-Management/dp/B08CS7XTPX' }
      ]
    },
    {
      id: 'tt-original-8',
      name: 'Time Timer Original 8" (60 min)',
      merchant: 'timetimer',
      priceCents: 3895,
      shippingCents: 695, shippingAssumed: true,
      deliveryDays: 5, deliveryAssumed: true,
      returnDays: 365, restockingFeePct: 0, returnMethod: 'Contact the store; they handle it',
      quiet: 'yes',
      plainWhy: 'The classic big version.',
      source: 'https://www.timetimer.com/products/presale-new-colors-time-timer-original-8',
      evidence: [
        { claim: 'Price $38.95', url: 'https://www.timetimer.com/products/presale-new-colors-time-timer-original-8' }
      ]
    }
  ];

  function merchantOf(p) { return MERCHANTS[p.merchant]; }

  function addDaysISO(baseMs, days) {
    var d = new Date(baseMs + days * 86400000);
    return d.toISOString().slice(0, 10);
  }

  /** Turn a product into a checkout quote (what the store would charge). */
  function quoteFor(product, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    var item = opts.itemCents != null ? opts.itemCents : product.priceCents;
    var ship = opts.shippingCents != null ? opts.shippingCents : product.shippingCents;
    var tax = Math.round((item + ship) * TAX_RATE);
    var m = merchantOf(product);
    return {
      productId: product.id,
      productName: product.name,
      merchant: { id: m.id, name: m.name, domain: m.domain, mcc: m.mcc },
      currency: 'USD',
      itemCents: item,
      shippingCents: ship,
      taxCents: tax,
      terms: {
        returnDays: opts.returnDays != null ? opts.returnDays : product.returnDays,
        restockingFeePct: product.restockingFeePct,
        returnMethod: product.returnMethod,
        deliveryByISO: addDaysISO(now, opts.deliveryDays != null ? opts.deliveryDays : product.deliveryDays)
      },
      source: product.source
    };
  }

  return { SNAPSHOT: SNAPSHOT, TAX_RATE: TAX_RATE, MERCHANTS: MERCHANTS, PRODUCTS: PRODUCTS, merchantOf: merchantOf, quoteFor: quoteFor };
});
