/* ============================================================
   game.js — Samay Sparsh

   Flow:
     Menu → Setup → Lobby → Instructions → Practice → Waiting
          → 5 official rounds (round → results → …)
          → tiebreak rounds while needed
          → Final results

   The host is authoritative: it generates every target, tallies wins,
   and decides when a round opens. Other peers render what they're told.
   ============================================================ */

/* ---------- constants ---------- */

const PLAYERS_REQUIRED = 3;   // exactly three — the game does not start short
const OFFICIAL_ROUNDS = 5;

// The teaching target. Shared by the animated example and the practice round
// so the number a player is shown is the number they then try to hit.
const TUTORIAL_TARGET = 4.00;

const TARGET_MIN = 3.00;
const TARGET_MAX = 8.00;

// After the starting tap is released, ignore taps for this long. This is what
// stops a long press from registering as start+stop and what absorbs an
// accidental double-tap. Long enough to catch a fumble, far below any real
// attempt (the shortest legal target is 3s).
const ARM_DELAY_MS = 320;

/* ---------- tiny helpers ---------- */

const $ = (id) => document.getElementById(id);
const round2 = (n) => Math.round(n * 100) / 100;
const fmt2 = (n) => n.toFixed(2);
const initials = (name) =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

/** One shared target for a round: 3.00–8.00 inclusive, 2 decimals.
 *  Host-only. Never called on a non-host peer. */
function makeTarget() {
  const steps = Math.round((TARGET_MAX - TARGET_MIN) * 100); // 500 steps of 0.01
  return round2(TARGET_MIN + (Math.floor(Math.random() * (steps + 1)) / 100));
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  $(id).scrollTop = 0;
}

/* ---------- game state (every peer) ---------- */

const G = {
  mode: 'create',        // 'create' | 'join'
  round: 0,
  target: 0,
  tiebreak: false,
  participants: [],      // ids playing the current round
  wins: {},              // id -> official round wins
  practicing: false,
  finalWinnerId: null,
};

/* ---------- host-only bookkeeping ---------- */

const H = {
  wins: {},
  results: {},           // id -> { timeMs, secs, diff }
  waitingFor: new Set(), // ids we still need a message from
  stage: null,           // 'ready' | 'results' | 'next' | 'again'
};

/* ============================================================
   MENU
   ============================================================ */

$('btn-start-party').onclick = () => openSetup('create');
$('btn-join-party').onclick = () => openSetup('join');

function openSetup(mode) {
  G.mode = mode;
  $('setup-title').textContent = mode === 'create' ? 'Start a Party' : 'Join a Party';
  $('join-code-block').classList.toggle('hidden', mode === 'create');
  $('setup-hint').textContent = mode === 'create'
    ? "You'll get a code to share. Samay Sparsh needs three players."
    : 'Ask the host for their 6-digit party code.';
  $('btn-setup-go').textContent = mode === 'create' ? 'Create Party' : 'Join Party';
  $('input-name').value = localStorage.getItem('sp-name') || '';
  $('input-code').value = '';
  show('screen-setup');
  setTimeout(() => $('input-name').focus(), 260);
}

document.querySelectorAll('[data-back]').forEach(b => {
  b.onclick = () => show(b.dataset.back);
});

$('input-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

$('btn-setup-go').onclick = async () => {
  const name = $('input-name').value.trim();
  if (!name) { toast('Enter your name to continue.'); $('input-name').focus(); return; }
  localStorage.setItem('sp-name', name);

  const btn = $('btn-setup-go');
  btn.disabled = true;

  try {
    if (G.mode === 'create') {
      await net.create(name);
    } else {
      const code = $('input-code').value.trim();
      if (code.length !== 6) { toast('Enter the full 6-digit code.'); btn.disabled = false; return; }
      btn.textContent = 'Joining…';
      await net.join(code, name);
    }
    enterLobby();
  } catch (err) {
    toast(err.message === 'FULL' ? 'That party is full — three players max.'
        : err.message === 'NO_CONNECTION' ? 'No connection to the server.'
        : "Couldn't find that party. Check the code.");
  } finally {
    btn.disabled = false;
    btn.textContent = G.mode === 'create' ? 'Create Party' : 'Join Party';
  }
};

/* ============================================================
   LOBBY
   ============================================================ */

function enterLobby() {
  $('lobby-code').textContent = net.code;
  $('btn-lobby-start').classList.toggle('hidden', !net.isHost);
  $('lobby-foot').classList.toggle('hidden', net.isHost);
  renderLobby();
  show('screen-lobby');
}

function renderLobby() {
  const rows = net.players.map((p, i) => `
    <div class="player-row">
      <div class="avatar">${initials(p.name)}</div>
      <div>
        <div class="player-name">${p.name}${p.id === net.me.id ? ' (You)' : ''}</div>
        <div class="player-tag">${i === 0 ? 'Host' : 'Player ' + (i + 1)}</div>
      </div>
    </div>`);

  // Show every unfilled seat, so "we need one more" is legible at a glance
  // rather than something you work out from a counter.
  for (let i = net.players.length; i < PLAYERS_REQUIRED; i++) {
    rows.push(`
      <div class="player-row slot-empty">
        <div class="avatar">+</div>
        <div><div class="player-name" style="color:var(--muted)">Waiting for a player</div>
        <div class="player-tag">Share the code</div></div>
      </div>`);
  }
  $('lobby-players').innerHTML = rows.join('');

  const missing = PLAYERS_REQUIRED - net.players.length;
  $('btn-lobby-start').disabled = missing > 0;
  $('lobby-hint').textContent = missing > 0
    ? `Waiting for ${missing} more player${missing === 1 ? '' : 's'}…`
    : `All ${PLAYERS_REQUIRED} players in. ${net.isHost ? 'Start when you are.' : 'Waiting for the host…'}`;
}

$('btn-copy-code').onclick = async () => {
  try {
    await navigator.clipboard.writeText(net.code);
    toast('Code copied.');
  } catch {
    toast('Code: ' + net.code);
  }
};

$('btn-leave-lobby').onclick = () => {
  net.leave();
  show('screen-menu');
};

$('btn-lobby-start').onclick = () => {
  if (net.players.length < PLAYERS_REQUIRED) return;
  net.send('begin');
};

net.on('roster', renderLobby);

// The host holds the wins and generates the targets. If it disappears mid-game
// there is no round to wait for, so say so instead of spinning forever.
net.on('host-left', () => {
  net.leave();
  toast('The host left the party.');
  setTimeout(() => location.reload(), 1600);
});

net.on('net-trouble', () => toast('Reconnecting…'));

net.on('begin', () => {
  G.wins = {};
  net.players.forEach(p => { G.wins[p.id] = 0; });
  if (net.isHost) H.wins = { ...G.wins };
  startTutorial();
  show('screen-instructions');
});

/* ============================================================
   ANIMATED TUTORIAL (instructions screen)
   ============================================================ */

let tutorialTimers = [];

function clearTutorial() {
  tutorialTimers.forEach(clearTimeout);
  tutorialTimers = [];
}
const after = (ms, fn) => tutorialTimers.push(setTimeout(fn, ms));

function startTutorial() {
  clearTutorial();
  loopTutorial();
}

/** One pass: target appears → finger taps → timer runs → finger taps →
 *  timer stops → difference shown. Then it repeats. */
function loopTutorial() {
  const finger = $('demo-finger'), ripple = $('demo-ripple');
  const timerEl = $('demo-timer'), diffEl = $('demo-diff'), targetEl = $('demo-target');

  const DEMO_TARGET = TUTORIAL_TARGET;
  const DEMO_STOP = TUTORIAL_TARGET + 0.12;   // where our imaginary player lands
  const SPEED = 3.4;        // compress the attempt into ~1.2s of animation

  const place = (x, y) => {
    const box = $('demo').getBoundingClientRect();
    finger.style.left = (x - 15) + 'px';
    finger.style.top = (y - 15) + 'px';
    ripple.style.left = (x - 15) + 'px';
    ripple.style.top = (y - 15) + 'px';
    void box;
  };

  const tap = () => {
    finger.classList.remove('tapping'); void finger.offsetWidth;
    finger.classList.add('tapping');
    ripple.classList.remove('go'); void ripple.offsetWidth;
    ripple.classList.add('go');
  };

  // reset
  timerEl.textContent = '0.00';
  timerEl.style.color = 'var(--text)';
  diffEl.textContent = '';
  targetEl.textContent = fmt2(DEMO_TARGET) + 's';   // keep markup and constant in step
  finger.style.opacity = '0';

  const W = $('demo').clientWidth || 300;
  const H_ = $('demo').clientHeight || 168;

  after(500, () => { place(W * 0.72, H_ * 0.72); finger.style.opacity = '1'; });
  after(900, () => { tap(); });                        // tap 1 — start

  after(1000, () => {                                   // timer runs
    const t0 = performance.now();
    const tick = () => {
      const el = ((performance.now() - t0) / 1000) * SPEED;
      if (el >= DEMO_STOP) { timerEl.textContent = fmt2(DEMO_STOP); return; }
      timerEl.textContent = fmt2(el);
      tutorialRaf = requestAnimationFrame(tick);
    };
    tick();
  });

  after(1000 + (DEMO_STOP / SPEED) * 1000, () => {      // tap 2 — stop
    tap();
    timerEl.style.color = 'var(--brick)';
    // The label belongs to the target above it, which never changes. The
    // running number below is the player's time — recolouring it is what
    // marks it as their result.
  });

  after(1000 + (DEMO_STOP / SPEED) * 1000 + 380, () => {
    finger.style.opacity = '0';
    const diff = round2(Math.abs(DEMO_STOP - DEMO_TARGET));
    diffEl.textContent = `${fmt2(diff)} seconds away from ${fmt2(DEMO_TARGET)}`;
  });

  after(4200, loopTutorial);
}

let tutorialRaf;

$('btn-to-practice').onclick = () => {
  clearTutorial();
  cancelAnimationFrame(tutorialRaf);
  startPractice();
};

/* ============================================================
   TAP ENGINE — shared by practice, official, tiebreak
   ============================================================ */

const Tap = {
  state: 'locked',   // 'idle' | 'running' | 'armed' | 'done' | 'locked'
  t0: 0,
  raf: 0,
  armTimer: 0,
  onStop: null,      // (elapsedMs) => void
};

function tapReset(enabled) {
  clearTimeout(Tap.armTimer);
  cancelAnimationFrame(Tap.raf);
  Tap.state = enabled ? 'idle' : 'locked';
  Tap.t0 = 0;

  const zone = $('tapzone');
  zone.classList.remove('running', 'done');
  $('tap-idle').classList.toggle('hidden', !enabled);
  $('tap-running').classList.add('hidden');
  $('tap-done').classList.add('hidden');
  $('timer').textContent = '0.00';
  $('timer').classList.remove('start-pop');
}

function tapStart() {
  Tap.state = 'running';
  Tap.t0 = performance.now();

  // Both instructions vanish the instant the timer starts. Nothing on screen
  // tells the player to stop — that's the game.
  $('tap-idle').classList.add('hidden');
  $('tap-running').classList.remove('hidden');
  $('tapzone').classList.add('running');

  const t = $('timer');
  t.classList.remove('start-pop'); void t.offsetWidth; t.classList.add('start-pop');

  const tick = () => {
    if (Tap.state !== 'running' && Tap.state !== 'armed') return;
    t.textContent = fmt2((performance.now() - Tap.t0) / 1000);
    Tap.raf = requestAnimationFrame(tick);
  };
  tick();
}

function tapStop() {
  const elapsed = performance.now() - Tap.t0;
  Tap.state = 'done';
  cancelAnimationFrame(Tap.raf);
  clearTimeout(Tap.armTimer);

  $('tap-running').classList.add('hidden');
  $('tap-done').classList.remove('hidden');
  $('tapzone').classList.remove('running');
  $('tapzone').classList.add('done');

  if (Tap.onStop) Tap.onStop(elapsed);
}

(function bindTapZone() {
  const zone = $('tapzone');

  zone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (Tap.state === 'idle') {
      tapStart();
    } else if (Tap.state === 'armed') {
      tapStop();
    }
    // 'running' means the finger from the starting tap is still down, or the
    // arm delay hasn't elapsed. Either way this tap does nothing.
  });

  const release = () => {
    // Arm only once the finger is fully lifted, then only after a beat.
    if (Tap.state !== 'running') return;
    clearTimeout(Tap.armTimer);
    Tap.armTimer = setTimeout(() => {
      if (Tap.state === 'running') Tap.state = 'armed';
    }, ARM_DELAY_MS);
  };

  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointercancel', release);
  zone.addEventListener('pointerleave', release);
  zone.addEventListener('contextmenu', (e) => e.preventDefault());
})();

/* ============================================================
   ROUND SCREEN — rendering
   ============================================================ */

function renderProgress() {
  if (G.practicing) { $('round-progress').innerHTML = ''; return; }
  $('round-progress').innerHTML = net.players.map(p => {
    const w = G.wins[p.id] || 0;
    const me = p.id === net.me.id ? ' me' : '';
    return `<span class="progress-chip${me}"><b>${p.name}</b> ${w} ${w === 1 ? 'Win' : 'Wins'}</span>`;
  }).join('');
}

function openRound({ round, target, tiebreak, practice }) {
  G.practicing = !!practice;
  G.tiebreak = !!tiebreak;
  G.round = round;
  G.target = target;

  $('tb-banner').classList.toggle('hidden', !tiebreak);
  $('round-head-normal').classList.toggle('hidden', !!tiebreak);

  if (practice) {
    $('round-label').textContent = 'Practice Round';
    $('round-sub').textContent = 'This round does not count.';
    $('round-sub').classList.remove('hidden');
  } else if (!tiebreak) {
    $('round-label').textContent = `Round ${round} of ${OFFICIAL_ROUNDS}`;
    $('round-sub').classList.add('hidden');
  }

  $('round-target').innerHTML = `${fmt2(target)}<span class="u">seconds</span>`;
  $('round-foot').innerHTML = '';
  renderProgress();
  tapReset(true);
  show('screen-round');
}

/** Shared by every round type: show the player their own locked-in result. */
function showOwnResult(elapsedMs) {
  const secs = round2(elapsedMs / 1000);
  const diff = round2(Math.abs(secs - G.target));
  $('timer-final').textContent = fmt2(secs);
  $('result-you').textContent = `Your Time: ${fmt2(secs)} seconds`;
  $('result-diff').textContent = `You were ${fmt2(diff)} seconds away!`;
  return { secs, diff };
}

/* ============================================================
   PRACTICE
   ============================================================ */

function startPractice() {
  openRound({ round: 0, target: TUTORIAL_TARGET, practice: true });

  Tap.onStop = (elapsed) => {
    showOwnResult(elapsed);
    // One attempt only — the practice round is a demonstration, not a warm-up
    // to grind, so the sole way out is forward into the game.
    $('round-foot').innerHTML = `
      <div class="btn-stack card-pop">
        <button class="btn btn-primary" id="btn-practice-done">Start Game</button>
      </div>`;
    $('btn-practice-done').onclick = () => {
      G.practicing = false;
      net.send('ready-official');
      openWaiting('Waiting for Other Players…', 'The game starts when everyone is ready.');
    };
  };
}

/* ============================================================
   WAITING SCREEN
   ============================================================ */

function openWaiting(title, sub, onlyIds = null) {
  $('waiting-title').textContent = title;
  $('waiting-sub').textContent = sub;
  const list = onlyIds ? net.players.filter(p => onlyIds.includes(p.id)) : net.players;
  $('waiting-players').innerHTML = list.map(p => `
    <div class="player-row">
      <div class="avatar">${initials(p.name)}</div>
      <div><div class="player-name">${p.name}${p.id === net.me.id ? ' (You)' : ''}</div></div>
      <div class="player-meta">${(G.wins[p.id] || 0)} ${(G.wins[p.id] || 0) === 1 ? 'Win' : 'Wins'}</div>
    </div>`).join('');
  show('screen-waiting');
}

/* ============================================================
   OFFICIAL + TIEBREAK ROUNDS  (all peers)
   ============================================================ */

net.on('round-start', (m) => {
  G.wins = m.wins;
  G.participants = m.participants;

  // Sitting out a tiebreak: watch, don't play.
  if (!m.participants.includes(net.me.id)) {
    openWaiting('Tiebreak in Progress…', 'The tied players are settling it.', m.participants);
    return;
  }

  openRound({ round: m.round, target: m.target, tiebreak: m.tiebreak });

  Tap.onStop = (elapsed) => {
    const { secs } = showOwnResult(elapsed);
    net.send('result', { round: m.round, timeMs: elapsed, secs });
    $('round-foot').innerHTML = `
      <div class="waiting">
        <span>Waiting for Other Players</span>
        <span class="dots"><i></i><i></i><i></i></span>
      </div>`;
  };
});

net.on('round-results', (m) => {
  if (!m.rows.some(r => r.id === net.me.id)) return;  // not our tiebreak

  G.wins = m.wins;
  const iWon = m.winners.includes(net.me.id);

  $('verdict').textContent = iWon ? 'Winner!' : 'Almost Had It!';
  $('verdict').className = 'verdict mb-4 ' + (iWon ? 'win' : 'lose');
  $('results-head').textContent = m.tiebreak
    ? 'Tiebreak Results'
    : `Round ${m.round} Results`;

  $('results-list').innerHTML = m.rows.map((r, i) => {
    const p = net.players.find(x => x.id === r.id);
    const won = m.winners.includes(r.id);
    return `
      <div class="rank-row">
        <span class="rank-i">${i + 1}.</span>
        <span class="rank-name ${won ? 'win' : 'lose'}">${p ? p.name : 'Player'}</span>
        <span class="rank-stats"><span class="t">${fmt2(r.secs)}s</span> · ${fmt2(r.diff)} away</span>
      </div>`;
  }).join('');

  const last = !m.tiebreak && m.round >= OFFICIAL_ROUNDS;
  const btn = $('btn-next-round');
  btn.textContent = m.tiebreak ? 'See Result' : (last ? 'See Final Results' : 'Next Round');
  btn.classList.remove('hidden');
  btn.disabled = false;
  $('results-waiting').classList.add('hidden');

  const card = document.querySelector('#screen-results .card');
  card.classList.remove('card-pop'); void card.offsetWidth; card.classList.add('card-pop');

  show('screen-results');
});

$('btn-next-round').onclick = () => {
  net.send('next-ready');
  $('btn-next-round').classList.add('hidden');
  $('results-waiting').classList.remove('hidden');
};

/* ============================================================
   FINAL
   ============================================================ */

net.on('final', (m) => {
  G.finalWinnerId = m.winnerId;
  G.wins = m.wins;
  const iWon = m.winnerId === net.me.id;

  $('final-verdict').textContent = iWon ? 'You Won!' : 'Great Game!';
  $('final-verdict').className = 'verdict mb-4 ' + (iWon ? 'win' : 'final-lose');
  $('final-trophy').classList.toggle('hidden', !iWon);

  $('final-list').innerHTML = m.standings.map((s, i) => {
    const p = net.players.find(x => x.id === s.id);
    const isWinner = s.id === m.winnerId;
    // Losers here are brown/taupe, never red — the game is over, nobody's blamed.
    const cls = isWinner ? 'win' : (i === 1 ? 'neutral' : 'neutral-muted');
    const tb = (isWinner && m.viaTiebreak) ? ` <span class="tb-tag">— Tiebreak</span>` : '';
    return `
      <div class="rank-row">
        <span class="rank-i">${i + 1}.</span>
        <span class="rank-name ${cls}">${p ? p.name : 'Player'}</span>
        <span class="rank-stats"><span class="t">${s.wins} ${s.wins === 1 ? 'Win' : 'Wins'}</span>${tb}</span>
      </div>`;
  }).join('');

  $('btn-play-again').classList.remove('hidden');
  $('btn-menu').classList.remove('hidden');
  $('final-waiting').classList.add('hidden');
  show('screen-final');
});

$('btn-play-again').onclick = () => {
  net.send('again-ready');
  $('btn-play-again').classList.add('hidden');
  $('btn-menu').classList.add('hidden');
  $('final-waiting').classList.remove('hidden');
};

$('btn-menu').onclick = () => {
  net.leave();
  location.reload();   // cleanest way back to a fresh menu
};

/* ============================================================
   HOST AUTHORITY
   ============================================================ */

function hostExpect(ids, stage) {
  H.stage = stage;
  H.waitingFor = new Set(ids);
}

/** Drop players who left, so a disconnect can't deadlock the round. */
function hostPrune() {
  const live = new Set(net.players.map(p => p.id));
  for (const id of [...H.waitingFor]) if (!live.has(id)) H.waitingFor.delete(id);
}

function hostStartRound(round, participants, tiebreak) {
  H.results = {};
  hostExpect(participants, 'results');
  net.send('round-start', {
    round,
    target: makeTarget(),      // generated ONCE, here, and sent to everyone
    tiebreak,
    participants,
    wins: H.wins,
  });
}

if (true) {
  net.on('ready-official', (m) => {
    if (!net.isHost) return;
    if (H.stage !== 'ready') hostExpect(net.players.map(p => p.id), 'ready');
    H.waitingFor.delete(m.from);
    hostPrune();
    if (H.waitingFor.size === 0) {
      hostStartRound(1, net.players.map(p => p.id), false);
    }
  });

  net.on('result', (m) => {
    if (!net.isHost || H.stage !== 'results') return;
    const secs = round2(m.timeMs / 1000);
    H.results[m.from] = { id: m.from, timeMs: m.timeMs, secs, diff: round2(Math.abs(secs - G.target)) };
    H.waitingFor.delete(m.from);
    hostPrune();
    if (H.waitingFor.size === 0) hostFinishRound();
  });

  net.on('next-ready', (m) => {
    if (!net.isHost || H.stage !== 'next') return;
    H.waitingFor.delete(m.from);
    hostPrune();
    if (H.waitingFor.size === 0) hostAdvance();
  });

  net.on('again-ready', (m) => {
    if (!net.isHost) return;
    if (H.stage !== 'again') hostExpect(net.players.map(p => p.id), 'again');
    H.waitingFor.delete(m.from);
    hostPrune();
    if (H.waitingFor.size === 0) {
      H.wins = {};
      net.players.forEach(p => { H.wins[p.id] = 0; });
      hostStartRound(1, net.players.map(p => p.id), false);
    }
  });
}

function hostFinishRound() {
  const rows = Object.values(H.results).sort((a, b) => a.diff - b.diff);
  if (!rows.length) return;

  // Everyone tied at the smallest difference wins the round. Comparing the
  // rounded 2-decimal diffs (not raw ms) means a tie on screen is a tie in
  // the tally — no invisible hundredths deciding it.
  const best = rows[0].diff;
  const winners = rows.filter(r => r.diff === best).map(r => r.id);

  if (!G.tiebreak) winners.forEach(id => { H.wins[id] = (H.wins[id] || 0) + 1; });

  H.lastWinners = winners;
  hostExpect(rows.map(r => r.id), 'next');

  net.send('round-results', {
    round: G.round,
    tiebreak: G.tiebreak,
    rows: rows.map(({ id, secs, diff }) => ({ id, secs, diff })),
    winners,
    wins: H.wins,
  });
}

/** Called once every player has pressed Next Round. Decides what comes next. */
function hostAdvance() {
  if (G.tiebreak) {
    if (H.lastWinners.length === 1) return hostFinal(H.lastWinners[0], true);
    return hostStartRound(G.round + 1, H.lastWinners, true);  // still tied — go again
  }

  if (G.round < OFFICIAL_ROUNDS) {
    return hostStartRound(G.round + 1, net.players.map(p => p.id), false);
  }

  // Five rounds done — most wins takes it, unless it's tied at the top.
  const top = Math.max(...net.players.map(p => H.wins[p.id] || 0));
  const leaders = net.players.filter(p => (H.wins[p.id] || 0) === top).map(p => p.id);
  if (leaders.length === 1) return hostFinal(leaders[0], false);
  hostStartRound(G.round + 1, leaders, true);
}

/** viaTiebreak: the winner didn't out-win the field, they out-timed it in
 *  sudden death. The final board says so — otherwise a 2-2-2 board looks
 *  like the winner was picked at random. */
function hostFinal(winnerId, viaTiebreak) {
  const standings = net.players
    .map(p => ({ id: p.id, wins: H.wins[p.id] || 0 }))
    .sort((a, b) => (b.id === winnerId) - (a.id === winnerId) || b.wins - a.wins);
  hostExpect([], 'done');
  net.send('final', { winnerId, standings, wins: H.wins, viaTiebreak: !!viaTiebreak });
}

/* ---------- boot ---------- */

show('screen-menu');
