import { readFile, writeFile, rename, mkdir, open, rm, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHTML } from 'entities';
import { createSeed, communityPosts } from '../src/data/seed.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'artifacts/recipe-crawl');
export const USER_AGENT = 'ShiyuanRecipeResearch/1.0';
export const MIN_DELAY_MS = 12000;
const MAX_BYTES = 2 * 1024 * 1024;
const sites = [
  { host: 'www.xiachufang.com', name: '下厨房', entry: '/', prefix: 'xiachufang-home' },
  { host: 'home.meishichina.com', name: '美食天下', entry: '/recipe.html', prefix: 'meishichina-list' },
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sleep = duration => new Promise(done => setTimeout(done, duration));
const plainText = html => decodeHTML(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const escapeRegex = value => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function robotsPolicy(text, agent = USER_AGENT) {
  const groups = [];
  let group;
  let hasDirectives = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      if (!group || hasDirectives) {
        group = { agents: [], rules: [], delays: [], signals: [] };
        groups.push(group);
        hasDirectives = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group) {
      hasDirectives = true;
      if ((key === 'allow' || key === 'disallow') && value) group.rules.push({ allow: key === 'allow', path: value });
      if (key === 'crawl-delay' && Number.isFinite(Number(value))) group.delays.push(Number(value) * 1000);
      if (key === 'content-signal') group.signals.push(value);
    }
  }
  const matches = groups.map(entry => ({ ...entry, specificity: Math.max(-1, ...entry.agents.map(name => name === '*' ? 0 : agent.toLowerCase().includes(name) ? name.length : -1)) }));
  const specificity = Math.max(-1, ...matches.map(entry => entry.specificity));
  const selected = matches.filter(entry => specificity >= 0 && entry.specificity === specificity);
  const rules = selected.flatMap(entry => entry.rules);
  return {
    delayMs: Math.max(MIN_DELAY_MS, ...selected.flatMap(entry => entry.delays)),
    signals: selected.flatMap(entry => entry.signals),
    allows(url) {
      const parsed = new URL(url);
      const target = parsed.pathname + parsed.search;
      const matched = rules.filter(rule => {
        const end = rule.path.endsWith('$');
        const pattern = (end ? rule.path.slice(0, -1) : rule.path).split('*').map(escapeRegex).join('.*');
        return new RegExp(`^${pattern}${end ? '$' : ''}`).test(target);
      }).sort((first, second) => second.path.replace(/[*$]/g, '').length - first.path.replace(/[*$]/g, '').length || Number(second.allow) - Number(first.allow));
      return matched[0]?.allow ?? true;
    },
  };
}

function safeUrl(href, base) {
  try {
    const url = new URL(decodeHTML(href), base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (!sites.some(site => site.host === url.hostname)) return null;
    url.protocol = 'https:';
    url.hash = '';
    return url;
  } catch { return null; }
}

export function canonicalRecipeUrl(href, base = 'https://www.xiachufang.com/') {
  const url = safeUrl(href, base);
  if (!url) return null;
  if (url.hostname === 'www.xiachufang.com' && /^\/recipe\/\d+\/?$/.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
  else if (url.hostname !== 'home.meishichina.com' || !/^\/recipe-\d+\.html$/.test(url.pathname)) return null;
  url.search = '';
  return url.href;
}

function attributes(text) {
  const result = {};
  for (const match of text.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = decodeHTML(match[2] ?? match[3] ?? match[4]);
  return result;
}

export function parseListing(html, pageUrl) {
  const recipes = new Map();
  const listings = new Map();
  let observations = 0;
  const cleaned = html.replace(/<!--[^]*?-->|<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, '');
  for (const match of cleaned.matchAll(/<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = attributes(match[1]);
    if (!attrs.href) continue;
    const url = safeUrl(attrs.href, pageUrl);
    if (!url || url.origin !== new URL(pageUrl).origin) continue;
    const imageAttrs = attributes(match[2].match(/<img\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i)?.[1] || '');
    const title = (attrs.title || plainText(match[2]) || imageAttrs.alt || '').trim();
    const recipeUrl = canonicalRecipeUrl(url.href);
    if (recipeUrl && title && title.length <= 180 && !/^\d[\d,.万\s]*人.*(做过|收藏)|^(收藏|查看|详情|做过|更多)$/.test(title)) {
      observations += 1;
      if (!recipes.has(recipeUrl)) recipes.set(recipeUrl, { title, sourceUrl: recipeUrl });
    }
    if (!url.search && (/^\/category\/(\d+\/)?$/.test(url.pathname) || /^\/recipe(-[a-z\d-]+)?\.html$/.test(url.pathname))) {
      if (!recipeUrl && !listings.has(url.href)) listings.set(url.href, { url: url.href, label: plainText(title).replace(/(菜谱|做法)大全$/, '').slice(0, 80) });
    }
  }
  return { recipes: [...recipes.values()], listings: [...listings.values()], observations };
}

export function titleKey(title) {
  return decodeHTML(String(title)).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function aliasKey(title) {
  return titleKey(String(title).replace(/[（(](基础版|普通锅版)[）)]/g, '').replace(/番茄/g, '西红柿').replace(/炒蛋/g, '炒鸡蛋').replace(/鸡蛋炒西红柿/g, '西红柿炒鸡蛋'));
}

export function deduplicate(records, baseline) {
  const byUrl = new Map();
  let repeatedUrls = 0;
  for (const record of records) {
    const canonical = canonicalRecipeUrl(record.sourceUrl);
    if (!canonical || !titleKey(record.title)) continue;
    if (byUrl.has(canonical)) {
      repeatedUrls += 1;
      const previous = byUrl.get(canonical);
      previous.discoveredOn = [...new Set([...previous.discoveredOn, ...(record.discoveredOn || [])])];
      previous.sourceCategories = [...new Set([...previous.sourceCategories, ...(record.sourceCategories || [])])];
    } else byUrl.set(canonical, { ...record, sourceUrl: canonical, discoveredOn: record.discoveredOn || [], sourceCategories: record.sourceCategories || [] });
  }
  const references = baseline.map(record => ({ ...record, key: aliasKey(record.title), baseline: true }));
  const urlIndex = new Map(references.filter(record => record.sourceUrl).map(record => [canonicalRecipeUrl(record.sourceUrl) || record.sourceUrl, record]));
  const keyIndex = new Map(references.map(record => [record.key, record]));
  const exactDuplicates = [];
  const nearDuplicates = [];
  const candidates = [];
  for (const record of byUrl.values()) {
    const key = aliasKey(record.title);
    const sameUrl = urlIndex.get(record.sourceUrl);
    const exact = sameUrl || keyIndex.get(key);
    if (exact) {
      exactDuplicates.push({ ...record, reason: sameUrl ? 'existing_source_url' : exact.baseline ? 'existing_title_or_alias' : 'batch_title_or_alias', matches: [{ title: exact.title, sourceUrl: exact.sourceUrl, baseline: exact.baseline }] });
      continue;
    }
    const near = references.filter(reference => reference.key.length >= 3 && key.length >= 3 && (key.includes(reference.key) || reference.key.includes(key)));
    if (near.length) nearDuplicates.push({ ...record, reason: 'possible_dish_variant_requires_review', matches: near.slice(0, 10).map(reference => ({ title: reference.title, sourceUrl: reference.sourceUrl, baseline: reference.baseline })) });
    else candidates.push({ ...record, id: `discovery-${sha256(record.sourceUrl).slice(0, 16)}`, titleFingerprint: sha256(key), recordType: 'source_link_only', textLicense: 'not_granted', imageLicense: 'not_granted', autoImportAllowed: false, publicPublishingAllowed: false });
    const reference = { ...record, key, baseline: false };
    keyIndex.set(key, reference);
    references.push(reference);
  }
  return { candidates, exactDuplicates, nearDuplicates, repeatedUrls, uniqueUrls: byUrl.size };
}

export function retryAfterDate(value, now = Date.now()) {
  if (!value) return null;
  const millis = /^\d+$/.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(millis) ? new Date(Math.max(now, millis)).toISOString() : null;
}

export function blockReason(status, body = '') {
  if ([401, 403, 418, 429].includes(status)) return `http_${status}`;
  if (status >= 300 && status < 400) return 'redirect_requires_review';
  if (/_cf_chl_opt|cf-chl-|<title>\s*(just a moment|access denied)|<title>[^<]*(验证码|安全验证)|请完成验证后|访问过于频繁/i.test(body)) return 'access_challenge';
  if (status >= 500) return `http_${status}`;
  return null;
}

export async function limitedBody(response, maxBytes = MAX_BYTES) {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('response_too_large'); }
  const parts = [];
  let bytes = 0;
  if (response.body) for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('response_too_large');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString('utf8');
}

async function jsonFile(filename) { return JSON.parse(await readFile(filename, 'utf8')); }
async function atomicJson(filename, data) {
  const temp = `${filename}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(temp, filename);
}

async function baselineRecipes() {
  const cloud = await jsonFile(resolve(output, 'live-baseline.json'));
  if (!cloud.capturedAt || !Array.isArray(cloud.recipes)) throw new Error('A verified live-baseline.json is required');
  const staged = await jsonFile(resolve(root, 'artifacts/recipe-sources/candidates.json'));
  const seed = createSeed();
  return { capturedAt: cloud.capturedAt, cloudCount: cloud.recipes.length, stagedCount: staged.length, records: [
    ...cloud.recipes.map(recipe => ({ ...recipe, scope: 'current_cloud_family' })),
    ...staged.map(recipe => ({ title: recipe.title, sourceUrl: recipe.sourceUrl, scope: 'existing_offline_candidate' })),
    ...seed.recipes.map(recipe => ({ title: recipe.title, scope: 'bundled_example' })),
    ...communityPosts.flatMap(post => (post.recipes || []).map(recipe => ({ title: recipe.title, scope: 'bundled_example' }))),
  ] };
}

function enqueue(state, listing) {
  if (state.queue.length + Object.keys(state.pages).length >= 500) return;
  if (state.pages[listing.url] || state.queue.some(item => item.url === listing.url)) return;
  const url = safeUrl(listing.url, listing.url);
  if (url && !state.hosts[url.hostname]?.blocked) state.queue.push(listing);
}

function acceptPage(state, url, label, html, metadata) {
  const parsed = parseListing(html, url);
  state.pages[url] = { ...metadata, url, label, observations: parsed.observations, recipes: parsed.recipes };
  for (const listing of parsed.listings) enqueue(state, listing);
}

async function auditEvidence(filename) {
  const body = await readFile(resolve(output, 'evidence', filename), 'utf8');
  const headers = await readFile(resolve(output, 'evidence', filename.replace(/\.(txt|html)$/, '.headers')), 'utf8');
  const statuses = [...headers.matchAll(/^HTTP\/[^ ]+ (\d+)/gm)];
  const dates = [...headers.matchAll(/^date:\s*(.+)$/gim)];
  if (!statuses.length || !dates.length) throw new Error(`Missing HTTP audit headers: ${filename}`);
  return { body, status: Number(statuses.at(-1)[1]), accessedAt: new Date(dates.at(-1)[1].trim()).toISOString(), sha256: sha256(body), bytes: Buffer.byteLength(body), evidence: `evidence/${filename}` };
}

async function initialize() {
  const state = { version: 1, purpose: 'private_source_discovery_only', hosts: {}, pages: {}, queue: [], skipped: [], runHistory: [] };
  for (const site of sites) {
    const robots = await auditEvidence(`${site.host}-robots.txt`);
    if (robots.status !== 200 || !/user-agent:/i.test(robots.body)) throw new Error(`Unverified robots for ${site.host}`);
    const entry = await auditEvidence(`${site.prefix}.html`);
    state.hosts[site.host] = { robots: robots.body, robotsCheckedAt: robots.accessedAt, lastRequestAt: entry.accessedAt, blocked: blockReason(entry.status, entry.body), audit: { status: entry.status, accessedAt: entry.accessedAt, evidence: entry.evidence } };
    if (state.hosts[site.host].blocked) continue;
    if (!robotsPolicy(robots.body).allows(`https://${site.host}${site.entry}`)) throw new Error(`Entry disallowed: ${site.host}`);
    const { body, ...metadata } = entry;
    acceptPage(state, `https://${site.host}${site.entry}`, '首页', body, metadata);
  }
  return state;
}

export async function requestPage(url, host, { fetcher = fetch, wait = sleep, clock = Date.now, beforeRequest = async () => {} } = {}) {
  if (host.blocked) return { blocked: host.blocked, requested: false };
  const policy = robotsPolicy(host.robots);
  const robotsRequest = new URL(url).pathname === '/robots.txt';
  if (!robotsRequest && !policy.allows(url)) return { skipped: 'robots_disallow', requested: false };
  const delay = Math.max(0, Date.parse(host.lastRequestAt || 0) + policy.delayMs - clock());
  if (delay > 0) await wait(delay);
  host.lastRequestAt = new Date(clock()).toISOString();
  const startedAt = host.lastRequestAt;
  await beforeRequest();
  try {
    const response = await fetcher(url, { headers: { 'User-Agent': USER_AGENT, Accept: robotsRequest ? 'text/plain' : 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const body = await limitedBody(response);
    const blocked = blockReason(response.status, body);
    const metadata = { url, status: response.status, startedAt, accessedAt: new Date(clock()).toISOString(), bytes: Buffer.byteLength(body), sha256: sha256(body), retryAfter: retryAfterDate(response.headers.get('retry-after'), clock()), contentType: response.headers.get('content-type'), redirectLocation: response.headers.get('location') };
    if (blocked) { host.blocked = blocked; host.retryAfter = metadata.retryAfter; }
    else if (!response.ok || !new RegExp(robotsRequest ? '^text/plain' : '^(text/html|application/xhtml\\+xml)', 'i').test(metadata.contentType || '')) {
      if (![404, 410].includes(response.status)) host.blocked = 'unexpected_http_or_content_type';
      return { requested: true, blocked: host.blocked, error: 'unexpected_http_or_content_type', metadata };
    }
    return { requested: true, blocked, body: blocked ? undefined : body, metadata };
  } catch (error) {
    host.blocked = error.message || 'request_failed';
    return { requested: true, blocked: host.blocked, metadata: { url, startedAt, accessedAt: new Date(clock()).toISOString(), error: host.blocked } };
  }
}

async function exportResults(state, baseline) {
  const pages = Object.values(state.pages);
  const records = pages.flatMap(page => page.recipes.map(recipe => ({ ...recipe, source: sites.find(site => new URL(recipe.sourceUrl).hostname === site.host).name, accessedAt: page.accessedAt, discoveredOn: [page.url], sourceCategories: page.label === '首页' ? [] : [page.label] })));
  const result = deduplicate(records, baseline.records);
  const report = {
    generatedAt: new Date().toISOString(), scope: 'private_metadata_and_source_links_not_importable_recipes',
    pages: pages.length, observedRecipeAnchors: pages.reduce((sum, page) => sum + page.observations, 0),
    uniqueSourceUrls: result.uniqueUrls, repeatedSourceUrlsAcrossPages: result.repeatedUrls,
    sourceLinkCandidates: result.candidates.length, exactDuplicates: result.exactDuplicates.length,
    duplicateOfBaseline: result.exactDuplicates.filter(record => record.matches.some(match => match.baseline)).length,
    nearDuplicatesHeldForReview: result.nearDuplicates.length,
    baseline: { capturedAt: baseline.capturedAt, cloudRecipes: baseline.cloudCount, priorOfflineCandidates: baseline.stagedCount, totalReferenceRecords: baseline.records.length },
    remainingListingPages: state.queue.length, pausedListingPages: state.queue.filter(item => state.hosts[new URL(item.url).hostname]?.blocked).length, skippedByRobots: state.skipped.filter(item => item.reason === 'robots_disallow').length,
    hosts: Object.fromEntries(Object.entries(state.hosts).map(([host, data]) => [host, { blocked: data.blocked || null, delayMs: robotsPolicy(data.robots).delayMs, retryAfter: data.retryAfter || null, audit: data.audit, robotsCheckedAt: data.robotsCheckedAt }])),
    fullRecipesCollected: 0, downloadedImages: 0, databaseWrites: 0,
    limitation: '只采集列表名称和来源链接。标题去重不能证明配方内容唯一；疑似同菜变体隔离复核。未获图文再发布授权，不自动导入或公开。',
    runs: state.runHistory,
  };
  await atomicJson(resolve(output, 'source-links.json'), result.candidates);
  await atomicJson(resolve(output, 'duplicates.json'), result.exactDuplicates);
  await atomicJson(resolve(output, 'near-duplicates.json'), result.nearDuplicates);
  await atomicJson(resolve(output, 'report.json'), report);
  return report;
}

export async function run(argv = process.argv.slice(2)) {
  const allowed = new Set(['--offline', '--max-pages']);
  for (let index = 0; index < argv.length; index += 1) {
    if (!allowed.has(argv[index])) throw new Error(`Unknown argument: ${argv[index]}`);
    if (argv[index] === '--max-pages') index += 1;
  }
  const cap = argv.includes('--max-pages') ? Number(argv[argv.indexOf('--max-pages') + 1]) : 40;
  if (!Number.isInteger(cap) || cap < 1 || cap > 60) throw new Error('--max-pages must be 1..60; bounded runs only');
  const baseline = await baselineRecipes();
  await mkdir(output, { recursive: true });
  const lockPath = resolve(output, 'crawl.lock');
  const lock = await open(lockPath, 'wx').catch(() => { throw new Error('Crawler locked. Do not start concurrent copies. Verify the owning process before removing a stale lock.'); });
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  let state;
  try {
    try { state = await jsonFile(resolve(output, 'checkpoint.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = await initialize(); }
    if (state.version !== 1) throw new Error('Unsupported checkpoint version');
    const runEntry = { startedAt: new Date().toISOString(), requestCap: cap, offline: argv.includes('--offline'), requests: 0, successfulPages: 0 };
    state.runHistory.push(runEntry);
    await atomicJson(resolve(output, 'checkpoint.json'), state);
    if (!runEntry.offline) {
      for (const [hostName, host] of Object.entries(state.hosts)) {
        if (host.blocked || Date.now() - Date.parse(host.robotsCheckedAt) < 86400000) continue;
        const response = await requestPage(`https://${hostName}/robots.txt`, host, { beforeRequest: () => atomicJson(resolve(output, 'checkpoint.json'), state) });
        if (response.requested) runEntry.requests += 1;
        if (response.metadata) await appendFile(resolve(output, 'access-log.jsonl'), `${JSON.stringify(response.metadata)}\n`);
        if (response.body && /user-agent:/i.test(response.body)) { host.robots = response.body; host.robotsCheckedAt = response.metadata.accessedAt; }
        else host.blocked ||= 'robots_refresh_failed';
        await atomicJson(resolve(output, 'checkpoint.json'), state);
      }
      while (state.queue.length && runEntry.requests < cap) {
        const nextIndex = state.queue.findIndex(item => !state.hosts[new URL(item.url).hostname]?.blocked);
        if (nextIndex < 0) break;
        const next = state.queue[nextIndex];
        const host = state.hosts[new URL(next.url).hostname];
        const response = await requestPage(next.url, host, { beforeRequest: () => atomicJson(resolve(output, 'checkpoint.json'), state) });
        if (response.requested) runEntry.requests += 1;
        if (response.metadata) await appendFile(resolve(output, 'access-log.jsonl'), `${JSON.stringify(response.metadata)}\n`);
        state.queue.splice(nextIndex, 1);
        if (response.body && !response.error) {
          acceptPage(state, next.url, next.label, response.body, response.metadata);
          runEntry.successfulPages += 1;
        } else state.skipped.push({ ...next, reason: response.blocked || response.skipped || response.error });
        await atomicJson(resolve(output, 'checkpoint.json'), state);
        await exportResults(state, baseline);
        console.log(JSON.stringify({ page: next.url, status: response.metadata?.status, reason: response.blocked || response.skipped || response.error, fetched: runEntry.successfulPages, remaining: state.queue.length }));
      }
    }
    runEntry.finishedAt = new Date().toISOString();
    await atomicJson(resolve(output, 'checkpoint.json'), state);
    const report = await exportResults(state, baseline);
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run().catch(error => { console.error(error.message); process.exitCode = 1; });
