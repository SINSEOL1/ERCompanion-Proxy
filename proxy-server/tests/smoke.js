const assert = require('assert');

process.env.ER_OPEN_API_KEY = 'real-key-hidden';
process.env.PROXY_ACCESS_TOKEN = 'temporary-token';
process.env.PROXY_RATE_LIMIT_PER_MINUTE = '100';

const handler = require('../api/er.js');

assert.strictEqual(handler._test.normalizePath('/v2/data/hash'), 'v2/data/hash');
assert.strictEqual(handler._test.normalizePath('v1/user/nickname'), 'v1/user/nickname');
assert.strictEqual(handler._test.normalizePath('https://evil.example/a'), null);
assert.strictEqual(handler._test.normalizePath('../v1/test'), null);
assert.strictEqual(handler._test.normalizePath('not-versioned/test'), null);

console.log('Smoke tests passed.');
