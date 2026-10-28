import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { robotsPolicy, canonicalRecipeUrl, parseListing, titleKey, aliasKey, deduplicate, blockReason, retryAfterDate, limitedBody, requestPage, MIN_DELAY_MS } from '../scripts/recipe-discovery.mjs';

test('robots merges wildcard groups and selects more specific agents', () => {
  const text = 'User-agent: *\nDisallow: /*?*\nCrawl-delay: 20\nUser-agent: *\nDisallow: /search/\nAllow: /search/help$\nUser-agent: Special\nDisallow: /';
  const policy = robotsPolicy(text);
  assert.equal(policy.delayMs, 20000);
  assert.equal(policy.allows('https://www.xiachufang.com/search/help'), true);
  assert.equal(policy.allows('https://www.xiachufang.com/search/help/more'), false);
  assert.equal(policy.allows('https://www.xiachufang.com/recipe/123/?page=2'), false);
  assert.equal(robotsPolicy(text, 'Special').allows('https://www.xiachufang.com/'), false);
});

test('robots handles consecutive agents, tie allow and empty disallow', () => {
  const policy = robotsPolicy('User-agent: *\nUser-agent: Other\nDisallow:\nDisallow: /a\nAllow: /a\nCrawl-delay: 2');
  assert.equal(policy.allows('https://www.xiachufang.com/a'), true);
  assert.equal(policy.delayMs, MIN_DELAY_MS);
});

test('observed xiachufang robots directives disallow pagination, search and comments', async () => {
  const text = await readFile(new URL('./fixtures/recipe-discovery-robots.txt', import.meta.url), 'utf8');
  const policy = robotsPolicy(text);
  for (const path of ['/category/40076/?page=2', '/recipe/123/comments/', '/search/?keyword=菜', '/category/40076/pop/']) assert.equal(policy.allows(`https://www.xiachufang.com${path}`), false, path);
  for (const path of ['/category/40076/', '/recipe/123/', '/category/40076/?ref=home']) assert.equal(policy.allows(`https://www.xiachufang.com${path}`), true, path);
});

test('canonical recipe links reject unrelated, private and spoofed hosts', () => {
  assert.equal(canonicalRecipeUrl('/recipe/123/?ref=home#top'), 'https://www.xiachufang.com/recipe/123/');
  assert.equal(canonicalRecipeUrl('http://home.meishichina.com/recipe-123.html?ref=home'), 'https://home.meishichina.com/recipe-123.html');
  for (const value of ['javascript:alert(1)', 'https://www.xiachufang.com.evil.test/recipe/123/', 'https://evil@www.xiachufang.com/recipe/123/', 'https://www.xiachufang.com:8080/recipe/123/', '/recipe/123/comments/', '/search/']) assert.equal(canonicalRecipeUrl(value), null);
});

test('list parser extracts names only, merging image/title anchors without scraping instructions', () => {
  const parsed = parseListing(`<script><a href="/recipe/999/">fake</a></script>
    <a href="/recipe/123/?ref=home" title="红烧肉 &amp; 米饭"><img src="private-photo.jpg"></a>
    <a href='/recipe/123/'>红烧肉 &amp; 米饭</a><a href='/recipe/123/'>42 人做过这道菜</a>
    <a href='/recipe/456/'><img alt='&#x83dc;汤' src='photo.jpg'></a>
    <a href='/category/40076/' title='家常菜菜谱大全'>家常菜</a>
    <a href='/category/40076/?page=2'>下一页</a><a href='/cook/123/'>用户</a>`, 'https://www.xiachufang.com/');
  assert.deepEqual(parsed.recipes, [{ title: '红烧肉 & 米饭', sourceUrl: 'https://www.xiachufang.com/recipe/123/' }, { title: '菜汤', sourceUrl: 'https://www.xiachufang.com/recipe/456/' }]);
  assert.deepEqual(parsed.listings, [{ url: 'https://www.xiachufang.com/category/40076/', label: '家常菜' }]);
  assert.equal(JSON.stringify(parsed).includes('photo.jpg'), false);
  assert.equal(parsed.observations, 3);
});

test('title normalization merges limited aliases without removing cooking methods', () => {
  assert.equal(titleKey('蒜蓉 西兰花！'), titleKey('蒜蓉西兰花'));
  assert.equal(aliasKey('番茄炒蛋'), aliasKey('西红柿炒鸡蛋'));
  assert.equal(aliasKey('鸡蛋炒番茄'), aliasKey('西红柿炒鸡蛋'));
  assert.equal(aliasKey('小米粥（普通锅版）'), aliasKey('小米粥'));
  assert.notEqual(aliasKey('清蒸鱼'), aliasKey('红烧鱼'));
});

test('dedup against baseline and batch keeps suspect variants out of ready candidates', () => {
  const entry = (number, title) => ({ title, sourceUrl: `https://www.xiachufang.com/recipe/${number}/` });
  const result = deduplicate([entry(1, '番茄炒蛋'), entry(2, '新手西红柿炒鸡蛋'), entry(3, '可乐鸡翅'), entry(3, '可乐鸡翅'), entry(4, '可乐 鸡翅'), entry(5, '家常可乐鸡翅'), entry(6, '白灼虾')], [{ title: '西红柿炒鸡蛋', scope: 'cloud' }]);
  assert.equal(result.repeatedUrls, 1);
  assert.equal(result.exactDuplicates.length, 2);
  assert.equal(result.nearDuplicates.length, 2);
  assert.deepEqual(result.candidates.map(record => record.title), ['可乐鸡翅', '白灼虾']);
  for (const record of result.candidates) {
    assert.equal(record.autoImportAllowed, false);
    assert.equal(record.recordType, 'source_link_only');
  }
});

test('URL merging retains categories and baseline URL exclusion works even after renaming', () => {
  const url = 'https://www.xiachufang.com/recipe/123/';
  const result = deduplicate([
    { title: '菜甲', sourceUrl: `${url}?ref=home`, sourceCategories: ['素菜'], discoveredOn: ['page-a'] },
    { title: '菜甲', sourceUrl: url, sourceCategories: ['家常'], discoveredOn: ['page-b'] },
  ], []);
  assert.deepEqual(result.candidates[0].sourceCategories, ['素菜', '家常']);
  assert.deepEqual(result.candidates[0].discoveredOn, ['page-a', 'page-b']);
  const changed = deduplicate([{ title: '改过名', sourceUrl: url }], [{ title: '旧名', sourceUrl: url }]);
  assert.equal(changed.candidates.length, 0);
  assert.equal(changed.exactDuplicates[0].reason, 'existing_source_url');
});

test('similar names are not declared equal and distinct cooking methods survive', () => {
  const recipes = ['清蒸鲈鱼', '红烧鲈鱼', '西红柿鸡蛋汤', '西红柿炒鸡蛋'].map((title, index) => ({ title, sourceUrl: `https://www.xiachufang.com/recipe/${index + 1}/` }));
  const result = deduplicate(recipes, []);
  assert.equal(result.candidates.length, 4);
  assert.equal(result.nearDuplicates.length, 0);
});

test('short Chinese dish names with descriptive additions are held as variants', () => {
  const result = deduplicate([{ title: '新手零失败红烧肉', sourceUrl: 'https://www.xiachufang.com/recipe/123/' }], [{ title: '红烧肉' }]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.nearDuplicates.length, 1);
  assert.equal(result.exactDuplicates.length, 0);
});

test('meishichina list parsing supports its recipe URL style without visiting profiles', () => {
  const result = parseListing('<a href="//home.meishichina.com/recipe-42.html" title="炒青菜"><img alt="炒青菜"></a><a href="/recipe-caidan.html">分类</a><a href="https://home.meishichina.com/space-1.html">作者</a>', 'https://home.meishichina.com/recipe.html');
  assert.deepEqual(result.recipes, [{ title: '炒青菜', sourceUrl: 'https://home.meishichina.com/recipe-42.html' }]);
  assert.equal(result.listings.length, 1);
});

test('HTTP and challenge classification never treats a 200 captcha as a recipe list', () => {
  for (const status of [401, 403, 418, 429, 503, 302]) assert.ok(blockReason(status));
  assert.equal(blockReason(200, '<title>Just a moment...</title>'), 'access_challenge');
  assert.equal(blockReason(200, '<title>安全验证</title>'), 'access_challenge');
  assert.equal(blockReason(200, '<a>菜谱</a>'), null);
});

test('Retry-After stores both seconds and date without scheduling evasion retries', () => {
  const now = Date.parse('2026-09-09T00:00:00Z');
  assert.equal(retryAfterDate('120', now), '2026-09-09T00:02:00.000Z');
  assert.equal(retryAfterDate('Wed, 09 Sep 2026 00:03:00 GMT', now), '2026-09-09T00:03:00.000Z');
  assert.equal(retryAfterDate('invalid', now), null);
});

test('response byte cap applies to declared and streamed sizes', async () => {
  assert.equal(await limitedBody(new Response('abc'), 3), 'abc');
  await assert.rejects(limitedBody(new Response('abcdef'), 3), /too_large/);
  await assert.rejects(limitedBody(new Response('x', { headers: { 'content-length': '100' } }), 3), /too_large/);
});

test('request gate honors spacing, robots, 429 and persistent host blocking', async () => {
  const now = Date.parse('2026-09-09T00:00:00Z');
  const host = { robots: 'User-agent: *\nDisallow: /search/\nCrawl-delay: 10', lastRequestAt: new Date(now - 1000).toISOString() };
  const calls = [];
  const options = { clock: () => now, wait: async delay => calls.push({ delay }), fetcher: async (url, config) => { calls.push({ url, config }); return new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } }); } };
  assert.equal((await requestPage('https://www.xiachufang.com/search/', host, options)).requested, false);
  assert.equal(calls.length, 0);
  const result = await requestPage('https://www.xiachufang.com/category/1/', host, options);
  assert.equal(result.blocked, 'http_429');
  assert.equal(calls[0].delay, 11000);
  assert.equal(calls[1].config.redirect, 'manual');
  assert.equal(calls[1].config.headers.Cookie, undefined);
  assert.equal((await requestPage('https://www.xiachufang.com/category/2/', host, options)).requested, false);
  assert.equal(calls.length, 2);
  assert.equal(host.retryAfter, '2026-09-09T00:01:00.000Z');
});

test('transient network failure also stops a host instead of retrying in a loop', async () => {
  const host = { robots: 'User-agent: *\nAllow: /' };
  const result = await requestPage('https://www.xiachufang.com/', host, { fetcher: async () => { throw new Error('timeout'); } });
  assert.equal(result.blocked, 'timeout');
  assert.equal(host.blocked, 'timeout');
});

test('checkpoint hook happens before a request and unexpected successful JSON halts the host', async () => {
  const host = { robots: 'User-agent: *\nAllow: /' };
  const events = [];
  const result = await requestPage('https://www.xiachufang.com/', host, {
    beforeRequest: async () => { assert.ok(host.lastRequestAt); events.push('checkpoint'); },
    fetcher: async () => { events.push('network'); return Response.json({ login: true }); },
  });
  assert.deepEqual(events, ['checkpoint', 'network']);
  assert.equal(result.blocked, 'unexpected_http_or_content_type');
});

test('deleted listing is skipped without poisoning other permitted pages', async () => {
  const host = { robots: 'User-agent: *\nAllow: /' };
  const result = await requestPage('https://www.xiachufang.com/category/42/', host, { fetcher: async () => new Response('gone', { status: 404 }) });
  assert.equal(result.error, 'unexpected_http_or_content_type');
  assert.equal(host.blocked, undefined);
});
