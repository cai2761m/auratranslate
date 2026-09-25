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
  assert.equal($('#translation-service optgroup').label,'自定义供应商');
  assert.equal($('#translation-model').value,'my-model');
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
  const {$} = await popup(t,{translationModel:'my-model'}, {running:true});
  assert.equal($('#translate-page').disabled,true);
  assert.equal($('#source-language').disabled,true);
  assert.equal($('#translation-model').disabled,true);
  assert.equal($('#display-mode-toggle').disabled,false);
});

const catalog = {
  translationServices: [
    {id:'alpha',name:'供应商 A',baseUrl:'https://alpha.test/v1',apiKey:'key-a',models:[{id:'fast',displayName:'快速'},{id:'accurate'}]},
    {id:'beta',name:'供应商 B',baseUrl:'https://beta.test/v1',apiKey:'key-b',models:[{id:'other'}]},
    {id:'empty',name:'待配置',models:[]}
  ],
  translationServiceId:'alpha',translationModelId:'fast',translationJsonResponse:false
};
async function change(ui, selector, value) {
  ui.$(selector).value = value;
  ui.$(selector).dispatchEvent(new ui.window.Event('change'));
  await tick();
}

test('popup switches provider and model used by webpage requests without changing subtitle selection', async (t) => {
  const ui = await popup(t,catalog);
  assert.equal(ui.$('#translation-service').value,'service:alpha');
  assert.equal(ui.$('#translation-model option').textContent,'fast · 快速');
  await change(ui,'#translation-model','accurate');
  let config = Core.resolveTranslationConfig(ui.settings,'immersive');
  assert.equal(config.model,'accurate');
  assert.equal(config.apiKey,'key-a');
  assert.equal(config.useJsonResponseFormat,false);
  assert.equal(Core.resolveTranslationConfig(ui.settings).model,'fast');
  await change(ui,'#translation-service','service:beta');
  config = Core.resolveTranslationConfig(ui.settings,'immersive');
  assert.equal(config.apiKey,'key-b');
  assert.equal(config.chatCompletionsUrl,'https://beta.test/v1/chat/completions');
  assert.equal(config.model,'other');
  assert.equal(ui.$('#translation-model').options.length,1);
  assert.equal(ui.settings.immersiveTranslationModel,'other');
  assert.equal(Core.resolveTranslationConfig(ui.settings).apiKey,'key-a');
  const reopened = await popup(t,ui.settings);
  assert.equal(reopened.$('#translation-service').value,'service:beta');
  assert.equal(reopened.$('#translation-model').value,'other');
  assert.ok(ui.messages.every(message => message.type === 'IMMERSIVE_POPUP_STATUS'));
});

test('Google services hide models and returning to the custom provider keeps its model', async (t) => {
  const ui = await popup(t,{...catalog,immersiveTranslationServiceId:'alpha',immersiveTranslationModelId:'accurate'});
  for (const service of ['google-free']) {
    await change(ui,'#translation-service',service);
    assert.equal(ui.$('#model-field').hidden,true);
    assert.equal(ui.$('#translation-model').disabled,true);
  }
  await change(ui,'#translation-service','service:alpha');
  assert.equal(ui.$('#model-field').hidden,false);
  assert.equal(ui.$('#translation-model').value,'accurate');
});

test('empty catalogs explain how to add a model and disable the model picker', async (t) => {
  const empty = await popup(t);
  assert.match(empty.$('#model-hint').textContent,/添加供应商和模型/);
  assert.equal(empty.$('#translation-model').disabled,true);
  const ui = await popup(t,catalog);
  await change(ui,'#translation-service','service:empty');
  assert.equal(ui.$('#translation-model').disabled,true);
  assert.match(ui.$('#model-hint').textContent,/为此供应商添加模型/);
  assert.equal(Core.resolveTranslationConfig(ui.settings,'immersive').model,'');
});

test('failed provider and model changes restore the saved effective configuration', async (t) => {
  const ui = await popup(t,catalog,{saveError:true});
  await change(ui,'#translation-service','service:beta');
  assert.equal(ui.$('#translation-service').value,'service:alpha');
  assert.equal(ui.$('#translation-model').value,'fast');
  await change(ui,'#translation-model','accurate');
  assert.equal(ui.$('#translation-model').value,'fast');
  assert.equal(Core.resolveTranslationConfig(ui.settings,'immersive').model,'fast');
  assert.match(ui.$('#status').textContent,/保存失败/);
});

test('choosing a legacy provider persists its catalog and retains credentials and subtitle model', async (t) => {
  const ui = await popup(t,{translationProvider:'custom',translationBaseUrl:'https://legacy.test/v1',translationApiKey:'legacy-key',translationModel:'legacy-model'});
  assert.equal(ui.settings.translationServices.length,0);
  await change(ui,'#translation-service','service:legacy-realtime');
  assert.equal(ui.settings.translationServices.length,1);
  assert.equal(Core.resolveTranslationConfig(ui.settings,'immersive').apiKey,'legacy-key');
  assert.equal(Core.resolveTranslationConfig(ui.settings).model,'legacy-model');
});

test('stale service selections display the same fallback model used by translation requests', async (t) => {
  const ui = await popup(t,{...catalog,translationServiceId:'deleted',translationModelId:'accurate',immersiveTranslationServiceId:'also-deleted'});
  assert.equal(ui.$('#translation-service').value,'service:alpha');
  assert.equal(ui.$('#translation-model').value,Core.resolveTranslationConfig(ui.settings,'immersive').model);
  assert.equal(ui.$('#translation-model').value,'accurate');
});
