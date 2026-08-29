// ---------------------------------------------------------------------------
// オンライン対戦・観戦（Firebase Realtime Database）
//
// 同期するのは「部屋の設定」と「各プレイヤーの状況」だけで、音楽そのものは
// 一切送受信しない。各自が手元の曲を再生し、判定はそれぞれの音声時計で行う。
// 譜面はホストが配るシードと曲の長さから生成するため、全員が同一譜面になる。
// ---------------------------------------------------------------------------
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getDatabase, ref, get, set, update, remove, onValue, off, onDisconnect }
  from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDoVb1ihVqSHRtO0hYK2KsKhOqB6m_HLGs",
  authDomain: "sugisugi-temako.firebaseapp.com",
  databaseURL: "https://sugisugi-temako-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "sugisugi-temako",
  storageBucket: "sugisugi-temako.firebasestorage.app",
  messagingSenderId: "441020653015",
  appId: "1:441020653015:web:45efc3a963981f299cbf92"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getDatabase(app);

const $ = (id) => document.getElementById(id);
const Game = () => window.Temako;

// ---------- 状態 ----------
let uid = null;
let serverOffset = 0;       // サーバー時刻 - 端末時刻（ミリ秒）
let roomCode = null;
let isHost = false;
let isSpectator = false;
let myName = '';
let roomUnsub = null;       // 部屋の購読解除
let lastMeta = null;
let lastPlayers = {};
let countdownTimer = null;
let startTimer = null;
let hostBpm = 128;
let hostDifficulty = 'normal';
let myDuration = 0;
let matchStarted = false;

const serverNow = () => Date.now() + serverOffset;

// 紛らわしい文字（I/O/0/1）を除いた部屋コード用の文字集合
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(){
  let s = '';
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  for(let i=0;i<4;i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return s;
}

// ---------- 画面切り替え ----------
const SCREENS = ['start','play','result','lobby','spectate'];
function show(name){
  SCREENS.forEach(function(id){
    const el = $(id);
    if(el) el.classList.toggle('hidden', id !== name);
  });
}

function msg(el, text, kind){
  const n = $(el);
  if(!n) return;
  n.textContent = text || '';
  n.className = 'netNote' + (kind ? ' ' + kind : '');
}

// ---------- 接続 ----------
onValue(ref(db, '.info/serverTimeOffset'), function(snap){
  serverOffset = snap.val() || 0;
});

let authReady = signInAnonymously(auth).catch(function(e){
  msg('lobbyMsg', '接続に失敗しました：' + e.code, 'err');
  throw e;
});
onAuthStateChanged(auth, function(user){ if(user) uid = user.uid; });

async function ensureAuth(){
  await authReady;
  if(!uid && auth.currentUser) uid = auth.currentUser.uid;
  return uid;
}

// ---------- 入口 ----------
$('toVersusBtn').addEventListener('click', function(){
  show('lobby');
  $('lobbyEntry').classList.remove('hidden');
  $('lobbyRoom').classList.add('hidden');
  const saved = localStorage.getItem('temako.nick');
  if(saved) $('nickInput').value = saved;
  msg('lobbyMsg', '');
});

$('lobbyBackBtn').addEventListener('click', function(){ show('start'); });

$('joinCodeInput').addEventListener('input', function(e){
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
});

// 曲を選んだらロビー側の表示も更新する（入力欄はタイトル画面と共用）
$('audioInput').addEventListener('change', async function(){
  const info = Game().getSongInfo();
  if(!info) return;
  $('vsUploadLabel').textContent = '読み込み完了！';
  $('vsFileName').textContent = info.name;
  $('vsUploadZone').classList.add('has-file');
  myDuration = await Game().probeDuration();
  checkSongMatch();
  if(roomCode && !isSpectator) publishSelf({ });
});

function nickname(){
  const v = ($('nickInput').value || '').trim().slice(0,12);
  return v || 'ななし';
}

// ---------- 部屋を作る / 参加する ----------
$('createRoomBtn').addEventListener('click', async function(){
  await ensureAuth();
  if(!uid) return msg('lobbyMsg','接続できていません','err');
  myName = nickname();
  localStorage.setItem('temako.nick', myName);

  const code = makeCode();
  try {
    await set(ref(db, 'rooms/'+code+'/meta'), {
      host: uid,
      seed: Math.floor(Math.random()*0xFFFFFFFF),
      bpm: hostBpm,
      difficulty: hostDifficulty,
      songName: '',
      songDuration: 0,
      state: 'lobby',
      startAt: 0,
      createdAt: serverNow()
    });
  } catch(e){
    return msg('lobbyMsg','部屋を作れませんでした：'+e.message,'err');
  }
  isHost = true; isSpectator = false;
  await enterRoom(code);
});

$('joinRoomBtn').addEventListener('click', function(){ joinRoom(false); });
$('spectateBtn').addEventListener('click', function(){ joinRoom(true); });

async function joinRoom(spectate){
  await ensureAuth();
  if(!uid) return msg('lobbyMsg','接続できていません','err');
  const code = ($('joinCodeInput').value || '').trim().toUpperCase();
  if(code.length !== 4) return msg('lobbyMsg','部屋コードは4文字です','err');

  let snap;
  try {
    snap = await get(ref(db, 'rooms/'+code+'/meta'));
  } catch(e){
    return msg('lobbyMsg','接続エラー：'+e.message,'err');
  }
  if(!snap.exists()) return msg('lobbyMsg','その部屋は見つかりません','err');

  myName = nickname();
  localStorage.setItem('temako.nick', myName);
  isHost = false;
  isSpectator = !!spectate;
  await enterRoom(code);
}

async function enterRoom(code){
  roomCode = code;
  matchStarted = false;

  if(!isSpectator){
    const me = ref(db, 'rooms/'+code+'/players/'+uid);
    await set(me, {
      name: myName, ready: false, score: 0, combo: 0, maxCombo: 0,
      heat: 8, costume: 'casual', fever: false, finished: false, rank: '-'
    });
    onDisconnect(me).remove(); // 切断したら自動で部屋から消える
  }

  $('roomCodeVal').textContent = code;
  $('specCodeVal').textContent = code;
  $('lobbyEntry').classList.add('hidden');
  $('lobbyRoom').classList.remove('hidden');
  $('hostSettings').classList.toggle('hidden', !isHost);
  $('guestSettings').classList.toggle('hidden', isHost);
  $('hostStartBtn').classList.toggle('hidden', !isHost);
  $('readyBtn').classList.toggle('hidden', isSpectator);
  $('lobbySongArea').classList.toggle('hidden', isSpectator);
  msg('roomMsg', isSpectator ? '観戦モードです。対戦の開始を待っています…' : '');

  subscribeRoom();
  if(isSpectator) show('spectate');
}

// ---------- 部屋の購読 ----------
function subscribeRoom(){
  unsubscribeRoom();
  const r = ref(db, 'rooms/'+roomCode);
  const cb = onValue(r, function(snap){
    const v = snap.val();
    if(!v || !v.meta){
      // ホストが部屋を消した等
      leaveRoom('部屋が閉じられました');
      return;
    }
    lastMeta = v.meta;
    lastPlayers = v.players || {};
    onRoomUpdate();
  }, function(err){
    msg('roomMsg','購読エラー：'+err.message,'err');
  });
  roomUnsub = function(){ off(r, 'value', cb); };
}

function unsubscribeRoom(){
  if(roomUnsub){ roomUnsub(); roomUnsub = null; }
}

function onRoomUpdate(){
  const meta = lastMeta;
  renderPlayers();
  renderSpectatorBoard();
  renderRivals(); // 相手の状況は「相手が動いたとき」に描き直す必要がある

  if(!isHost){
    hostBpm = meta.bpm; hostDifficulty = meta.difficulty;
    $('guestSettings').textContent =
      'ホストの設定  BPM ' + meta.bpm + ' / ' + String(meta.difficulty).toUpperCase();
    checkSongMatch();
  }

  if(isHost){
    const players = Object.values(lastPlayers);
    const everyoneReady = players.length > 0 && players.every(p => p.ready);
    $('hostStartBtn').disabled = !everyoneReady || meta.state !== 'lobby';
    $('hostStartBtn').textContent = everyoneReady ? '対戦スタート' : '全員の準備を待っています';
  }

  if(meta.state === 'countdown' && !matchStarted){
    matchStarted = true;
    beginCountdown(meta);
  }
}

// ---------- 参加者一覧 ----------
function renderPlayers(){
  const list = $('playerList');
  const entries = Object.entries(lastPlayers);
  if(!entries.length){ list.innerHTML = '<div class="netNote">まだ誰もいません</div>'; return; }
  list.innerHTML = entries.map(function([id,p]){
    const you = id === uid ? ' <span class="youTag">あなた</span>' : '';
    const host = lastMeta && lastMeta.host === id ? ' <span class="hostTag">部屋主</span>' : '';
    const state = p.ready ? '<span class="okTag">準備OK</span>' : '<span class="waitTag">準備中</span>';
    return '<div class="playerRow"><span class="pname">' + esc(p.name) + you + host + '</span>' + state + '</div>';
  }).join('');
}

function esc(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- 曲の一致チェック ----------
function checkSongMatch(){
  if(isSpectator || !lastMeta) return;
  const hostName = lastMeta.songName, hostDur = lastMeta.songDuration;
  if(isHost || !hostName || !myDuration){ msg('songWarn',''); return; }
  const info = Game().getSongInfo();
  const nameSame = info && info.name === hostName;
  const durSame  = Math.abs(myDuration - hostDur) < 1.0;
  if(nameSame && durSame){
    msg('songWarn','ホストと同じ曲のようです', 'ok');
  } else {
    msg('songWarn','⚠ ホストの曲「'+esc(hostName)+'」と違うかもしれません（長さの差 '
      + Math.abs(myDuration-hostDur).toFixed(1) + '秒）。譜面は全員同じなので遊べますが、曲とズレる場合があります', 'warn');
  }
}

// ---------- ホスト設定 ----------
$('vsBpmSlider').addEventListener('input', function(e){
  hostBpm = parseInt(e.target.value,10);
  $('vsBpmVal').textContent = hostBpm;
  if(isHost && roomCode) update(ref(db,'rooms/'+roomCode+'/meta'), { bpm: hostBpm });
});
$('vsDiffGroup').addEventListener('click', function(e){
  const btn = e.target.closest('.diff-btn');
  if(!btn) return;
  hostDifficulty = btn.dataset.diff;
  Array.from($('vsDiffGroup').children).forEach(b => b.classList.toggle('active', b===btn));
  if(isHost && roomCode) update(ref(db,'rooms/'+roomCode+'/meta'), { difficulty: hostDifficulty });
});

// ---------- 準備完了 ----------
$('readyBtn').addEventListener('click', async function(){
  if(!Game().hasSong()) return msg('roomMsg','先に曲を選んでください','err');
  const me = lastPlayers[uid] || {};
  const next = !me.ready;
  await publishSelf({ ready: next });
  $('readyBtn').textContent = next ? '準備完了を取り消す' : '準備完了';
  // ホストは自分の曲を「基準の曲」として部屋に登録する
  if(isHost && next){
    const info = Game().getSongInfo();
    await update(ref(db,'rooms/'+roomCode+'/meta'), {
      songName: info ? info.name : '', songDuration: myDuration || 0
    });
  }
});

async function publishSelf(patch){
  if(!roomCode || isSpectator || !uid) return;
  try { await update(ref(db,'rooms/'+roomCode+'/players/'+uid), patch); }
  catch(e){ /* 一時的な失敗は無視（次の更新で追いつく） */ }
}

// ---------- 対戦スタート（ホスト） ----------
$('hostStartBtn').addEventListener('click', async function(){
  if(!isHost || !roomCode) return;
  const info = Game().getSongInfo();
  await update(ref(db,'rooms/'+roomCode+'/meta'), {
    state: 'countdown',
    startAt: serverNow() + 6000,          // 全員が同じ瞬間に開始できるよう余裕をとる
    songName: info ? info.name : '',
    songDuration: myDuration || 0,
    bpm: hostBpm,
    difficulty: hostDifficulty
  });
});

// ---------- カウントダウン → 開始 ----------
function beginCountdown(meta){
  const cd = $('countdown');
  const num = $('countdownNum');
  cd.classList.remove('hidden');
  if(!isSpectator) show('lobby'); else show('spectate');

  clearInterval(countdownTimer);
  clearTimeout(startTimer);

  countdownTimer = setInterval(function(){
    const left = Math.ceil((meta.startAt - serverNow())/1000);
    if(left > 0){
      num.textContent = left;
      num.className = ''; void num.offsetWidth; num.className = 'pop';
    } else {
      clearInterval(countdownTimer);
      cd.classList.add('hidden');
    }
  }, 100);

  const delay = Math.max(0, meta.startAt - serverNow());
  startTimer = setTimeout(function(){
    cd.classList.add('hidden');
    clearInterval(countdownTimer);
    if(isSpectator){
      show('spectate');
    } else {
      $('rivalPanel').classList.remove('hidden');
      Game().startVersus({
        seed: meta.seed, bpm: meta.bpm, difficulty: meta.difficulty,
        duration: meta.songDuration || myDuration || 60
      });
    }
  }, delay);
}

// ---------- プレイ中：自分の状況を送る / 相手を表示する ----------
window.addEventListener('load', function(){
  const g = Game();
  if(!g) return;
  g.onProgress = function(p){
    publishSelf({
      score: p.score, combo: p.combo, maxCombo: p.maxCombo,
      heat: p.heat, costume: p.costume, fever: p.fever
    });
    renderRivals();
  };
  g.onFinish = function(r){
    publishSelf({ score: r.score, maxCombo: r.maxCombo, rank: r.rank, finished: true });
  };
});

const COSTUME_LABEL = { casual:'私服', idol:'アイドル', milk:'M!LK' };

function renderRivals(){
  const panel = $('rivalPanel');
  if(!roomCode || isSpectator){ panel.classList.add('hidden'); return; }
  const others = Object.entries(lastPlayers).filter(([id]) => id !== uid);
  if(!others.length){ panel.innerHTML = ''; return; }
  panel.innerHTML = others.map(function([,p]){
    return '<div class="rival' + (p.fever ? ' fever' : '') + '">'
      + '<div class="rname">' + esc(p.name) + '</div>'
      + '<div class="rscore">' + (p.score||0) + '</div>'
      + '<div class="rmeta">' + (p.combo||0) + ' combo · ' + (COSTUME_LABEL[p.costume]||'') + '</div>'
      + '</div>';
  }).join('');
}

// ---------- 観戦ボード ----------
function renderSpectatorBoard(){
  if(!isSpectator) return;
  const board = $('specBoard');
  const entries = Object.entries(lastPlayers)
    .sort((a,b) => (b[1].score||0) - (a[1].score||0));
  if(!entries.length){ board.innerHTML = '<div class="netNote">プレイヤーを待っています…</div>'; return; }
  board.innerHTML = entries.map(function([,p], i){
    return '<div class="specRow' + (p.fever ? ' fever' : '') + '">'
      + '<div class="specRank">' + (i+1) + '</div>'
      + '<div class="specMain">'
      +   '<div class="specName">' + esc(p.name)
      +     '<span class="costumeTag">' + (COSTUME_LABEL[p.costume]||'') + '</span>'
      +     (p.fever ? '<span class="feverTag">FEVER</span>' : '')
      +     (p.finished ? '<span class="doneTag">終了 ' + esc(p.rank||'') + '</span>' : '')
      +   '</div>'
      +   '<div class="specScore">' + (p.score||0) + '</div>'
      +   '<div class="specSub">' + (p.combo||0) + ' combo</div>'
      +   '<div class="specHeat"><i style="width:' + Math.max(0,Math.min(100,p.heat||0)) + '%"></i></div>'
      + '</div></div>';
  }).join('');
}

// ---------- 退出 ----------
$('leaveRoomBtn').addEventListener('click', function(){ leaveRoom(); });
$('specLeaveBtn').addEventListener('click', function(){ leaveRoom(); });

async function leaveRoom(note){
  clearInterval(countdownTimer); clearTimeout(startTimer);
  $('countdown').classList.add('hidden');
  $('rivalPanel').classList.add('hidden');
  unsubscribeRoom();
  const code = roomCode, wasHost = isHost, wasSpec = isSpectator;
  roomCode = null; isHost = false; isSpectator = false;
  matchStarted = false;
  lastMeta = null; lastPlayers = {};
  if(code && uid && !wasSpec){
    try {
      await remove(ref(db,'rooms/'+code+'/players/'+uid));
      if(wasHost) await remove(ref(db,'rooms/'+code)); // 部屋主が抜けたら部屋ごと片付ける
    } catch(e){ /* 失敗しても致命的ではない */ }
  }
  Game().exitVersus();
  show('start');
  if(note) msg('lobbyMsg', note, 'warn');
}
