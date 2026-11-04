#!/usr/bin/env node
// Site test suite: builds the site, serves it, drives headless Chromium over
// CDP and checks structure, SEO, links, interactions and layout.
//
// Usage: node tests/run.mjs   (or: npm test)
// Requires: hugo, chromium. No npm dependencies.

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const CHROME = process.env.CHROME || 'chromium';

const results = [];
let currentPage = '';

function pass(name, detail = '') {
  results.push({ page: currentPage, name, ok: true, detail: String(detail) });
}
function fail(name, detail = '') {
  results.push({ page: currentPage, name, ok: false, detail: String(detail) });
}
function check(name, ok, detail = '') {
  ok ? pass(name, detail) : fail(name, detail);
}

// ---------------------------------------------------------------- CDP client

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.waiters = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        const list = this.waiters.get(msg.method) || [];
        this.waiters.delete(msg.method);
        list.forEach((fn) => fn(msg.params));
      }
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('websocket failed'));
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const list = this.waiters.get(method) || [];
      list.push(resolve);
      this.waiters.set(method, list);
    });
  }

  close() {
    this.ws.close();
  }
}

async function evaluate(cdp, fn, ...args) {
  const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
}

async function goto(cdp, url) {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(15000).then(() => { throw new Error('load timeout ' + url); })]);
}

// ------------------------------------------------------------ page assertions

async function pageChecks() {
  const out = [];
  const t = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail: String(detail) });
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));

  t('title', document.title.trim().length > 0, document.title);
  const desc = q('meta[name="description"]');
  t('meta description', desc && desc.content.trim().length > 40, desc ? desc.content.length : 'missing');
  t('description <= 160 chars', desc && desc.content.length <= 160, desc ? desc.content.length : 0);
  const canonical = q('link[rel="canonical"]');
  t('canonical', canonical && /^https?:\/\//.test(canonical.href), canonical?.href);
  t('og:title', !!q('meta[property="og:title"]'));
  t('og:description', !!q('meta[property="og:description"]'));
  t('og:url', !!q('meta[property="og:url"]'));
  t('og:image', !!q('meta[property="og:image"]'), q('meta[property="og:image"]')?.content);
  t('twitter:card', !!q('meta[name="twitter:card"]'));
  t('favicon', !!q('link[rel~="icon"]'));
  t('html lang', document.documentElement.lang.length >= 2, document.documentElement.lang);
  t('exactly one h1', qa('h1').length === 1, qa('h1').length);

  const imgs = qa('img').filter((i) => !i.classList.contains('lightbox-img') && i.getAttribute('src'));
  t('images have alt', imgs.every((i) => i.hasAttribute('alt')), `${imgs.length} img`);
  imgs.forEach((i) => (i.loading = 'eager'));
  await Promise.all(imgs.map((i) => i.decode().catch(() => null)));
  const broken = imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src);
  t('images load', broken.length === 0, broken.join(', '));

  t('stylesheet applied', document.styleSheets.length > 0, document.styleSheets.length);

  const ids = new Set(qa('[id]').map((e) => e.id));
  const anchors = qa('a[href^="#"]')
    .map((a) => a.getAttribute('href').slice(1))
    .filter(Boolean);
  t('in-page anchors resolve', anchors.every((a) => ids.has(a)), anchors.filter((a) => !ids.has(a)).join(', '));

  const emptyLinks = qa('a').filter((a) => !a.getAttribute('href') || a.getAttribute('href') === '#');
  t('no empty links', emptyLinks.length === 0, emptyLinks.length);

  const allIds = qa('[id]').map((e) => e.id);
  const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i);
  t('no duplicate ids', dupes.length === 0, [...new Set(dupes)].join(', '));

  const levels = qa('h1, h2, h3, h4, h5, h6').map((h) => Number(h.tagName[1]));
  let badHeading = '';
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) {
      badHeading = `h${levels[i - 1]} -> h${levels[i]}`;
      break;
    }
  }
  t('heading order skips nothing', !badHeading, badHeading);

  t('canonical path matches page', new URL(canonical.href).pathname === location.pathname, new URL(canonical.href).pathname + ' vs ' + location.pathname);
  t('og:url matches canonical', q('meta[property="og:url"]').content === canonical.href);

  const unsafe = qa('a[target="_blank"]').filter((a) => !/noopener|noreferrer/.test(a.rel));
  t('target=_blank links are noopener', unsafe.length === 0, unsafe.map((a) => a.href).join(', '));

  return out;
}

function assetPaths() {
  return Array.from(document.querySelectorAll('img[src], link[rel="stylesheet"][href], script[src]'))
    .map((el) => el.getAttribute('src') || el.getAttribute('href'))
    .filter((h) => h && h.startsWith('/'));
}

function mobileChecks() {
  const doc = document.documentElement;
  const vw = window.innerWidth;
  const overflow = doc.scrollWidth - vw;
  const scrollable = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
    }
    return false;
  };
  const wide = Array.from(document.querySelectorAll('body *'))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      return r.right > vw + 2 && !scrollable(el);
    })
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
  const nav = Array.from(document.querySelectorAll('.site-nav a')).map((a) => Math.round(a.getBoundingClientRect().height));
  const brand = document.querySelector('.brand')?.getBoundingClientRect();
  const navBox = document.querySelector('.site-nav')?.getBoundingClientRect();
  const overlap = !!(brand && navBox && brand.right > navBox.left + 1 && brand.left < navBox.right - 1 && brand.bottom > navBox.top + 1 && brand.top < navBox.bottom - 1);
  return { overflow, wide, nav, overlap, vw };
}

async function lightboxChecks() {
  const dialog = document.getElementById('lightbox');
  const before = dialog.open;
  document.querySelector('a.zoom-link').click();
  const img = dialog.querySelector('.lightbox-img');
  await img.decode().catch(() => null);
  return {
    before,
    open: dialog.open,
    src: img.src,
    alt: img.alt,
    loaded: img.complete && img.naturalWidth > 0,
  };
}

function dialogState() {
  return document.getElementById('lightbox').open;
}

function copyTexts() {
  const strip = (sel) => {
    const code = document.querySelector(sel + ' pre code');
    return code ? codeText(code) : null;
  };
  return {
    xml: strip('[data-lang="xml"]'),
    cmd: strip('[data-lang="cmd"]'),
    powershell: strip('[data-lang="powershell"]'),
    textBlockHasButton: !!document.querySelector('[data-lang="text"] .copy-btn'),
    promptSelectable: getComputedStyle(document.querySelector('.prompt')).userSelect,
  };
}

function animationState() {
  const main = document.querySelector('main');
  const cs = getComputedStyle(main);
  return { name: cs.animationName, duration: cs.animationDuration };
}

function postStructure() {
  return {
    cover: !!document.querySelector('.post-cover'),
    toc: document.querySelectorAll('.toc a').length,
    tags: document.querySelectorAll('.tags a').length,
    back: !!document.querySelector('.back-link'),
    title: document.querySelector('.post h1')?.textContent || '',
  };
}

function internalLinks() {
  return Array.from(document.querySelectorAll('a[href]'))
    .map((a) => a.getAttribute('href'))
    .filter((h) => h.startsWith('/') && !h.startsWith('//'));
}

// ------------------------------------------------------------------- harness

function walkHtml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkHtml(full));
    else if (entry.name === 'index.html') out.push(full);
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function serve(dir) {
  const server = http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost/').pathname);
    } catch {
      pathname = (req.url || '/').split('?')[0];
    }
    let file = path.join(dir, pathname);
    if (pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        fs.readFile(path.join(dir, '404.html'), (e2, nf) => {
          res.writeHead(404, { 'content-type': MIME['.html'] }).end(nf || 'not found');
        });
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launchChrome() {
  const port = 9000 + Math.floor(Math.random() * 900);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-test-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return { proc, userDir, wsUrl: page.webSocketDebuggerUrl };
    } catch {}
    await sleep(100);
  }
  proc.kill();
  throw new Error('chromium did not start');
}

// ---------------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();

  const build = spawnSync('hugo', ['--minify', '--cleanDestinationDir'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const buildErrors = (build.stderr || '')
    .split('\n')
    .filter((l) => /ERROR|WARN/.test(l))
    .join('\n')
    .trim();
  currentPage = 'build';
  check('hugo build exits 0', build.status === 0, build.status);
  check('hugo build has no warnings', buildErrors === '', buildErrors);

  const server = await serve(PUBLIC);
  const base = `http://127.0.0.1:${server.address().port}`;
  const { proc, userDir, wsUrl } = await launchChrome();
  const cdp = await CDP.connect(wsUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const consoleErrors = [];
  cdp.waiters.set('Runtime.exceptionThrown', [
    (p) => consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text),
  ]);

  const routes = walkHtml(PUBLIC)
    .filter((f) => !path.basename(path.dirname(f)).startsWith('.'))
    .map((f) => {
      const rel = path.relative(PUBLIC, path.dirname(f)).replace(/\\/g, '/');
      return rel ? '/' + rel + '/' : '/';
    })
    .sort();

  const linkSet = new Set();
  const assetSet = new Set();

  for (const route of routes) {
    currentPage = route;
    await goto(cdp, base + route);

    const checks = await evaluate(cdp, pageChecks);
    for (const c of checks) check(c.name, c.ok, c.detail);

    for (const href of await evaluate(cdp, internalLinks)) linkSet.add(href);
    for (const src of await evaluate(cdp, assetPaths)) if (!src.startsWith('/style.')) assetSet.add(src);

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true,
      screenWidth: 375,
      screenHeight: 812,
    });
    const widthNow = () => evaluate(cdp, () => window.innerWidth);
    for (let i = 0; i < 20 && (await widthNow()) !== 375; i++) await sleep(50);
    const mobile = await evaluate(cdp, mobileChecks);
    check('viewport emulation applied', mobile.vw === 375, `innerWidth ${mobile.vw}`);
    check('no horizontal overflow at 375px', mobile.overflow <= 1, `overflow ${mobile.overflow}px`);
    check('nothing spills out of the viewport', mobile.wide.length === 0, mobile.wide.join(' '));
    check('nav links are tappable', mobile.nav.every((h) => h >= 36), mobile.nav.join(','));
    check('brand and nav do not overlap', !mobile.overlap);
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    const anim = await evaluate(cdp, animationState);
    check('entrance animation present', anim.name === 'page-in', `${anim.name} ${anim.duration}`);
  }

  // Interaction tests on the post page
  const postRoute = routes.find((r) => r.includes('/posts/msbuild')) || routes[0];
  currentPage = postRoute + ' (interaction)';
  await goto(cdp, base + postRoute);

  const lb = await evaluate(cdp, lightboxChecks);
  check('lightbox opens on image click', lb.open && !lb.before, JSON.stringify(lb));
  check('lightbox shows the full image', lb.loaded && /\.(webp|png|jpe?g)$/.test(lb.src), lb.src);
  check('lightbox keeps the alt text', lb.alt.length > 0, lb.alt);

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(150);
  check('lightbox closes on Escape', (await evaluate(cdp, dialogState)) === false);

  const byButton = await evaluate(cdp, () => {
    document.querySelector('a.zoom-link').click();
    const opened = document.getElementById('lightbox').open;
    document.querySelector('.lightbox-close').click();
    return { opened, after: document.getElementById('lightbox').open };
  });
  check('lightbox closes with the × button', byButton.opened && !byButton.after, JSON.stringify(byButton));

  const texts = await evaluate(cdp, copyTexts);
  const md = fs.readFileSync(
    path.join(ROOT, 'content/posts/msbuild-bypasses-security-controls/index.md'),
    'utf8'
  );
  const fence = (lang) => {
    const m = md.match(new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n```'));
    return m ? m[1] : null;
  };
  check('copy: xml block matches source', texts.xml === fence('xml'), `${texts.xml?.split('\n').length} lines`);
  check('copy: cmd block matches source', texts.cmd === fence('cmd'), JSON.stringify(texts.cmd));
  check('copy: output/text block has no button', texts.textBlockHasButton === false);
  check('prompt is not selectable', texts.promptSelectable === 'none', texts.promptSelectable);

  const structure = await evaluate(cdp, postStructure);
  check('post shows its cover', structure.cover);
  check('post shows a table of contents', structure.toc >= 5, `${structure.toc} links`);
  check('post shows its tags', structure.tags >= 1, `${structure.tags} tags`);
  check('post has a back link', structure.back);
  check('post title renders', structure.title.length > 10, structure.title);

  // Link integrity
  currentPage = 'links';
  const failures = [];
  for (const href of [...linkSet].sort()) {
    const res = await fetch(base + href, { redirect: 'manual' });
    if (res.status !== 200) failures.push(`${href} -> ${res.status}`);
  }
  check(`internal links resolve (${linkSet.size})`, failures.length === 0, failures.join(', '));

  // Asset integrity
  currentPage = 'assets';
  const assetFailures = [];
  for (const src of [...assetSet].sort()) {
    const res = await fetch(base + src, { redirect: 'manual' });
    if (res.status !== 200) assetFailures.push(`${src} -> ${res.status}`);
  }
  check(`assets resolve (${assetSet.size})`, assetFailures.length === 0, assetFailures.join(', '));

  // Theme and motion preferences
  currentPage = 'theme';
  await goto(cdp, base + '/');
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  const lightBg = await evaluate(cdp, () => getComputedStyle(document.body).backgroundColor);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  const darkBg = await evaluate(cdp, () => getComputedStyle(document.body).backgroundColor);
  check('dark scheme changes background', darkBg !== lightBg, `${lightBg} -> ${darkBg}`);

  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  const motion = await evaluate(cdp, () => getComputedStyle(document.querySelector('main')).animationName);
  check('reduced motion disables animation', motion === 'none', motion);
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });

  // 404
  currentPage = '404';
  const notFound = await fetch(base + '/this-page-does-not-exist/');
  const body = await notFound.text();
  check('unknown route returns 404', notFound.status === 404, notFound.status);
  check('404 page has no cat image', !/404-cat|nf-cat/.test(body), (body.match(/404-cat|nf-cat/g) || []).join(','));
  check('404 page is noindex', /name=["']?robots["']?[^>]*content=["']?noindex/.test(body), body.slice(0, 200));

  // robots + sitemap
  currentPage = 'robots.txt';
  const robots = await (await fetch(base + '/robots.txt')).text();
  check('robots.txt references sitemap', /Sitemap: http/.test(robots), robots.trim());

  currentPage = 'sitemap.xml';
  const sitemap = await (await fetch(base + '/sitemap.xml')).text();
  check('sitemap is xml', sitemap.startsWith('<?xml'));
  check('sitemap lists about page', sitemap.includes('/about/'));
  check('sitemap has no rss', !sitemap.includes('index.xml'));

  currentPage = 'console';
  check('no JS exceptions', consoleErrors.length === 0, consoleErrors.join(' | '));

  cdp.close();
  proc.kill();
  server.close();
  await sleep(300);
  try {
    fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}

  // ---------------------------------------------------------------- report

  const failed = results.filter((r) => !r.ok);
  const byPage = new Map();
  for (const r of results) {
    if (!byPage.has(r.page)) byPage.set(r.page, []);
    byPage.get(r.page).push(r);
  }

  for (const [page, list] of byPage) {
    const bad = list.filter((r) => !r.ok);
    const mark = bad.length ? 'FAIL' : ' ok ';
    console.log(`[${mark}] ${page} (${list.length - bad.length}/${list.length})`);
    for (const r of bad) console.log(`         ✗ ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }

  const ms = Date.now() - t0;
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed (${ms} ms)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('test runner crashed:', err);
  process.exit(2);
});
