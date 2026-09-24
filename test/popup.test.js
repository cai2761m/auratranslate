const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const Core = require('../src/shared.js');
const html = fs.readFileSync(require.resolve('../popup/popup.html'), 'utf8');
const script = fs.readFileSync(require.resolve('../popup/popup.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function popup(t, values = {}, options = {}) {
  const dom = new JSDOM(html, {runScripts:'outside-only', url:'https://extension.test/popup.html'});
  t.after(() => dom.window.close());
  const settings = {...Core.DEFAULT_SETTINGS, ...values};
  const messages = [];
  const runtime = {getManifest: () => ({version:'0.3.12'}), openOptionsPage: () => { options.opened = true; }};
  dom.window.YTBTCore = Core;
  dom.window.chrome = {runtime, storage:{local:{
    get: (_, callback) => callback(settings),
    set: (patch, callback) => {
      if(options.saveError) runtime.lastError = {message:'Storage unavailable'};
      else Object.assign(settings,patch);
      callback(); delete runtime.lastError;
    }
  }}, tabs:{
    query: (_, callback) => callback([{id:4,url:options.url || 'https://docs.example.org/guide'}]),
    sendMessage: (id, message, frame, callback) => {
      messages.push({id,...message,...frame});
      if(options.disconnected) runtime.lastError = {message:'Receiving end does not exist'};
      callback(options.disconnected ? undefined : {ok:true,mode:options.running ? 'translating':'idle'});
      delete runtime.lastError;
    }
  }};
  dom.window.eval(script);
  await tick();
  return {window:dom.window, $:(selector) => dom.window.document.querySelector(selector),settings,messages};
}

test('popup restores language, concrete AI model and saved modes, and expands more controls', async (t) => {
  const { $, settings } = await popup(t, {translationModel:'my-model',immersiveDisplayMode:'translation'});
  assert.equal($('#source-language').value,'auto');
  assert.equal($('#target-language').value,'zh-CN');
  assert.match($('#translation-service option').textContent,/my-model/);
  assert.equal($('#version').textContent,'v0.3.12');
  assert.equal($('#more-panel').hidden,true);
  $('#more-toggle').click();
  assert.equal($('#more-panel').hidden,false);
  assert.equal($('#more-toggle').getAttribute('aria-expanded'),'true');
  assert.equal($('#mode-icon').textContent,'A');
  $('#display-mode-toggle').click();
  await tick();
  assert.equal(settings.immersiveDisplayMode,'bilingual');
  assert.equal($('[data-display-mode="bilingual"]').getAttribute('aria-pressed'),'true');
});

test('popup saves webpage preferences independently from subtitles and targets only the top frame', async (t) => {
  const { $,window,settings,messages } = await popup(t);
  for(const [selector,value] of [['#source-language','ja'],['#target-language','en'],['#translation-service','google-free']]) {
    $(selector).value=value;
    $(selector).dispatchEvent(new window.Event('change'));
    await tick();
  }
  assert.equal(settings.immersiveSourceLanguage,'ja');
  assert.equal(settings.immersiveTargetLanguage,'en');
  assert.equal(settings.immersiveTranslationService,'google-free');
  assert.equal(settings.sourceLanguage,'en');
  assert.equal(settings.targetLanguage,'zh-CN');
  $('#translate-page').click(); await tick();
  assert.equal(messages.at(-1).type,'IMMERSIVE_POPUP_TRANSLATE');
  assert.equal(messages.at(-1).id,4);
  assert.equal(messages.at(-1).frameId,0);
});

test('site rules preserve other websites and inherit removes only the current hostname', async (t) => {
  const { $,settings } = await popup(t,{immersiveSiteRules:{'other.org':'never'}});
  $('[data-site-rule="always"]').click(); await tick();
  assert.equal(settings.immersiveSiteRules['docs.example.org'],'always');
  assert.equal(settings.immersiveSiteRules['other.org'],'never');
  $('[data-site-rule="inherit"]').click(); await tick();
  assert.equal(settings.immersiveSiteRules['docs.example.org'],undefined);
  assert.equal(settings.immersiveSiteRules['other.org'],'never');
});

test('restricted and disconnected pages explain disabled translation while keeping settings usable', async (t) => {
  for(const options of [{url:'chrome://extensions'}, {disconnected:true}]) {
    const {$} = await popup(t,{},options);
    assert.equal($('#translate-page').disabled,true);
    assert.equal($('#source-language').disabled,false);
    assert.match($('#status').textContent,/普通网页|刷新/);
  }
});

test('failed saves roll back selected values and surface a recoverable error', async (t) => {
  const {$,window,settings} = await popup(t,{}, {saveError:true});
  $('#translation-service').value='google-free';
  $('#translation-service').dispatchEvent(new window.Event('change'));
  await tick();
  assert.equal(settings.immersiveTranslationService,'ai');
  assert.equal($('#translation-service').value,'ai');
  assert.match($('#status').textContent,/保存失败/);
  assert.equal($('#translation-service').disabled,false);
});

test('running translations disable duplicate starts and language changes but retain mode switching', async (t) => {
  const {$} = await popup(t,{}, {running:true});
  assert.equal($('#translate-page').disabled,true);
  assert.equal($('#source-language').disabled,true);
  assert.equal($('#display-mode-toggle').disabled,false);
});
