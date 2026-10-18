// Isolated visual test fixture. Never imported by the production entry points.
localStorage.setItem('konofix.locale','pl');
const handlers=new Map(),callbacks=new Map(); let next=1;
const emit=(event,payload)=>(handlers.get(event)||[]).forEach(id=>callbacks.get(id)?.({event,payload,id}));
window.__TAURI_INTERNALS__={
 transformCallback(callback){const id=next++;callbacks.set(id,callback);return id;},
 unregisterCallback(id){callbacks.delete(id);},
 async invoke(command,args={}){
  if(command==='plugin:event|listen'){const list=handlers.get(args.event)||[];list.push(args.handler);handlers.set(args.event,list);return next++;}
  if(command==='start_network'){
   setTimeout(()=>{
    emit('network-status',{phase:'online',connected_peers:3,routes:[],dht_peers:5,bootstrap_count:0,bootstrap_connected:0,nat:'private',listen_addresses:[],detail:''});
    for(const [peer_id,nick,nick_color] of [['test-alice','Alicja','#a78bfa'],['test-marek','Marek','#67e8f9'],['test-ola','Ola','#fbbf24']])emit('peer-online',{peer_id,nick,nick_color});
    emit('room-created',{id:'muzyka',title:'# Muzyka',users:3,owner:'test-alice'});
    emit('room-created',{id:'projekty',title:'# Projekty',users:2,owner:'test-marek'});
    for(const [peer_id,nick,text] of [['test-alice','Alicja','Hej! Kto ma ochotę na rozmowę? 👋'],['test-self','Swir','Cześć! Wpadłem sprawdzić nowy wygląd Konofix.'],['test-marek','Marek','Jest czytelniej. Wszystko pod ręką 🙂']])emit('chat-message',{id:crypto.randomUUID(),kind:'chat',peer_id,nick,nick_color:peer_id==='test-self'?'#a78bfa':'#67e8f9',text,room:'world',timestamp:Date.now()});
    emit('file-transfer',{transfer_id:'preview-file',direction:'incoming',peer_id:'test-marek',nick:'Marek',file_name:'Wspólny projekt.zip',size:180000000,transferred:99000000,progress:55,status:'receiving'});
   },200);
   return {peer_id:'test-self',nick:args.nick,nick_color:args.nickColor,version:'0.6.1-rc.1'};
  }
  if(command==='send_message'){emit('chat-message',{id:crypto.randomUUID(),kind:'chat',peer_id:'test-self',nick:'Swir',text:args.text,room:args.room,timestamp:Date.now()});return;}
  if(command==='send_private_message')return{id:crypto.randomUUID(),peer_id:'test-self',target_peer_id:args.peerId,nick:'Swir',text:args.text,timestamp:Date.now()};
  if(command==='app_version')return '0.6.1-rc.1';
  if(command==='network_status')return{phase:'offline',routes:[],listen_addresses:[]};
  return null;
 }
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
// No public connections from visual fixtures.
window.WebSocket=class extends EventTarget { static OPEN=1;static CLOSED=3;readyState=3;send(){}close(){} };
