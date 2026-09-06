import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const index=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const vercel=JSON.parse(fs.readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));

test('human page has visible visitor counter',()=>assert.match(index,/Visitors:/));
test('human page hides developer API block',()=>assert.doesNotMatch(index,/Direct agent API/));
test('human page hides visible discovery link list',()=>assert.doesNotMatch(index,/class="links/));
test('human page advertises ARD invisibly in head',()=>assert.match(index,/<link rel="ard"/));
test('human page advertises llms invisibly in head',()=>assert.match(index,/rel="describedby" href="\/llms\.txt"/));
test('human page advertises OpenAPI invisibly in head',()=>assert.match(index,/rel="service-desc" href="\/openapi\.json"/));
test('human page advertises JSON feed invisibly in head',()=>assert.match(index,/application\/feed\+json/));
test('Vercel routes canonical ARD',()=>assert.ok(vercel.rewrites.some(r=>r.source==='/.well-known/ard.json')));
test('Vercel routes legacy ARD alias',()=>assert.ok(vercel.rewrites.some(r=>r.source==='/.well-known/ai-catalog.json')));
test('Vercel routes agents files',()=>assert.ok(vercel.rewrites.some(r=>r.source==='/agents.txt')&&vercel.rewrites.some(r=>r.source==='/agents.json')));
test('Vercel routes API catalog',()=>assert.ok(vercel.rewrites.some(r=>r.source==='/.well-known/api-catalog')));
test('Vercel routes markdown thread alternative',()=>assert.ok(vercel.rewrites.some(r=>r.source==='/thread/:id.md')));
test('Vercel config has no explicit function runtime override',()=>assert.equal(vercel.functions,undefined));
