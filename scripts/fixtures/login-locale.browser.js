let checks=0;
const check=(value,message)=>{checks++;if(!value)throw new Error(message);};
const tick=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
const storage=new Map(); let failRead=false, failWrite=false;
const localStorage={getItem:key=>{if(failRead)throw new Error('read denied');return storage.get(key)??null;},setItem:(key,value)=>{if(failWrite)throw new Error('write denied');storage.set(key,value);},removeItem:key=>{if(failWrite)throw new Error('write denied');storage.delete(key);}};
const style=document.createElement('style');style.textContent=CSS_SOURCE;document.head.append(style);
document.body.innerHTML='<div id="app"></div>';
const dictionaries={pl:{'login.joinWorld':'Wejdź do #WORLD','login.nickHelp':'Wybierz nick. Jest rezerwowany tylko wtedy, gdy jesteś online.','login.nickLabel':'Twój nick','login.nickColor':'Kolor nicka','login.nickColorPreview':'Podgląd Twojego nicka','login.connect':'Połącz z siecią','login.advancedNetwork':'Zaawansowane ustawienia sieci','login.privacy':'🔒 Połączenia są szyfrowane przez libp2p. Nick nie jest kontem.','app.tagline':'Wchodzisz. Rozmawiasz. Wychodzisz — znikasz z sieci.'},en:{'login.joinWorld':'Join #WORLD','login.nickHelp':'Choose a nickname. It is reserved only while you are online.','login.nickLabel':'Your nickname','login.nickColor':'Nickname color','login.nickColorPreview':'Your nickname preview','login.connect':'Connect to network','login.advancedNetwork':'Advanced network settings','login.privacy':'🔒 Connections are encrypted by libp2p. A nickname is not an account.','app.tagline':'Join. Chat. Leave — disappear from the network.'}};
const t=key=>dictionaries[LOCALE][key]??key;
const NICK_COLORS=Array.from({length:12},(_,i)=>({label:`Color ${i}`,value:'#62e5ff'}));
const state={nickColor:'#62e5ff'};
let connects=0;
const render=new Function('app','state','localStorage','t','esc','NICK_COLORS','creditHtml','wireCredit','normalizeNickColor','connect','showNetworkModal',`${LOGIN_SOURCE}\nreturn renderLogin;`)(document.querySelector('#app'),state,localStorage,t,text=>text,NICK_COLORS,()=>'<div class="app-credit">by Swir</div>',()=>{},x=>x,()=>{connects++;},()=>{});
render();
const shell=document.querySelector('.login-shell');
const card=document.querySelector('.login-card');
const update=document.createElement('section');update.className='test-updater-card';
update.innerHTML='<div class="test-updater-copy"><strong>Dostępna nowa wersja testowa Konofix</strong><small>0.6.x · Windows CI</small></div><button type="button">Pobierz i zainstaluj</button>';card.append(update);
await tick();
check(getComputedStyle(shell).overflowY==='auto','Login must have a usable scroll fallback, not clipped body overflow');
check(shell.getBoundingClientRect().top>=-1,'Login scroll area must start within window');
check(shell.getBoundingClientRect().bottom<=innerHeight+1,'Login scroll area must fit the window');
check(shell.scrollWidth<=shell.clientWidth+1,'Login must not overflow horizontally');
if(innerWidth===1280&&innerHeight===760) check(card.getBoundingClientRect().top>=0&&card.getBoundingClientRect().bottom<=innerHeight-24,'Default window must show the entire login card without maximizing');
const reachable=async element=>{
  element.scrollIntoView({block:'center',inline:'nearest'});await tick();
  const rect=element.getBoundingClientRect();
  check(rect.top>=-1&&rect.bottom<=innerHeight+1,'Login control must scroll fully into view');
  check(element.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)),'Login control must accept pointer input');
};
for(const control of [document.querySelector('#nick'),document.querySelector('#connectBtn'),document.querySelector('#loginNetwork'),update.querySelector('button')])await reachable(control);
document.querySelector('#connectBtn').click();check(connects===1,'Connect handler remains attached');
update.querySelector('small').textContent='Long diagnostic '.repeat(50);await reachable(update.querySelector('button'));
await reachable(document.querySelector('#nick'));
// Language changes use the production startup resolver, but do not reload this page.
const nextLocale=new Function('localStorage','navigator','SUPPORTED','STORAGE_KEY',`${RESOLVER}\nreturn systemLocale();`);
const resolve=(languages=['pl-PL'])=>nextLocale(localStorage,{languages,language:languages[0]},SUPPORTED,'konofix.locale');
const modalWrap=document.createElement('div');modalWrap.id='networkModal';modalWrap.className='modal-wrap';
modalWrap.innerHTML='<div class="modal organized-settings"><header class="modal-head"><div><h3>Settings</h3></div><button id="closeModal">×</button></header><div class="settings-shell"><div class="settings-tabs"><button>Audio</button><button>Privacy</button><button>Updates</button><button>Network</button></div><div class="settings-body"><input id="unchanged-setting" value="preserve" /></div></div></div>';
document.body.append(modalWrap);
const modal=modalWrap.querySelector('.modal');
const api=new Function('currentLocale','localStorage',`${LOCALE_SOURCE}\nreturn {mountLocaleSettings,readLocalePreference,saveLocalePreference};`)(LOCALE,localStorage);
let select=modal.querySelector('[data-locale-select]'), save=modal.querySelector('[data-locale-save]');
check(Boolean(select&&save),'Language controls mount in existing settings');
check(select.options.length===SUPPORTED.length+1,'Exactly the supported locales plus Automatic');
check(select.value==='auto'&&save.disabled,'Automatic is the unset default, with no spurious write');
check(select.options[0].textContent.includes(LOCALE==='pl'?'Automatycznie':'Automatic'),'Automatic option is localized');
check(resolve() === 'pl','Unset override preserves system detection');
const change=value=>{select.value=value;select.dispatchEvent(new Event('change'));};
const unchanged=modal.querySelector('#unchanged-setting');unchanged.focus();
for(let i=0;i<8;i++)window.dispatchEvent(new CustomEvent('konofix-settings-present',{detail:modal}));
check(modal.querySelector('[data-locale-select]')===select,'Repeated lifecycle preserves controls');
check(modal.querySelectorAll('[data-locale-settings]').length===1,'Only one language card');
check(document.activeElement===unchanged&&unchanged.value==='preserve','No settings focus/value loss');
for(const code of SUPPORTED){
  change(code);check(storage.get('konofix.locale')!==code||save.disabled,'Selecting alone does not persist a change');
  save.click();check(storage.get('konofix.locale')===code,`Save ${code}`);
  check(resolve(['ja-JP'])===code,`Next startup honors ${code} override`);
}
change('auto');save.click();check(!storage.has('konofix.locale'),'Automatic removes the override');
check(resolve(['de-DE'])==='de','Automatic restores system language');check(resolve(['ja-JP'])==='en','Unsupported system language falls back to English');
change('pl');save.click();change('en');failWrite=true;save.click();
check(storage.get('konofix.locale')==='pl','Failed persistence preserves last preference');
check(!save.disabled,'Failed save remains retryable');failWrite=false;save.click();check(resolve()==='en','Failed save can be retried');
let invalid=false;try{api.saveLocalePreference('__proto__');}catch{invalid=true;}
check(invalid&&storage.get('konofix.locale')==='en','Reject unsupported/inherited-property locale');
failRead=true;check(api.readLocalePreference()==='auto','Unavailable storage does not break the new UI');failRead=false;
select.focus();api.mountLocaleSettings(modal);check(document.activeElement===select,'Idempotent mount keeps select focus');
check(modal.querySelector('[data-locale-status]').textContent.includes(LOCALE==='pl'?'Uruchom ponownie':'Restart'),'Save explicitly says next restart, not immediate change');
check(document.querySelector('#nick')&&connects===1,'Saving never reloads or reconnects the application');
await tick();
for(const element of [select,save,modal.querySelector('#closeModal')]){
  const rect=element.getBoundingClientRect();check(rect.left>=0&&rect.right<=innerWidth,'Language and close controls stay within narrow window');
}
modalWrap.remove();check(!modal.isConnected,'Closed settings are detached');
api.mountLocaleSettings(modal);check(modal.querySelectorAll('[data-locale-settings]').length===1,'Detached modal is not remounted');
const reopened=document.createElement('div');reopened.id='networkModal';reopened.innerHTML='<div class="modal"><div class="modal-head"><h3>Settings</h3></div></div>';document.body.append(reopened);api.mountLocaleSettings(reopened.firstElementChild);
check(reopened.querySelector('[data-locale-select]').value==='en','Reopening settings restores saved override');reopened.remove();
return {pass:true,checks,scope:'actual login renderer, CSS reachability, locale UI and startup resolver; IPC/media intentionally not used'};
