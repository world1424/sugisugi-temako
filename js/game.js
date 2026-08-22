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
  const judgeText = byId('judgeText');
  const climaxFlash = byId('climaxFlash');
  const climaxBanner = byId('climaxBanner');
  const cutinWrap = byId('cutinWrap');
  const cutinImg = byId('cutinImg');
  const mascot = byId('mascot');
  const reactImg = byId('reactImg');
  const retryBtn = byId('retryBtn');
  const changeBtn = byId('changeBtn');

  function byId(id){ return document.getElementById(id); }

  // ---------- Difficulty ----------
  const DIFFICULTIES = {
    easy:   { label:'EASY',   beatMul:3, perfect:0.22, good:0.42, missPenalty:6,  restChance:0.05, hitBonus:{ perfect:8, good:4 } },
    normal: { label:'NORMAL', beatMul:2, perfect:0.15, good:0.32, missPenalty:10, restChance:0.12, hitBonus:{ perfect:6, good:3 } },
    hard:   { label:'HARD',   beatMul:1, perfect:0.10, good:0.22, missPenalty:14, restChance:0.18, hitBonus:{ perfect:5, good:2 } }
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
  let fever = false;      // FEVER TIME: a timed reward state entered when heat maxes out
  let feverEndsAt = 0;    // audio-clock time (seconds) when the current fever expires
  let counts = { perfect:0, good:0, miss:0 };
  let rafId = null;
  let leadIn = 1.4;       // seconds before first note
  let reactMood = null;   // transient mascot reaction: 'perfect' | 'good' | 'miss'
  let reactUntil = 0;
  // 'casual' -> 'idol' -> 'milk': each stage is unlocked by combo and never downgrades
  // within a song, so a costume once earned is kept even after a miss.
  let costume = 'casual';
  let cutinShown = false; // one cut-in per song from the combo milestone (fever can also trigger it)

  const COSTUME_COMBO = 10; // combo needed to unlock the idol costume
  const MILK_COMBO = 20;    // combo needed to unlock the M!LK costume
  const CUTIN_COMBO = 30;   // combo needed to trigger the cut-in flourish
  const FEVER_DURATION = 9; // seconds a FEVER TIME lasts once the heat gauge maxes out
  const FEVER_MULT = 2;     // score multiplier during fever
  const HEAT_AFTER_FEVER = 20; // heat left over when fever ends, so it can be built again
  const CUTIN_IMAGES = [
    'assets/mascot/idol/cutin_1.png',
    'assets/mascot/idol/cutin_2.png',
    'assets/mascot/idol/cutin_3.png',
    'assets/mascot/milk/visu.png',      // ビジュいいじゃん
    'assets/mascot/milk/kime_cheer.png'
  ];

  const DIRS = ['up','down','left','right'];
  const GLYPH = { up:'⬆', down:'⬇', left:'⬅', right:'➡' };
  const KEY_DIR = {
    ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
    w:'up', s:'down', a:'left', d:'right', W:'up', S:'down', A:'left', D:'right'
  };
  const FALL_DURATION = 1.1; // seconds a note takes to fall from the top of the lane to the judge line
  let spawnIdx = 0;

  const LANE_CONTAINERS = { up: byId('notesUp'), down: byId('notesDown'), left: byId('notesLeft'), right: byId('notesRight') };
  const LANE_BY_DIR = {};
  const laneEls = document.querySelectorAll('#laneField .lane');
  laneEls.forEach(function(laneEl){
    const dir = laneEl.dataset.dir;
    LANE_BY_DIR[dir] = laneEl;
    laneEl.addEventListener('pointerdown', function(){
      laneEl.classList.add('pressed');
      setTimeout(function(){ laneEl.classList.remove('pressed'); }, 120);
      handleLaneHit(dir);
    });
  });

  // ---------- Hit sound (WebAudio — synthesized, no asset files) ----------
  const HIT_SOUND = {
    perfect: { freq:1180, type:'triangle', dur:0.13, gain:0.20, sweep:1.6 },
    good:    { freq:700,  type:'triangle', dur:0.10, gain:0.15, sweep:1.0 },
    miss:    { freq:150,  type:'sawtooth', dur:0.18, gain:0.09, sweep:0.55 }
  };
  let audioCtx = null;

  // Browsers only allow an AudioContext to start from a user gesture, so this is
  // called from the start button's click handler.
  function ensureAudioCtx(){
    if(audioCtx) return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    audioCtx = new AC();
    return audioCtx;
  }

  function playHitSound(kind){
    const ctx = audioCtx;
    if(!ctx) return;
    if(ctx.state === 'suspended') ctx.resume();
    const cfg = HIT_SOUND[kind];
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = cfg.type;
    osc.frequency.setValueAtTime(cfg.freq, t);
    osc.frequency.exponentialRampToValueAtTime(cfg.freq * cfg.sweep, t + cfg.dur);
    gain.gain.setValueAtTime(cfg.gain, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + cfg.dur); // exponential ramps can't reach 0
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + cfg.dur);
  }

  function flashLane(dir, kind){
    const laneEl = LANE_BY_DIR[dir];
    if(!laneEl) return;
    laneEl.classList.add('hit');
    setTimeout(function(){ laneEl.classList.remove('hit'); }, 110);
    const burst = laneEl.querySelector('.burst');
    if(!burst) return;
    burst.className = 'burst ' + kind;
    void burst.offsetWidth; // restart the animation
    burst.classList.add('pop');
  }

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
    handleLaneHit(dir);
  });

  // ---------- Game flow ----------
  function startGame(){
    ensureAudioCtx(); // must be created from a user gesture, so do it on the start click
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
    score = 0; combo = 0; maxCombo = 0; heat = 8; noteIdx = 0; spawnIdx = 0;
    fever = false; feverEndsAt = 0; reactMood = null; reactUntil = 0;
    costume = 'casual'; cutinShown = false;
    screens.play.classList.remove('fever');
    byId('heatLabel').textContent = '熱量';
    counts = { perfect:0, good:0, miss:0 };
    scoreVal.textContent = '0';
    comboVal.textContent = '0';
    updateHeat();
    cutinWrap.classList.remove('show');
    reactImg.classList.remove('show');
    Object.keys(LANE_CONTAINERS).forEach(function(dir){ LANE_CONTAINERS[dir].innerHTML = ''; });
    bodySrc = null; reactSrc = null;
    mascot.style.setProperty('--beat-dur', (60 / bpm) + 's');
    drawMascot(0);
  }

  // Musical phrases instead of random directions: each pattern is a short run the
  // hands can learn, and every pattern is played twice in a row so it registers as
  // a groove rather than pure reaction.
  const PATTERNS = [
    ['left','up','down','right'],     // 階段（左→右）
    ['right','down','up','left'],     // 階段（右→左）
    ['left','right','left','right'],  // 左右交互
    ['up','down','up','down'],        // 上下交互
    ['left','left','right','right'],  // 2連ずつ
    ['up','up','down','down'],
    ['left','up','left','down'],      // 左軸押し
    ['right','up','right','down'],    // 右軸押し
    ['down','left','up','right']      // 時計回り
  ];

  function buildChart(duration){
    const cfg = DIFFICULTIES[difficulty];
    const step = (60 / bpm) * cfg.beatMul;
    const endAt = duration - 1.5;
    notes = [];

    let pattern = PATTERNS[Math.floor(Math.random() * PATTERNS.length)];
    let pos = 0;
    let replaysLeft = 1; // play each pattern twice before switching
    let t = leadIn;

    while(t < endAt){
      if(pos >= pattern.length){
        if(replaysLeft > 0){
          replaysLeft--;
        } else {
          pattern = PATTERNS[Math.floor(Math.random() * PATTERNS.length)];
          replaysLeft = 1;
        }
        pos = 0;
      }
      const dir = pattern[pos];
      pos++;
      // an occasional rest keeps the chart from reading as a flat metronome —
      // never in the opening bar, so the player gets a clear entry point
      if(t > leadIn + step * 4 && Math.random() < cfg.restChance){
        t += step;
        continue;
      }
      notes.push({ time:t, dir:dir, judged:false });
      t += step;
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
    const cfg = DIFFICULTIES[difficulty];

    // spawn falling-note elements ahead of their hit time
    while(spawnIdx < notes.length && notes[spawnIdx].time - now <= FALL_DURATION){
      spawnNote(notes[spawnIdx]);
      spawnIdx++;
    }

    if(fever){
      if(now >= feverEndsAt) endFever();
      else updateHeat(); // drain the gauge smoothly while fever runs
    }

    // auto-miss any note that passed the judge line unjudged
    while(noteIdx < notes.length){
      const n = notes[noteIdx];
      if(n.judged){ noteIdx++; continue; }
      if(now - n.time > cfg.good){
        n.judged = true;
        removeNoteEl(n);
        registerMiss();
        noteIdx++;
        continue;
      }
      break;
    }

    drawMascot(now);
    rafId = requestAnimationFrame(tick);
  }

  function spawnNote(n){
    const el = document.createElement('div');
    el.className = 'note';
    el.textContent = GLYPH[n.dir];
    el.style.animationDuration = FALL_DURATION + 's';
    LANE_CONTAINERS[n.dir].appendChild(el);
    n.el = el;
  }

  function removeNoteEl(n){
    if(!n.el) return;
    const el = n.el;
    n.el = null;
    el.classList.add('judged');
    setTimeout(function(){ el.remove(); }, 200);
  }

  const RANK_MASCOT = {
    'S': 'assets/mascot/milk/suki_metsu.png',   // 好きすぎて滅
    'A': 'assets/mascot/milk/kime_heart.png',   // ハートハンドの決めポーズ
    'B': 'assets/mascot/idol/idle_idol_a.png',
    'C': 'assets/mascot/happy.png',
    'D': 'assets/mascot/cry.png',
    '-': 'assets/mascot/idle_a.png'
  };

  function endGame(){
    if(rafId) cancelAnimationFrame(rafId);
    byId('rScore').textContent = score;
    byId('rCombo').textContent = maxCombo;
    byId('rPerfect').textContent = counts.perfect;
    byId('rGood').textContent = counts.good;
    byId('rMiss').textContent = counts.miss;
    const rank = calcRank();
    byId('rankLabel').textContent = rank;
    byId('resultMascot').src = RANK_MASCOT[rank];
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

  // ---------- Lane tap / key input ----------
  function handleLaneHit(dir){
    if(!audioEl) return;
    const now = audioEl.currentTime;
    const cfg = DIFFICULTIES[difficulty];
    // find the closest unjudged note in this lane within the timing window
    let best = null, bestDelta = Infinity;
    for(let i = noteIdx; i < notes.length; i++){
      const n = notes[i];
      if(n.judged) continue;
      if(n.time > now + cfg.good) break; // notes are time-sorted; nothing further can be in range
      if(n.dir !== dir) continue;
      const delta = Math.abs(n.time - now);
      if(delta > cfg.good + 0.05) continue;
      if(delta < bestDelta){ bestDelta = delta; best = n; }
    }
    if(!best){ return; } // tap outside any window: ignored, not penalized
    best.judged = true;
    removeNoteEl(best);
    if(bestDelta <= cfg.perfect) registerHit('perfect', dir, 100);
    else registerHit('good', dir, 50);
  }

  function registerHit(kind, dir, pts){
    const cfg = DIFFICULTIES[difficulty];
    combo++; maxCombo = Math.max(maxCombo, combo);
    score += Math.round((pts + Math.floor(combo/5) * 5) * (fever ? FEVER_MULT : 1));
    counts[kind]++;
    // heat only builds outside fever — during fever the gauge shows time remaining
    if(!fever) heat = Math.min(100, heat + cfg.hitBonus[kind]);
    reactMood = kind; reactUntil = performance.now() + 260;
    playHitSound(kind);
    flashLane(dir, kind);
    flashJudge(kind === 'perfect' ? 'PERFECT' : 'GOOD', kind);
    updateHud();
    checkLimitBreak();
    checkComboMilestones();
  }

  function registerMiss(){
    combo = 0;
    counts.miss++;
    // a miss never cuts fever short — it's the payoff for having filled the gauge
    if(!fever) heat = Math.max(0, heat - DIFFICULTIES[difficulty].missPenalty);
    reactMood = 'miss'; reactUntil = performance.now() + 260;
    playHitSound('miss');
    flashJudge('MISS', 'miss');
    updateHud();
  }

  function checkLimitBreak(){
    if(heat >= 100 && !fever) startFever();
  }

  function startFever(){
    fever = true;
    feverEndsAt = audioEl.currentTime + FEVER_DURATION;
    screens.play.classList.add('fever');
    byId('heatLabel').textContent = 'FEVER';
    climaxFlash.classList.remove('show'); void climaxFlash.offsetWidth; climaxFlash.classList.add('show');
    climaxBanner.classList.remove('show'); void climaxBanner.offsetWidth; climaxBanner.classList.add('show');
    showCutin();
  }

  function endFever(){
    fever = false;
    heat = HEAT_AFTER_FEVER;
    screens.play.classList.remove('fever');
    byId('heatLabel').textContent = '熱量';
    updateHeat();
  }

  function checkComboMilestones(){
    // setBodySprite/setReactSprite tag their cache by costume, so changing this
    // variable alone is enough to refresh both the dance and the reaction sprite
    if(combo >= MILK_COMBO) costume = 'milk';
    else if(combo >= COSTUME_COMBO && costume === 'casual') costume = 'idol';

    if(!cutinShown && combo >= CUTIN_COMBO){
      cutinShown = true;
      showCutin();
    }
  }

  function showCutin(){
    const src = CUTIN_IMAGES[Math.floor(Math.random() * CUTIN_IMAGES.length)];
    cutinImg.src = src;
    cutinWrap.classList.remove('show'); void cutinWrap.offsetWidth; cutinWrap.classList.add('show');
  }

  function updateHud(){
    scoreVal.textContent = score;
    comboVal.textContent = combo;
    updateHeat();
    mascot.classList.toggle('hype', combo >= 10);
  }

  function updateHeat(){
    if(fever){
      // during fever the gauge doubles as a countdown of the time left
      const remain = Math.max(0, feverEndsAt - (audioEl ? audioEl.currentTime : 0));
      heatFill.style.height = (remain / FEVER_DURATION * 100) + '%';
      heatWrap.classList.add('burning', 'maxed');
      return;
    }
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
  // Left slot (reactImg) shows the judgment reaction; right slot (mascot) dances continuously
  // and is never interrupted by reactions — the two are fully independent.
  const MASCOT_SPRITES = {
    casual: {
      idle: ['assets/mascot/idle_a.png', 'assets/mascot/idle_b.png', 'assets/mascot/idle_c.png', 'assets/mascot/idle_d.png', 'assets/mascot/idle_e.png'],
      happy: 'assets/mascot/happy.png',
      sad: 'assets/mascot/cry.png',
      heart: 'assets/mascot/heart.png'
    },
    idol: {
      idle: ['assets/mascot/idol/idle_idol_a.png', 'assets/mascot/idol/idle_idol_b.png', 'assets/mascot/idol/idle_idol_c.png', 'assets/mascot/idol/idle_idol_d.png', 'assets/mascot/idol/idle_idol_e.png', 'assets/mascot/idol/idle_idol_f.png'],
      happy: 'assets/mascot/idol/happy_idol.png',
      sad: 'assets/mascot/idol/sad_idol.png',
      heart: 'assets/mascot/idol/grin_idol.png'
    },
    milk: {
      idle: ['assets/mascot/milk/idle_milk_a.png', 'assets/mascot/milk/idle_milk_b.png', 'assets/mascot/milk/idle_milk_c.png', 'assets/mascot/milk/idle_milk_d.png', 'assets/mascot/milk/idle_milk_e.png', 'assets/mascot/milk/idle_milk_f.png'],
      happy: 'assets/mascot/milk/happy_milk.png',
      sad: 'assets/mascot/milk/sad_milk.png',
      heart: 'assets/mascot/milk/heart_milk.png' // 好き…♡
    }
  };
  let bodySrc = null;
  let reactSrc = null;

  function setBodySprite(idx){
    const tag = costume + ':idle:' + idx;
    if(bodySrc === tag) return;
    bodySrc = tag;
    mascot.src = MASCOT_SPRITES[costume].idle[idx];
  }

  function setReactSprite(key){
    const tag = costume + ':' + key;
    if(reactSrc === tag) return;
    reactSrc = tag;
    reactImg.src = MASCOT_SPRITES[costume][key];
  }

  function drawMascot(nowSec){
    const beatSec = 60 / bpm;
    const now = performance.now();
    const reacting = reactMood && now < reactUntil;

    if(reacting){
      const key = reactMood === 'perfect' ? 'heart' : reactMood === 'good' ? 'happy' : 'sad';
      setReactSprite(key);
      reactImg.classList.add('show');
    } else {
      reactImg.classList.remove('show');
    }

    const idleFrames = MASCOT_SPRITES[costume].idle;
    const frame = Math.floor(nowSec / beatSec) % idleFrames.length;
    setBodySprite(frame);
  }

})();
