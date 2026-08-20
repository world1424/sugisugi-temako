(function(){
  "use strict";

  // ---------- Elements ----------
  const screens = { start: byId('start'), play: byId('play'), result: byId('result') };
  const audioInput = byId('audioInput');
  const uploadZone = byId('uploadZone');
  const uploadLabel = byId('uploadLabel');
  const fileName = byId('fileName');
  const bpmSlider = byId('bpmSlider');
  const bpmVal = byId('bpmVal');
  const diffGroup = byId('diffGroup');
  const startBtn = byId('startBtn');
  const scoreVal = byId('scoreVal');
  const comboVal = byId('comboVal');
  const heatFill = byId('heatFill');
  const heatWrap = byId('heatWrap');
  const ring = byId('ring');
  const ringProgress = byId('ringProgress');
  const arrowGlyph = byId('arrowGlyph');
  const judgeText = byId('judgeText');
  const climaxFlash = byId('climaxFlash');
  const climaxBanner = byId('climaxBanner');
  const mascot = byId('mascot');
  const retryBtn = byId('retryBtn');
  const changeBtn = byId('changeBtn');

  function byId(id){ return document.getElementById(id); }

  // ---------- Difficulty ----------
  const DIFFICULTIES = {
    easy:   { label:'EASY',   beatMul:3, perfect:0.22, good:0.42, missPenalty:6,  hitBonus:{ perfect:8, good:4 } },
    normal: { label:'NORMAL', beatMul:2, perfect:0.15, good:0.32, missPenalty:10, hitBonus:{ perfect:6, good:3 } },
    hard:   { label:'HARD',   beatMul:1, perfect:0.10, good:0.22, missPenalty:14, hitBonus:{ perfect:5, good:2 } }
  };
  let difficulty = 'normal';

  diffGroup.addEventListener('click', function(e){
    const btn = e.target.closest('.diff-btn');
    if(!btn) return;
    difficulty = btn.dataset.diff;
    Array.prototype.forEach.call(diffGroup.children, function(b){
      b.classList.toggle('active', b === btn);
    });
  });

  // ---------- State ----------
  let audioEl = null;
  let audioURL = null;
  let bpm = 128;
  let notes = [];        // {time, dir, judged}
  let noteIdx = 0;
  let score = 0, combo = 0, maxCombo = 0;
  let heat = 8;           // 0-100
  let limitBreak = false; // true while heat is maxed out
  let counts = { perfect:0, good:0, miss:0 };
  let rafId = null;
  let leadIn = 1.4;       // seconds before first note
  let reactMood = null;   // transient mascot reaction: 'perfect' | 'good' | 'miss'
  let reactUntil = 0;

  const DIRS = ['up','down','left','right'];
  const GLYPH = { up:'⬆', down:'⬇', left:'⬅', right:'➡' };
  const KEY_DIR = {
    ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
    w:'up', s:'down', a:'left', d:'right', W:'up', S:'down', A:'left', D:'right'
  };

  // ---------- Start screen wiring ----------
  audioInput.addEventListener('change', function(e){
    const f = e.target.files[0];
    if(!f) return;
    if(audioURL) URL.revokeObjectURL(audioURL);
    audioURL = URL.createObjectURL(f);
    fileName.textContent = f.name;
    uploadLabel.textContent = '読み込み完了！';
    uploadZone.classList.add('has-file');
    startBtn.disabled = false;
  });

  bpmSlider.addEventListener('input', function(){
    bpm = parseInt(bpmSlider.value, 10);
    bpmVal.textContent = bpm;
  });

  startBtn.addEventListener('click', startGame);
  retryBtn.addEventListener('click', function(){ showScreen('play'); resetPlayState(); beginPlayback(); });
  changeBtn.addEventListener('click', function(){ showScreen('start'); });

  function showScreen(name){
    Object.keys(screens).forEach(function(k){
      screens[k].classList.toggle('hidden', k !== name);
    });
  }

  // ---------- Keyboard support (desktop / Mac) ----------
  if(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches){
    document.body.classList.add('has-keyboard');
  }
  document.addEventListener('keydown', function(e){
    if(screens.play.classList.contains('hidden')) return;
    const dir = KEY_DIR[e.key];
    if(!dir) return;
    e.preventDefault();
    handleSwipe(dir);
  });

  // ---------- Game flow ----------
  function startGame(){
    showScreen('play');
    resetPlayState();
    if(audioEl){ audioEl.pause(); audioEl.currentTime = 0; }
    audioEl = new Audio(audioURL);
    audioEl.addEventListener('loadedmetadata', function(){
      buildChart(audioEl.duration || 60);
      beginPlayback();
    }, { once:true });
    audioEl.addEventListener('ended', endGame);
    audioEl.load();
  }

  function resetPlayState(){
    score = 0; combo = 0; maxCombo = 0; heat = 8; noteIdx = 0;
    limitBreak = false; reactMood = null; reactUntil = 0;
    counts = { perfect:0, good:0, miss:0 };
    scoreVal.textContent = '0';
    comboVal.textContent = '0';
    updateHeat();
    arrowGlyph.textContent = '–';
    arrowGlyph.className = 'arrow';
    mascotBeatOn = null;
    mascot.style.setProperty('--beat-dur', (60 / bpm) + 's');
    drawMascot(0);
  }

  function buildChart(duration){
    const beatSec = 60 / bpm;
    const interval = beatSec * DIFFICULTIES[difficulty].beatMul;
    notes = [];
    let t = leadIn;
    while(t < duration - 1.5){
      notes.push({ time:t, dir: DIRS[Math.floor(Math.random()*4)], judged:false });
      t += interval;
    }
  }

  function beginPlayback(){
    audioEl.currentTime = 0;
    audioEl.play().catch(function(){});
    if(rafId) cancelAnimationFrame(rafId);
    tick();
  }

  function tick(){
    const now = audioEl.currentTime;
    // advance current target note
    while(noteIdx < notes.length && notes[noteIdx].judged) noteIdx++;
    const cur = notes[noteIdx];
    const cfg = DIFFICULTIES[difficulty];
    if(cur){
      arrowGlyph.textContent = GLYPH[cur.dir];
      arrowGlyph.className = 'arrow ' + cur.dir;
      const remain = cur.time - now;
      const total = 0.9; // ring fill duration
      const p = Math.max(0, Math.min(100, (1 - remain/total) * 100));
      ringProgress.style.setProperty('--p', p);
      if(remain < -cfg.good && !cur.judged){
        cur.judged = true;
        registerMiss();
      }
    } else {
      ringProgress.style.setProperty('--p', 0);
    }
    drawMascot(now);
    rafId = requestAnimationFrame(tick);
  }

  function endGame(){
    if(rafId) cancelAnimationFrame(rafId);
    byId('rScore').textContent = score;
    byId('rCombo').textContent = maxCombo;
    byId('rPerfect').textContent = counts.perfect;
    byId('rGood').textContent = counts.good;
    byId('rMiss').textContent = counts.miss;
    byId('rankLabel').textContent = calcRank();
    showScreen('result');
  }

  function calcRank(){
    const total = counts.perfect + counts.good + counts.miss;
    if(total === 0) return '-';
    const acc = (counts.perfect + counts.good*0.5) / total;
    if(acc > 0.95) return 'S';
    if(acc > 0.85) return 'A';
    if(acc > 0.7) return 'B';
    if(acc > 0.5) return 'C';
    return 'D';
  }

  // ---------- Swipe input ----------
  let touchStart = null;
  const playSurface = screens.play;
  playSurface.addEventListener('pointerdown', function(e){ touchStart = { x:e.clientX, y:e.clientY, t:performance.now() }; });
  playSurface.addEventListener('pointerup', function(e){
    if(!touchStart || !audioEl) return;
    const dx = e.clientX - touchStart.x, dy = e.clientY - touchStart.y;
    const dist = Math.hypot(dx, dy);
    touchStart = null;
    if(dist < 24) return; // too small to count as swipe
    let dir;
    if(Math.abs(dx) > Math.abs(dy)) dir = dx > 0 ? 'right' : 'left';
    else dir = dy > 0 ? 'down' : 'up';
    handleSwipe(dir);
  });

  function handleSwipe(dir){
    if(!audioEl) return;
    const now = audioEl.currentTime;
    const cfg = DIFFICULTIES[difficulty];
    // find closest unjudged note within window
    let best = null, bestDelta = Infinity;
    for(let i = noteIdx; i < notes.length; i++){
      const n = notes[i];
      if(n.judged) continue;
      const delta = Math.abs(n.time - now);
      if(delta > cfg.good + 0.05) { if(n.time > now + cfg.good) break; continue; }
      if(delta < bestDelta){ bestDelta = delta; best = n; }
    }
    if(!best){ return; } // swipe outside any window: ignored, not penalized
    best.judged = true;
    if(best.dir !== dir){ registerMiss(); return; }
    if(bestDelta <= cfg.perfect) registerHit('perfect', 100);
    else registerHit('good', 50);
  }

  function registerHit(kind, pts){
    const cfg = DIFFICULTIES[difficulty];
    combo++; maxCombo = Math.max(maxCombo, combo);
    const mult = limitBreak ? 1.5 : 1;
    score += Math.round((pts + Math.floor(combo/5) * 5) * mult);
    counts[kind]++;
    heat = Math.min(100, heat + cfg.hitBonus[kind]);
    reactMood = kind; reactUntil = performance.now() + 260;
    flashJudge(kind === 'perfect' ? 'PERFECT' : 'GOOD', kind);
    updateHud();
    checkLimitBreak();
  }

  function registerMiss(){
    combo = 0;
    counts.miss++;
    heat = Math.max(0, heat - DIFFICULTIES[difficulty].missPenalty);
    reactMood = 'miss'; reactUntil = performance.now() + 260;
    limitBreak = false;
    flashJudge('MISS', 'miss');
    updateHud();
  }

  function checkLimitBreak(){
    if(heat >= 100 && !limitBreak){
      limitBreak = true;
      climaxFlash.classList.remove('show'); void climaxFlash.offsetWidth; climaxFlash.classList.add('show');
      climaxBanner.classList.remove('show'); void climaxBanner.offsetWidth; climaxBanner.classList.add('show');
    }
  }

  function updateHud(){
    scoreVal.textContent = score;
    comboVal.textContent = combo;
    updateHeat();
    mascot.classList.toggle('hype', combo >= 10);
  }

  function updateHeat(){
    heatFill.style.height = heat + '%';
    heatWrap.classList.toggle('burning', heat >= 80);
    heatWrap.classList.toggle('maxed', heat >= 100);
  }

  function flashJudge(label, cls){
    judgeText.textContent = label;
    judgeText.className = 'judge ' + cls;
    void judgeText.offsetWidth; // restart animation
    judgeText.classList.add('show');
  }

  // ---------- Dancing mascot (sprite-based) ----------
  const MASCOT_SPRITES = {
    idleA: 'assets/mascot/idle_a.png',
    idleB: 'assets/mascot/idle_b.png',
    happy: 'assets/mascot/happy.png',
    sad: 'assets/mascot/sad.png',
    heart: 'assets/mascot/heart.png'
  };
  let mascotBeatOn = null; // which idle frame is currently shown ('idleA'/'idleB')
  let mascotSrc = null;

  function setMascotSprite(key){
    if(mascotSrc === key) return;
    mascotSrc = key;
    mascot.src = MASCOT_SPRITES[key];
  }

  function drawMascot(nowSec){
    const beatSec = 60 / bpm;
    const now = performance.now();
    const reacting = reactMood && now < reactUntil;

    mascot.classList.toggle('reacting', reacting);

    if(reacting){
      if(reactMood === 'perfect') setMascotSprite('heart');
      else if(reactMood === 'good') setMascotSprite('happy');
      else if(reactMood === 'miss') setMascotSprite('sad');
      return;
    }

    const beatOn = Math.floor(nowSec / beatSec) % 2 === 0 ? 'idleA' : 'idleB';
    if(beatOn !== mascotBeatOn){
      mascotBeatOn = beatOn;
      setMascotSprite(beatOn);
    }
  }

})();
