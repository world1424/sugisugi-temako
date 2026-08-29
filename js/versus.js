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
import { getDatabase, ref, get, set, update, remove, onValue, onDisconnect }
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

// スマホのIMEは入力確定の途中で value を書き換えられると文字を二重に確定させる
// ことがある。以前は毎回 toUpperCase() で必ず書き換えが走っていたため、1文字
// 打つだけで2文字入ってしまっていた。
// 大文字化は CSS(text-transform) と読み取り時に任せ、ここでは「使えない文字が
// 実際に入ったときだけ」書き換える。カーソル位置も保つ。
$('joinCodeInput').addEventListener('input', function(e){
  const el = e.target;
  const cleaned = el.value.replace(/[^A-Za-z0-9]/g, '');
  if(cleaned === el.value) return;           // 通常の入力では何もしない
  const removed = el.value.length - cleaned.length;
  const pos = Math.max(0, (el.selectionStart || 0) - removed);
  el.value = cleaned;
  try { el.setSelectionRange(pos, pos); } catch(_){ /* 一部端末では未対応 */ }
});

// 曲を選んだらロビー側の表示も更新する（入力欄はタイトル画面と共用）
$('audioInput').addEventListener('change', async function(){
  const info = Game().getSongInfo();
  if(!info) return;
  $('vsUploadLabel').textContent = '読み込み完了！';
  $('vsFileName').textContent = info.name;
  $('vsUploadZone').classList.add('has-file');
  myDuration = await Game().probeDuration();
  // 部屋主が曲を選んだら、その音源を部屋に配って全員が同じ曲で遊べるようにする
  if(roomCode && isHost && info.file) uploadSong(info.file);
});

// ---------- 曲の配布 ----------
// Realtime Database に分割して置く。Storage を使わないので追加設定が要らず、
// 部屋を閉じたときに音源ごと消えるため保存容量も溜まらない。
const MAX_SONG_BYTES = 12 * 1024 * 1024; // 12MB。これ以上は転送が重すぎる
const CHUNK_LEN = 160 * 1024;            // base64文字列を刻む長さ
let songUploading = false;
let downloadedFor = null;                // 受信済みの音源キー（重複ダウンロード防止）
let songReceived = false;                // ホストの曲を受け取ったか（ゲスト用）

function fileToDataUrl(file){
  return new Promise(function(resolve, reject){
    const r = new FileReader();
    r.onload = function(){ resolve(r.result); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function uploadSong(file){
  if(songUploading) return;
  if(file.size > MAX_SONG_BYTES){
    msg('songWarn','⚠ ファイルが大きすぎます（'+(file.size/1048576).toFixed(1)
      +'MB）。12MB以下の曲を選んでください','err');
    return;
  }
  songUploading = true;
  try{
    msg('songWarn','曲を配信中… 0%','warn');
    const dataUrl = await fileToDataUrl(file);
    const total = Math.ceil(dataUrl.length / CHUNK_LEN);
    const base = 'rooms/'+roomCode+'/audio';

    await remove(ref(db, base));                       // 前の曲を消してから置き換える
    for(let i=0; i<total; i++){
      const patch = {};
      patch[String(i)] = dataUrl.slice(i*CHUNK_LEN, (i+1)*CHUNK_LEN);
      await update(ref(db, base+'/data'), patch);
      msg('songWarn','曲を配信中… '+Math.round((i+1)/total*100)+'%','warn');
    }
    await set(ref(db, base+'/meta'), {
      name: file.name, size: file.size, chunks: total, at: serverNow()
    });
    await update(ref(db,'rooms/'+roomCode+'/meta'), {
      songName: file.name, songDuration: myDuration || 0
    });
    msg('songWarn','この曲を全員に配信しました','ok');
  }catch(e){
    msg('songWarn','曲の配信に失敗しました：'+e.message,'err');
  }finally{
    songUploading = false;
  }
}

async function downloadSong(meta){
  const key = meta.name + ':' + meta.chunks + ':' + meta.at;
  if(downloadedFor === key) return;          // 同じ曲なら取り直さない
  downloadedFor = key;
  try{
    msg('songWarn','ホストの曲を受信中…','warn');
    const snap = await get(ref(db, 'rooms/'+roomCode+'/audio/data'));
    const parts = snap.val();
    if(!parts) throw new Error('データがありません');
    let dataUrl = '';
    for(let i=0; i<meta.chunks; i++) dataUrl += (parts[String(i)] || '');
    const blob = await (await fetch(dataUrl)).blob();
    Game().setSongBlob(blob, meta.name);
    myDuration = await Game().probeDuration();
    songReceived = true;
    $('vsUploadLabel').textContent = 'ホストの曲を受信しました';
    $('vsFileName').textContent = meta.name;
    $('vsUploadZone').classList.add('has-file');
    msg('songWarn','課題曲「'+esc(meta.name)+'」を受信しました','ok');
  }catch(e){
    downloadedFor = null;
    msg('songWarn','曲を受信できませんでした：'+e.message,'err');
  }
}

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
  // 大文字化と不要文字の除去は、入力中ではなくここで行う
  const code = ($('joinCodeInput').value || '').replace(/[^A-Za-z0-9]/g,'').toUpperCase();
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
  // 曲を選ぶのは部屋主だけ。参加者にはホストの音源が自動で配られる
  $('lobbySongArea').classList.toggle('hidden', !isHost);
  if(isHost){
    $('vsUploadLabel').textContent = '課題曲を選ぶ';
    $('vsUploadZone').querySelector('.filetypes').textContent = '選んだ曲が参加者全員に配信されます';
  }
  songReceived = false;
  downloadedFor = null;
  msg('roomMsg', isSpectator ? '観戦モードです。対戦の開始を待っています…' : '');

  subscribeRoom();
  if(isSpectator) show('spectate');

  // タイトル画面で先に曲を選んでから部屋を作った場合、選択時点では部屋が
  // 無いので配信されない。入室時に選択済みなら、ここで配信する。
  if(isHost){
    const info = Game().getSongInfo();
    if(info && info.file){
      if(!myDuration) myDuration = await Game().probeDuration();
      uploadSong(info.file);
    } else {
      msg('songWarn','課題曲を選んでください。選んだ曲が参加者に配信されます','warn');
    }
  }
}

// ---------- 部屋の購読 ----------
// 部屋ごと購読すると、スコアが動くたびに音源データまで再取得してしまう。
// meta / players / audio.meta の3つに分けて、音源本体は必要なときだけ取りに行く。
function subscribeRoom(){
  unsubscribeRoom();
  const base = 'rooms/'+roomCode;
  const onErr = function(err){ msg('roomMsg','購読エラー：'+err.message,'err'); };

  // v9以降の onValue は「解除用の関数」を返す。off() に渡すのは誤りで例外になる
  const unsubMeta = onValue(ref(db, base+'/meta'), function(snap){
    const v = snap.val();
    if(!v){ leaveRoom('部屋が閉じられました'); return; } // ホストが部屋を消した等
    lastMeta = v;
    onRoomUpdate();
  }, onErr);

  const unsubPlayers = onValue(ref(db, base+'/players'), function(snap){
    lastPlayers = snap.val() || {};
    if(lastMeta) onRoomUpdate();
  }, onErr);

  // 音源は「どんな曲が置かれたか」だけを監視し、本体は変わったときに一度だけ取る
  const unsubAudio = onValue(ref(db, base+'/audio/meta'), function(snap){
    const m = snap.val();
    if(!m || isHost || isSpectator) return;
    downloadSong(m);
  }, onErr);

  roomUnsub = function(){ unsubMeta(); unsubPlayers(); unsubAudio(); };
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
    const song = meta.songName ? '　課題曲：' + meta.songName : '　（ホストが曲を選ぶのを待っています）';
    $('guestSettings').textContent =
      'ホストの設定  BPM ' + meta.bpm + ' / ' + String(meta.difficulty).toUpperCase() + song;
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
  if(songUploading) return msg('roomMsg','曲の配信が終わるまで待ってください','warn');
  if(isHost && !Game().hasSong()){
    return msg('roomMsg','先に課題曲を選んでください','err');
  }
  // ゲストは「ホストから受け取った曲」を持っていないと準備完了にできない。
  // 自分がソロ用に選んでいた曲で始めてしまうと、全員が別の曲で遊ぶことになる
  if(!isHost && !songReceived){
    return msg('roomMsg','ホストが曲を配信するのを待っています','err');
  }
  // ここはユーザー操作なので、このタイミングで音声を用意しておく。
  // 対戦の開始はカウントダウン後のタイマーから起きるため、これをしないと
  // iOSでは再生が拒否され、ノーツが1つも降ってこない状態になる。
  Game().primeAudio();

  const me = lastPlayers[uid] || {};
  const next = !me.ready;
  await publishSelf({ ready: next });
  $('readyBtn').textContent = next ? '準備完了を取り消す' : '準備完了';
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
      heat: p.heat, costume: p.costume, fever: p.fever,
      judge: p.judge || '', judgeSeq: p.judgeSeq || 0
    });
    renderRivals();
  };
  g.onFinish = function(r){
    publishSelf({ score: r.score, maxCombo: r.maxCombo, rank: r.rank, finished: true });
    // 対戦中はソロ用のボタンを隠し、部屋に戻る導線だけ出す
    if(roomCode){
      $('backToRoomBtn').classList.remove('hidden');
      $('retryBtn').classList.add('hidden');
      $('changeBtn').classList.add('hidden');
    }
  };
});

// ---------- 対戦後に部屋へ戻る ----------
$('backToRoomBtn').addEventListener('click', async function(){
  if(!roomCode){ restoreResultButtons(); Game().showScreen('start'); return; }
  matchStarted = false;
  $('rivalPanel').classList.add('hidden');
  restoreResultButtons();

  // 次の対戦に備えて自分の成績を初期化する
  await publishSelf({
    ready:false, finished:false, score:0, combo:0, maxCombo:0,
    heat:8, costume:'casual', fever:false, rank:'-', judge:'', judgeSeq:0
  });
  $('readyBtn').textContent = '準備完了';
  // 部屋主は部屋の状態も待機に戻す（これをしないと次のカウントダウンが始まらない）
  if(isHost){
    try { await update(ref(db,'rooms/'+roomCode+'/meta'), { state:'lobby', startAt:0 }); }
    catch(e){ /* 失敗しても退出はできる */ }
  }
  msg('roomMsg','もう一度あそぶには、全員が準備完了にしてください');
  show('lobby');
});

function restoreResultButtons(){
  $('backToRoomBtn').classList.add('hidden');
  $('retryBtn').classList.remove('hidden');
  $('changeBtn').classList.remove('hidden');
}

const COSTUME_LABEL = { casual:'私服', idol:'アイドル', milk:'M!LK' };

// 相手の判定は数百msごとにしか届かないので、届いた瞬間に一定時間だけ
// 表情と判定文字を出し、その後は待機の絵に戻す
const JUDGE_LABEL = { perfect:'PERFECT', good:'GOOD', miss:'MISS' };
const REACT_SPRITE = { perfect:'heart', good:'happy', miss:'sad' };
const rivalReact = {};   // uid -> { seq, until }
const REACT_MS = 550;

function renderRivals(){
  const panel = $('rivalPanel');
  if(!roomCode || isSpectator){ panel.classList.add('hidden'); return; }
  const others = Object.entries(lastPlayers).filter(([id]) => id !== uid);
  if(!others.length){ panel.innerHTML = ''; return; }
  const now = Date.now();

  panel.innerHTML = others.map(function([id,p]){
    const st = trackReact(id, p, now);
    const costume = p.costume || 'casual';
    const face = Game().spriteFor(costume, st.active ? REACT_SPRITE[st.judge] : 'idle');
    return '<div class="rival' + (p.fever ? ' fever' : '') + '">'
      + '<img class="rivalFace" src="' + face + '" alt="">'
      + '<div class="rname">' + esc(p.name) + '</div>'
      + '<div class="rscore">' + (p.score||0) + '</div>'
      + '<div class="rmeta">' + (p.combo||0) + ' combo · ' + (COSTUME_LABEL[costume]||'') + '</div>'
      + (st.active
          ? '<div class="rjudge ' + st.judge + '">' + (JUDGE_LABEL[st.judge]||'') + '</div>'
          : '')
      + '</div>';
  }).join('');

  scheduleReactRefresh();
}

// 新しい判定が届いたら表示期限を延ばす。届かない間は自然に消える
function trackReact(id, p, now){
  const seq = p.judgeSeq || 0;
  const judge = p.judge || '';
  let st = rivalReact[id];
  if(!st){ st = rivalReact[id] = { seq: -1, until: 0, judge: '' }; }
  if(seq !== st.seq && judge){
    st.seq = seq; st.judge = judge; st.until = now + REACT_MS;
  }
  return { active: now < st.until && !!st.judge, judge: st.judge };
}

// 相手からの更新が止まっても、表示期限が切れたら待機の絵に戻す
let reactTimer = null;
function scheduleReactRefresh(){
  if(reactTimer) return;
  const pending = Object.values(rivalReact).some(s => Date.now() < s.until);
  if(!pending) return;
  reactTimer = setTimeout(function(){
    reactTimer = null;
    renderRivals();
    renderSpectatorBoard();
  }, REACT_MS + 60);
}

// ---------- 観戦ボード ----------
function renderSpectatorBoard(){
  if(!isSpectator) return;
  const board = $('specBoard');
  const entries = Object.entries(lastPlayers)
    .sort((a,b) => (b[1].score||0) - (a[1].score||0));
  if(!entries.length){ board.innerHTML = '<div class="netNote">プレイヤーを待っています…</div>'; return; }
  const now = Date.now();
  board.innerHTML = entries.map(function([id,p], i){
    const st = trackReact(id, p, now);
    const costume = p.costume || 'casual';
    const face = Game().spriteFor(costume, st.active ? REACT_SPRITE[st.judge] : 'idle');
    return '<div class="specRow' + (p.fever ? ' fever' : '') + '">'
      + '<div class="specRank">' + (i+1) + '</div>'
      + '<img class="specFace" src="' + face + '" alt="">'
      + '<div class="specMain">'
      +   '<div class="specName">' + esc(p.name)
      +     '<span class="costumeTag">' + (COSTUME_LABEL[costume]||'') + '</span>'
      +     (p.fever ? '<span class="feverTag">FEVER</span>' : '')
      +     (p.finished ? '<span class="doneTag">終了 ' + esc(p.rank||'') + '</span>' : '')
      +   '</div>'
      +   '<div class="specScore">' + (p.score||0)
      +     (st.active ? '<span class="specJudge ' + st.judge + '">' + (JUDGE_LABEL[st.judge]||'') + '</span>' : '')
      +   '</div>'
      +   '<div class="specSub">' + (p.combo||0) + ' combo</div>'
      +   '<div class="specHeat"><i style="width:' + Math.max(0,Math.min(100,p.heat||0)) + '%"></i></div>'
      + '</div></div>';
  }).join('');
  scheduleReactRefresh();
}

// ---------- 退出 ----------
$('leaveRoomBtn').addEventListener('click', function(){ leaveRoom(); });
$('specLeaveBtn').addEventListener('click', function(){ leaveRoom(); });

async function leaveRoom(note){
  clearInterval(countdownTimer); clearTimeout(startTimer);
  $('countdown').classList.add('hidden');
  $('rivalPanel').classList.add('hidden');
  unsubscribeRoom();
  restoreResultButtons();
  const code = roomCode, wasHost = isHost, wasSpec = isSpectator;
  roomCode = null; isHost = false; isSpectator = false;
  songReceived = false; downloadedFor = null; songUploading = false;
  for(const k in rivalReact) delete rivalReact[k];
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
