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
  let costume = 'casual'; // 'casual' | 'idol' — unlocked by combo, stays for the rest of the song
  let cutinShown = false; // one cut-in per song from the combo milestone (limit break can also trigger it)

  const COSTUME_COMBO = 15; // combo needed to unlock the idol costume
  const CUTIN_COMBO = 30;   // combo needed to trigger the idol cut-in flourish
  const CUTIN_IMAGES = ['assets/mascot/idol/cutin_1.png', 'assets/mascot/idol/cutin_2.png', 'assets/mascot/idol/cutin_3.png'];

  const DIRS = ['up','down','left','right'];
  const GLYPH = { up:'⬆', down:'⬇', left:'⬅', right:'➡' };
  const KEY_DIR = {
    ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
    w:'up', s:'down', a:'left', d:'right', W:'up', S:'down', A:'left', D:'right'
  };
  const FALL_DURATION = 1.1; // seconds a note takes to fall from the top of the lane to the judge line
  let spawnIdx = 0;

  const LANE_CONTAINERS = { up: byId('notesUp'), down: byId('notesDown'), left: byId('notesLeft'), right: byId('notesRight') };
  const laneEls = document.querySelectorAll('#laneField .lane');
  laneEls.forEach(function(laneEl){
    const dir = laneEl.dataset.dir;
    laneEl.addEventListener('pointerdown', function(){
      laneEl.classList.add('pressed');
      setTimeout(function(){ laneEl.classList.remove('pressed'); }, 120);
      handleLaneHit(dir);
    });
  });

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
    limitBreak = false; reactMood = null; reactUntil = 0;
    costume = 'casual'; cutinShown = false;
    counts = { perfect:0, good:0, miss:0 };
    scoreVal.textContent = '0';
    comboVal.textContent = '0';
    updateHeat();
    cutinWrap.classList.remove('show');
    Object.keys(LANE_CONTAINERS).forEach(function(dir){ LANE_CONTAINERS[dir].innerHTML = ''; });
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
    const cfg = DIFFICULTIES[difficulty];

    // spawn falling-note elements ahead of their hit time
    while(spawnIdx < notes.length && notes[spawnIdx].time - now <= FALL_DURATION){
      spawnNote(notes[spawnIdx]);
      spawnIdx++;
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
    checkComboMilestones();
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
      showCutin();
    }
  }

  function checkComboMilestones(){
    if(costume === 'casual' && combo >= COSTUME_COMBO){
      costume = 'idol';
      mascotBeatOn = null; // force a sprite refresh on the next beat
    }
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
    casual: {
      idleA: 'assets/mascot/idle_a.png',
      idleB: 'assets/mascot/idle_b.png',
      happy: 'assets/mascot/happy.png',
      sad: 'assets/mascot/cry.png',
      heart: 'assets/mascot/heart.png'
    },
    idol: {
      idleA: 'assets/mascot/idol/idle_idol_a.png',
      idleB: 'assets/mascot/idol/idle_idol_b.png',
      happy: 'assets/mascot/idol/happy_idol.png',
      sad: 'assets/mascot/idol/sad_idol.png',
      heart: 'assets/mascot/idol/grin_idol.png'
    }
  };
  let mascotBeatOn = null; // which idle frame is currently shown ('idleA'/'idleB')
  let mascotSrc = null;

  function setMascotSprite(key){
    const tag = costume + ':' + key;
    if(mascotSrc === tag) return;
    mascotSrc = tag;
    mascot.src = MASCOT_SPRITES[costume][key];
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
    mascotBeatOn = beatOn;
    setMascotSprite(beatOn); // no-ops internally if nothing actually changed
  }

})();
