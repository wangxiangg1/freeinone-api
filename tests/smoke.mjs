import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const main = fs.readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source block: ${start}`);
  return source.slice(from, to);
}

function loadTypeScriptFunctions(source, names) {
  const javascript = stripTypeScriptTypes(source, { mode: 'strip' });
  return new Function(`${javascript}\nreturn { ${names.join(', ')} };`)();
}

const normalizeSource = between(main, 'function stringArray', 'async function getRawConfig');
const { normalizeChannel, normalizeConfigShape, expandRuntimeChannels } = loadTypeScriptFunctions(
  normalizeSource,
  ['normalizeChannel', 'normalizeConfigShape', 'expandRuntimeChannels']
);

const legacy = normalizeConfigShape({
  accessKeys: ['gateway-key'],
  channels: [{ id: 'old', name: 'Old', baseUrl: 'https://example.com/v1', apiKey: 'upstream', enabled: true }]
});
assert.equal(legacy.schemaVersion, 3);
assert.equal(legacy.channels.length, 1);
assert.equal(legacy.channels[0].protocol, 'openai');
assert.deepEqual(legacy.channels[0].apiKeys.map(item => item.key), ['upstream']);

const group = normalizeChannel({
  id: 'gemini', protocol: 'gemini', baseUrl: 'https://example.com', weight: 10, enabled: true,
  apiKeys: [
    { id: 'a', key: 'key-a', enabled: true },
    { id: 'b', key: 'key-b', enabled: true },
    { id: 'dupe', key: 'key-b', enabled: true }
  ]
}, 0);
const runtime = expandRuntimeChannels({ channels: [group] }, 'gemini');
assert.equal(runtime.length, 2);
assert.equal(expandRuntimeChannels({ channels: [group] }, 'openai').length, 0);
assert.deepEqual(runtime.map(item => item.apiKey), ['key-a', 'key-b']);
assert.notEqual(runtime[0].id, runtime[1].id);

const routingSource = main.slice(main.indexOf('function parseGeminiModelPath'));
const routing = loadTypeScriptFunctions(routingSource, [
  'parseGeminiModelPath', 'rewriteGeminiModelPath', 'getTargetUrl',
  'getOriginalModelForChannel', 'channelSupportsModel', 'selectChannelWeightedStateless'
]);
assert.deepEqual(routing.parseGeminiModelPath('/v1beta/models/gm/gemini-2.5-pro:generateContent'), {
  model: 'gm/gemini-2.5-pro', action: ':generateContent'
});
assert.equal(routing.rewriteGeminiModelPath('gemini-2.5-pro', ':streamGenerateContent'), '/v1beta/models/gemini-2.5-pro:streamGenerateContent');
assert.equal(routing.getTargetUrl('https://example.com/v1beta', '/v1beta/models'), 'https://example.com/v1beta/models');
assert.equal(routing.getTargetUrl('https://example.com', '/v1beta/files?x=1'), 'https://example.com/v1beta/files?x=1');
assert.equal(routing.getOriginalModelForChannel({ modelPrefix: 'gm' }, 'gm/gemini-2.5-pro'), 'gemini-2.5-pro');
assert.equal(routing.channelSupportsModel({ modelPrefix: 'gm', filterMode: 'none', fetchedModels: [], models: [] }, 'gm/anything'), true);

const counts = { a: 0, b: 0 };
for (let index = 0; index < 50000; index++) {
  counts[routing.selectChannelWeightedStateless([{ id: 'a', weight: 10 }, { id: 'b', weight: 10 }]).id]++;
}
assert.ok(Math.abs(counts.a - counts.b) < 1500, `unexpected distribution: ${JSON.stringify(counts)}`);

const parserSource = between(admin, 'function parseApiKeysInput', 'function syncProtocolUI');
const { parseApiKeysInput } = new Function(`${parserSource}\nreturn { parseApiKeysInput };`)();
assert.deepEqual(parseApiKeysInput('key-a\nkey-b\nkey-a'), ['key-a', 'key-b']);
assert.deepEqual(parseApiKeysInput('key-a,key-b;key-c'), ['key-a', 'key-b', 'key-c']);
assert.deepEqual(parseApiKeysInput('["key-a", "key-b"]'), ['key-a', 'key-b']);
assert.deepEqual(parseApiKeysInput('"key-a"\n\'key-b\''), ['key-a', 'key-b']);

for (const required of [
  'app.all("/v1beta/*"',
  "request.headers.get('x-goog-api-key')",
  "url.searchParams.get('key')",
  "targetUrl.searchParams.delete('key')",
  "headers.set('x-goog-api-key', selectedChannel.apiKey)",
  "headers.delete('Authorization')",
  'channel-${selectedChannel.parentIndex + 1}-key-${selectedChannel.keyIndex + 1}'
]) assert.ok(main.includes(required), `missing Gemini behavior: ${required}`);

console.log('All source-level routing and migration tests passed.');
