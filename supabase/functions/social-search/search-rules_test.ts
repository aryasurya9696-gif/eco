import assert from 'node:assert/strict';
import {
  allowedOrigins,
  corsOriginFor,
  creditsFor,
  DEV_ORIGINS,
  isOperationAvailable,
  shouldTryRedditFallback,
} from './search-rules.ts';

Deno.test('reddit fallback only on an unbilled empty primary', () => {
  assert.equal(shouldTryRedditFallback({ billable: 'free' }, 0), true);
  // tikhub billed (or may have) for an empty answer: do not pay a second provider.
  assert.equal(shouldTryRedditFallback({ billable: 'billed' }, 0), false);
  assert.equal(shouldTryRedditFallback({ billable: 'uncertain' }, 0), false);
  assert.equal(shouldTryRedditFallback({ billable: 'free' }, 5), false);
  assert.equal(shouldTryRedditFallback({ billable: 'billed' }, 5), false);
});

Deno.test('billing: news is always free and always available', () => {
  const pricing = new Map([['treg.web.search', 1], ['treg.news.search', 1]]);
  assert.equal(creditsFor('treg.news.search', pricing), 0);
  assert.equal(isOperationAvailable('treg.news.search', new Map()), true);
  assert.equal(creditsFor('treg.web.search', pricing), 1);
  assert.equal(isOperationAvailable('treg.web.search', new Map()), false);
  assert.equal(creditsFor('treg.web.search', new Map([['treg.web.search', -3]])), 0);
});

Deno.test('cors: never * by default', () => {
  assert.deepEqual(allowedOrigins(undefined, undefined), [...DEV_ORIGINS]);
  assert.deepEqual(allowedOrigins('', ''), [...DEV_ORIGINS]);
  assert.equal(corsOriginFor('https://evil.example', allowedOrigins(undefined, undefined)), DEV_ORIGINS[0]);
});

Deno.test('cors: configured origins are an allowlist', () => {
  const allowed = allowedOrigins('https://app.example/, https://www.app.example', 'https://app.example');
  assert.deepEqual(allowed, ['https://app.example', 'https://www.app.example']);
  assert.equal(corsOriginFor('https://www.app.example', allowed), 'https://www.app.example');
  assert.equal(corsOriginFor('https://evil.example', allowed), 'https://app.example');
  assert.equal(corsOriginFor(null, allowed), 'https://app.example');
});

Deno.test('cors: * only when explicitly configured', () => {
  assert.equal(corsOriginFor('https://x.example', allowedOrigins('*', undefined)), '*');
});

import { roundCredits } from './search-rules.ts';

Deno.test('fractional credits: 0.1 per keyword is kept, totals rounded to 2 decimals', () => {
  const pricing = new Map([['treg.twitter.search', 0.1], ['treg.reddit.search', 0.1], ['treg.web.search', 0.1], ['treg.news.search', 0]]);
  const perKeyword = ['treg.twitter.search', 'treg.reddit.search', 'treg.web.search', 'treg.news.search']
    .reduce((s, op) => s + creditsFor(op, pricing), 0);
  assert.equal(roundCredits(perKeyword), 0.3);
  assert.equal(roundCredits(perKeyword * 8), 2.4);
  assert.equal(roundCredits(0.1 * 3), 0.3);
  assert.equal(roundCredits(0.1), 0.1, 'never rounded up to a whole credit');
  assert.equal(roundCredits(0), 0);
  assert.equal(roundCredits(-1), 0);
  assert.equal(roundCredits(Number.NaN), 0);
});
