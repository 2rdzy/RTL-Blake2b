import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  getExplorerFeesRecommended, getExplorerTransaction, getCurrencyRates,
  clnFeeRatesToRecommended, normalizeCurrencyRates, fiatRatesBaseUrl,
  DEFAULT_BLOCK_EXPLORER_URL, DEFAULT_FIAT_RATES_URL
} from '../../backend/controllers/shared/RTLConf.js';

const listen = async (handler) => {
  const seen = [];
  const server = createServer((req, res) => { seen.push({ method: req.method, url: req.url }); handler(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
};
const call = (fn, req) => new Promise((resolve) => {
  const res = { status: (code) => ({ json: (payload) => resolve({ code, payload }) }) };
  fn(req, res, null);
});
const json = (res, body, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

const FEERATES = {
  perkb: {
    floor: 1012, min_acceptable: 1012,
    estimates: [{ blockcount: 2, feerate: 4000 }, { blockcount: 6, feerate: 2500 }, { blockcount: 12, feerate: 1500 }, { blockcount: 100, feerate: 1012 }]
  }
};

test('the defaults are this chain\'s explorer and price source, not Bitcoin\'s', () => {
  assert.equal(DEFAULT_BLOCK_EXPLORER_URL, 'https://mempool.kilombino.com');
  assert.equal(DEFAULT_FIAT_RATES_URL, 'https://xbt.live');
});

test('clnFeeRatesToRecommended maps node estimates to sat/vB', () => {
  assert.deepEqual(clnFeeRatesToRecommended(FEERATES), { fastestFee: 4, halfHourFee: 3, hourFee: 3, economyFee: 2, minimumFee: 2 });
  assert.equal(clnFeeRatesToRecommended({}), null);
  assert.equal(clnFeeRatesToRecommended({ perkb: { estimates: [] } }), null);
  assert.equal(clnFeeRatesToRecommended({ perkb: { floor: 1, estimates: [{ blockcount: 2, feerate: 1 }] } }).minimumFee, 1);
});

test('normalizeCurrencyRates converts the flat price list and keeps the legacy shape', () => {
  const out = normalizeCurrencyRates({ time: 1791565933, USD: 940.24, EUR: 838.93, junk: 5, GBP: { last: 700, buy: 700, sell: 700, '15m': 700, symbol: 'GBP' } });
  assert.deepEqual(Object.keys(out).sort(), ['EUR', 'GBP', 'USD']);
  assert.deepEqual(out.USD, { '15m': 940.24, last: 940.24, buy: 940.24, sell: 940.24, symbol: 'USD' });
  assert.equal(out.GBP.last, 700);
  assert.deepEqual(normalizeCurrencyRates(null), {});
});

test('fiatRatesBaseUrl reads FIAT_RATES_URL, drops a trailing slash and ignores a malformed value', () => {
  const saved = process.env.FIAT_RATES_URL;
  try {
    delete process.env.FIAT_RATES_URL;
    assert.equal(fiatRatesBaseUrl(), 'https://xbt.live');
    process.env.FIAT_RATES_URL = 'https://prices.example/';
    assert.equal(fiatRatesBaseUrl(), 'https://prices.example');
    process.env.FIAT_RATES_URL = 'ftp://nope';
    assert.equal(fiatRatesBaseUrl(), 'https://xbt.live');
    // the node's own setting (from RTL-Config.json, resolved at boot) comes first
    process.env.FIAT_RATES_URL = 'https://env.example';
    assert.equal(fiatRatesBaseUrl({ fiatRatesUrl: 'https://config.example/' }), 'https://config.example');
    assert.equal(fiatRatesBaseUrl({ fiatRatesUrl: 'file:///etc/passwd' }), 'https://env.example');
  } finally {
    if (saved === undefined) { delete process.env.FIAT_RATES_URL; } else { process.env.FIAT_RATES_URL = saved; }
  }
});

test('getCurrencyRates fetches the configured price source and returns the converted rates', async () => {
  const src = await listen((req, res) => json(res, { time: 1, USD: 940.24, EUR: 838.93 }));
  const saved = process.env.FIAT_RATES_URL;
  process.env.FIAT_RATES_URL = src.url + '/';
  try {
    const { code, payload } = await call(getCurrencyRates, { session: { selectedNode: { index: 1, lnImplementation: 'CLN', settings: { logLevel: 'ERROR' } } } });
    assert.equal(code, 200);
    assert.equal(payload.USD.last, 940.24);
    assert.deepEqual(src.seen, [{ method: 'GET', url: '/api/v1/prices' }]);
  } finally {
    if (saved === undefined) { delete process.env.FIAT_RATES_URL; } else { process.env.FIAT_RATES_URL = saved; }
    await src.close();
  }
});

test('getCurrencyRates uses the fiatRatesUrl setting of the selected node', async () => {
  const src = await listen((req, res) => json(res, { USD: 1000 }));
  try {
    const { code, payload } = await call(getCurrencyRates, { session: { selectedNode: { index: 1, lnImplementation: 'CLN', settings: { logLevel: 'ERROR', fiatRatesUrl: src.url } } } });
    assert.equal(code, 200);
    assert.equal(payload.USD.last, 1000);
    assert.equal(src.seen.length, 1);
  } finally {
    await src.close();
  }
});

test('getCurrencyRates fails instead of answering with another source when the price source is down', async () => {
  const src = await listen((req, res) => json(res, { error: 'down' }, 503));
  const saved = process.env.FIAT_RATES_URL;
  process.env.FIAT_RATES_URL = src.url;
  try {
    const { code } = await call(getCurrencyRates, { session: { selectedNode: { index: 1, lnImplementation: 'CLN', settings: { logLevel: 'ERROR' } } } });
    assert.equal(code, 500);
    assert.equal(src.seen.length, 1);
  } finally {
    if (saved === undefined) { delete process.env.FIAT_RATES_URL; } else { process.env.FIAT_RATES_URL = saved; }
    await src.close();
  }
});

test('getExplorerFeesRecommended uses the configured explorer', async () => {
  const explorer = await listen((req, res) => json(res, { fastestFee: 9, halfHourFee: 8, hourFee: 7, economyFee: 6, minimumFee: 5 }));
  try {
    const session = { selectedNode: { index: 1, lnImplementation: 'CLN', authentication: { options: {} }, settings: { blockExplorerUrl: explorer.url + '/' } } };
    const { code, payload } = await call(getExplorerFeesRecommended, { session });
    assert.equal(code, 200);
    assert.equal(payload.fastestFee, 9);
    assert.deepEqual(explorer.seen, [{ method: 'GET', url: '/api/v1/fees/recommended' }]);
  } finally {
    await explorer.close();
  }
});

test('getExplorerFeesRecommended asks the Core Lightning node when the explorer is down', async () => {
  const explorer = await listen((req, res) => json(res, { error: 'down' }, 502));
  const node = await listen((req, res) => json(res, FEERATES));
  try {
    const session = { selectedNode: { index: 1, lnImplementation: 'CLN', authentication: { options: { json: true } }, settings: { blockExplorerUrl: explorer.url, lnServerUrl: node.url } } };
    const { code, payload } = await call(getExplorerFeesRecommended, { session });
    assert.equal(code, 200);
    assert.deepEqual(payload, { fastestFee: 4, halfHourFee: 3, hourFee: 3, economyFee: 2, minimumFee: 2 });
    assert.deepEqual(node.seen, [{ method: 'POST', url: '/v1/feerates' }]);
  } finally {
    await explorer.close();
    await node.close();
  }
});

test('getExplorerFeesRecommended reports an error, not another chain\'s fees, when no source works', async () => {
  const explorer = await listen((req, res) => json(res, { error: 'down' }, 502));
  try {
    const session = { selectedNode: { index: 1, lnImplementation: 'LND', authentication: { options: {} }, settings: { blockExplorerUrl: explorer.url } } };
    const { code, payload } = await call(getExplorerFeesRecommended, { session });
    assert.equal(code, 500);
    assert.equal(payload.fastestFee, undefined);
    assert.equal(explorer.seen.length, 1);
  } finally {
    await explorer.close();
  }
});

test('getExplorerTransaction reports an error and does not retry on a different explorer', async () => {
  const explorer = await listen((req, res) => json(res, { error: 'not found' }, 404));
  try {
    const session = { selectedNode: { index: 1, lnImplementation: 'CLN', settings: { blockExplorerUrl: explorer.url } } };
    const { code } = await call(getExplorerTransaction, { params: { txid: 'ab' }, session });
    assert.equal(code, 500);
    assert.equal(explorer.seen.length, 1);
  } finally {
    await explorer.close();
  }
});
