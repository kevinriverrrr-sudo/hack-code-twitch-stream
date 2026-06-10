const express = require('express');
const { spawn } = require('child_process');
const { createCanvas, loadImage } = require('canvas');
const Database = require('better-sqlite3');
const tmi = require('tmi.js');
const fs = require('fs');

// ========== ERROR HANDLERS ==========
process.on('uncaughtException', e => console.error('[UNCAUGHT]', e.message || e));
process.on('unhandledRejection', e => console.error('[UNHANDLED]', e));

// ========== DATABASE ==========
const db = new Database(process.env.DB_PATH || '/app/data/game.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    score INTEGER DEFAULT 0,
    correct_guesses INTEGER DEFAULT 0,
    total_attempts INTEGER DEFAULT 0,
    last_active TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    password TEXT NOT NULL,
    excluded_digits TEXT,
    hint TEXT,
    winner_id INTEGER REFERENCES players(id),
    winner_score INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    guessed_at TEXT,
    duration_seconds INTEGER
  );
`);

const stmtUpsertPlayer = db.prepare(`INSERT INTO players (username, display_name, avatar_url, last_active) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(username) DO UPDATE SET display_name = COALESCE(excluded.display_name, players.display_name), avatar_url = COALESCE(excluded.avatar_url, players.avatar_url), last_active = datetime('now')`);
const stmtAddScore = db.prepare(`UPDATE players SET score = score + ?, correct_guesses = correct_guesses + 1 WHERE username = ?`);
const stmtAddAttempt = db.prepare(`UPDATE players SET total_attempts = total_attempts + 1, last_active = datetime('now') WHERE username = ?`);
const stmtTopPlayers = db.prepare(`SELECT username, display_name, avatar_url, score, correct_guesses FROM players ORDER BY score DESC, correct_guesses DESC LIMIT 10`);
const stmtGetPlayer = db.prepare(`SELECT * FROM players WHERE username = ?`);
const stmtInsertRound = db.prepare(`INSERT INTO rounds (password, excluded_digits, hint, attempts) VALUES (?, ?, ?, ?)`);
const stmtUpdateRoundWinner = db.prepare(`UPDATE rounds SET winner_id = ?, winner_score = ?, guessed_at = datetime('now'), duration_seconds = ? WHERE id = ?`);

// ========== GAME STATE ==========
const state = {
  phase: 'idle', // idle | playing | hacked | winner_message
  password: '',
  excludedDigits: [],
  hint: '',
  roundId: 0,
  roundNumber: 0,
  roundStartTime: 0,
  attempts: 0,
  totalAttempts: 0,
  // Points system: starts at 100,000, decreases over time
  basePoints: 100000,
  currentPoints: 100000,
  pointsDecreaseRate: 500, // per second
  minPoints: 1000,
  // Flash effects
  wrongFlashAlpha: 0,
  correctFlashAlpha: 0,
  // Winner state
  hackedBy: null,
  winnerWaiting: false,
  winnerMessage: null,
  winnerWaitStart: 0,
  winnerScore: 0,
  // Leaderboard
  leaderboard: [],
  // Chat
  chatMessages: [],
  chatQueue: [],
  // Visual effects
  particles: [],
  matrixDrops: [],
  glitchTimer: 0,
  streamUptime: 0,
  pulsePhase: 0,
  digitRevealIndex: -1,
  digitRevealTimer: 0,
  // Lock animation
  lockShake: 0,
  lockUnlockAnim: 0,
  // Neon glow animation
  neonPhase: 0,
};

// ========== AI PASSWORD GENERATION ==========
const FW_URL = 'https://api.fireworks.ai/inference/v1/chat/completions';
const FW_KEY = process.env.FW_KEY || 'fw_BbPBdfe14cvqLmodY74kEN';
const FW_MODEL = 'accounts/fireworks/models/gpt-oss-20b';

const FALLBACK_PASSWORDS = [
  { password: '1961', hint: 'Год первого полёта человека в космос' },
  { password: '1812', hint: 'Год Бородинского сражения' },
  { password: '1945', hint: 'Год окончания Великой Отечественной войны' },
  { password: '1492', hint: 'Год открытия Америки Колумбом' },
  { password: '1980', hint: 'Год Олимпиады в Москве' },
  { password: '2014', hint: 'Год зимней Олимпиады в Сочи' },
  { password: '2018', hint: 'Год Чемпионата мира по футболу в России' },
  { password: '1917', hint: 'Год Октябрьской революции' },
  { password: '1703', hint: 'Год основания Санкт-Петербурга' },
  { password: '1147', hint: 'Год первого упоминания Москвы' },
  { password: '1861', hint: 'Год отмены крепостного права' },
  { password: '1991', hint: 'Год распада СССР' },
  { password: '1969', hint: 'Год высадки человека на Луну' },
  { password: '2005', hint: 'Год запуска YouTube' },
  { password: '1998', hint: 'Год основания Google' },
  { password: '2007', hint: 'Год выхода первого iPhone' },
  { password: '1889', hint: 'Год строительства Эйфелевой башни' },
  { password: '2022', hint: 'Год зимней Олимпиады в Пекине' },
  { password: '1789', hint: 'Год взятия Бастилии' },
  { password: '2000', hint: 'Начало нового тысячелетия' },
];

function computeExcludedDigits(password) {
  const usedDigits = new Set(password.split('').filter(c => c >= '0' && c <= '9'));
  const allDigits = ['0','1','2','3','4','5','6','7','8','9'];
  const available = allDigits.filter(d => !usedDigits.has(d));
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }
  return available.slice(0, 5);
}

async function generatePassword() {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(FW_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FW_KEY}` },
      body: JSON.stringify({
        model: FW_MODEL, max_tokens: 200, temperature: 0.9,
        messages: [
          { role: 'system', content: 'Generate a trivia question where the answer is exactly a 4-digit year or number. Respond ONLY with JSON: {"password":"4 digits","hint":"interesting hint in Russian"}' },
          { role: 'user', content: 'Generate a trivia question about history, science, sports, or culture where the answer is a 4-digit number.' },
        ],
      }),
    });
    clearTimeout(tid);
    const d = await r.json();
    const c = d.choices?.[0]?.message?.content || '';
    let p = null;
    try { p = JSON.parse(c); } catch {}
    if (!p) { const m = c.match(/\{[\s\S]*\}/); if (m) try { p = JSON.parse(m[0]); } catch {} }
    if (p?.password && /^\d{4}$/.test(p.password.trim()) && p?.hint) {
      return { password: p.password.trim(), hint: p.hint.trim() };
    }
    throw new Error('Invalid format');
  } catch (e) {
    console.log('[AI] Fallback password (error:', e.message + ')');
    return FALLBACK_PASSWORDS[Math.floor(Math.random() * FALLBACK_PASSWORDS.length)];
  }
}

// ========== TWITCH CHAT ==========
const twitchClient = new tmi.Client({
  channels: [process.env.TWITCH_CHANNEL || 'mazafakezo'],
  connection: { reconnect: true, maxReconnectAttempts: Infinity },
});

twitchClient.on('connected', () => console.log(`[TWITCH] Connected to chat #${process.env.TWITCH_CHANNEL || 'mazafakezo'}`));
twitchClient.on('disconnected', () => console.log('[TWITCH] Disconnected from chat'));

twitchClient.on('message', (channel, tags, message, self) => {
  if (self) return;
  const username = tags.username || '';
  const displayName = tags['display-name'] || username;
  const msg = message.trim();
  if (!username || !msg) return;

  // Add to chat queue for display
  state.chatQueue.push({
    username, displayName, message: msg,
    timestamp: Date.now(),
    color: tags.color || null,
  });

  // Record player in DB
  try { stmtUpsertPlayer.run(username, displayName, null); } catch(e) {}

  // If game is playing, check guesses
  if (state.phase === 'playing') {
    const guess = msg.replace(/\s/g, '');
    if (/^\d{4}$/.test(guess)) {
      state.attempts++;
      state.totalAttempts++;
      try { stmtAddAttempt.run(username); } catch(e) {}

      if (guess === state.password) {
        handleCorrectGuess(username, displayName);
      } else {
        state.wrongFlashAlpha = 1.0;
        state.lockShake = 8;
      }
    }
  }

  // Winner message
  if (state.phase === 'winner_message' && state.hackedBy?.username === username) {
    if (!state.winnerMessage || state.winnerMessage === '__ABSTAIN__') {
      state.winnerMessage = msg;
      console.log(`[GAME] Winner ${displayName} says: ${msg}`);
    }
  }
});

let winnerMessageTimeout = null;

twitchClient.on('message', () => {
  // Check if winner sent message and schedule next round
  if (state.phase === 'winner_message' && state.winnerMessage && state.winnerMessage !== '__ABSTAIN__' && !winnerMessageTimeout) {
    winnerMessageTimeout = setTimeout(() => {
      winnerMessageTimeout = null;
      startNewRound();
    }, 6000);
  }
});

async function handleCorrectGuess(username, displayName) {
  const elapsed = (Date.now() - state.roundStartTime) / 1000;
  const earnedPoints = Math.max(state.minPoints, Math.floor(state.basePoints - elapsed * state.pointsDecreaseRate));

  console.log(`[GAME] HACKED by ${displayName}! Password: ${state.password}, Points: ${earnedPoints}`);

  state.phase = 'hacked';
  state.correctFlashAlpha = 1.0;
  state.hackedBy = { username, displayName };
  state.winnerScore = earnedPoints;
  state.digitRevealIndex = 0;
  state.digitRevealTimer = Date.now();
  state.lockUnlockAnim = 1.0;

  // Add score in DB
  try { stmtAddScore.run(earnedPoints, username); } catch(e) {}

  // Update round in DB
  try {
    const duration = Math.floor(elapsed);
    stmtUpdateRoundWinner.run(stmtGetPlayer.get(username)?.id, earnedPoints, duration, state.roundId);
  } catch(e) {}

  // Fetch avatar
  fetchTwitchAvatar(username);

  // Refresh leaderboard
  refreshLeaderboard();

  // Celebration particles
  for (let i = 0; i < 80; i++) {
    state.particles.push({
      x: 460 + (Math.random() - 0.5) * 200,
      y: 340,
      vx: (Math.random() - 0.5) * 10,
      vy: -Math.random() * 8 - 3,
      life: 1.0,
      color: ['#00ff88','#ffd700','#00d4ff','#ff3366','#ff8800','#a855f7'][Math.floor(Math.random()*6)],
      size: Math.random() * 5 + 2,
    });
  }

  // Transition to winner_message after digit reveal animation
  setTimeout(() => {
    state.phase = 'winner_message';
    state.winnerWaiting = true;
    state.winnerMessage = null;
    state.winnerWaitStart = Date.now();
    console.log('[GAME] Waiting for winner message...');
  }, 4500);

  // Auto-proceed if no message
  setTimeout(() => {
    if (state.phase === 'winner_message') {
      if (!state.winnerMessage || state.winnerMessage === '__ABSTAIN__') {
        state.winnerMessage = '__ABSTAIN__';
        console.log('[GAME] Winner chose to abstain');
      }
      if (!winnerMessageTimeout) {
        setTimeout(() => startNewRound(), 4000);
      }
    }
  }, 20000);
}

async function fetchTwitchAvatar(username) {
  try {
    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `query{user(login:"${username}"){profileImageURL(width:150)}}` }),
    });
    const data = await res.json();
    const url = data?.data?.user?.profileImageURL;
    if (url) {
      try { const img = await loadImage(url); state.hackedBy = { ...state.hackedBy, avatarImg: img }; } catch(e) {}
      try { db.prepare('UPDATE players SET avatar_url = ? WHERE username = ?').run(url, username); } catch(e) {}
    }
  } catch(e) {}
}

function refreshLeaderboard() {
  try { state.leaderboard = stmtTopPlayers.all(); } catch(e) { state.leaderboard = []; }
}

// ========== GAME FLOW ==========
async function startNewRound() {
  const pw = await generatePassword();
  state.password = pw.password;
  state.hint = pw.hint;
  state.excludedDigits = computeExcludedDigits(state.password);
  state.phase = 'playing';
  state.attempts = 0;
  state.roundNumber++;
  state.roundStartTime = Date.now();
  state.currentPoints = state.basePoints;
  state.wrongFlashAlpha = 0;
  state.correctFlashAlpha = 0;
  state.hackedBy = null;
  state.winnerWaiting = false;
  state.winnerMessage = null;
  state.winnerWaitStart = 0;
  state.winnerScore = 0;
  state.digitRevealIndex = -1;
  state.digitRevealTimer = 0;
  state.lockShake = 0;
  state.lockUnlockAnim = 0;
  winnerMessageTimeout = null;

  try {
    const info = stmtInsertRound.run(state.password, state.excludedDigits.join(','), state.hint, 0);
    state.roundId = info.lastInsertRowid;
  } catch(e) {}

  refreshLeaderboard();
  console.log(`[GAME] Round #${state.roundNumber}! Password: ${state.password}, Hint: ${state.hint}, Excluded: ${state.excludedDigits.join(',')}`);
}

// ========== CANVAS RENDERING ==========
const W = 1280, H = 720, FPS = 10;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// Initialize matrix drops
for (let i = 0; i < 50; i++) {
  state.matrixDrops.push({
    x: Math.random() * W,
    y: Math.random() * H,
    speed: Math.random() * 1.5 + 0.5,
    length: Math.floor(Math.random() * 12) + 5,
  });
}

// Font setup
const fontsLoaded = {
  main: false,
};
try {
  registerFont('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', { family: 'Noto Sans SC' });
  fontsLoaded.main = true;
} catch(e) {
  try {
    registerFont('/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', { family: 'Noto Sans SC' });
    fontsLoaded.main = true;
  } catch(e2) {
    try {
      registerFont('/usr/share/fonts/truetype/chinese/NotoSansSC[wght].ttf', { family: 'Noto Sans SC' });
      fontsLoaded.main = true;
    } catch(e3) {}
  }
}
try {
  registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', { family: 'DejaVu Sans' });
} catch(e) {}

function getFont(weight, size) {
  const family = fontsLoaded.main ? 'Noto Sans SC' : 'sans-serif';
  return `${weight} ${size}px ${family}, sans-serif`;
}

function renderFrame() {
  const now = Date.now();
  state.pulsePhase = (now % 4000) / 4000;
  state.neonPhase = (now % 2000) / 2000;

  // Update points decrease
  if (state.phase === 'playing') {
    const elapsed = (now - state.roundStartTime) / 1000;
    state.currentPoints = Math.max(state.minPoints, Math.floor(state.basePoints - elapsed * state.pointsDecreaseRate));
  }

  // ========== BACKGROUND ==========
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#030308');
  bgGrad.addColorStop(0.3, '#060614');
  bgGrad.addColorStop(0.7, '#080818');
  bgGrad.addColorStop(1, '#030308');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // ========== MATRIX RAIN ==========
  ctx.save();
  ctx.font = '11px monospace';
  state.matrixDrops.forEach(drop => {
    for (let i = 0; i < drop.length; i++) {
      const alpha = (1 - i / drop.length) * 0.07;
      ctx.fillStyle = `rgba(0,255,136,${alpha})`;
      const char = String.fromCharCode(0x30 + Math.floor(Math.random() * 10));
      ctx.fillText(char, drop.x, drop.y + i * 14);
    }
    drop.y += drop.speed;
    if (drop.y > H + drop.length * 14) { drop.y = -drop.length * 14; drop.x = Math.random() * W; }
  });
  ctx.restore();

  // ========== SCANLINES ==========
  ctx.save();
  ctx.globalAlpha = 0.025;
  for (let y = 0; y < H; y += 2) { ctx.fillStyle = '#000'; ctx.fillRect(0, y, W, 1); }
  ctx.restore();

  // ========== TOP BAR ==========
  // Dark gradient bar
  const topBarGrad = ctx.createLinearGradient(0, 0, 0, 60);
  topBarGrad.addColorStop(0, 'rgba(0,0,0,0.8)');
  topBarGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = topBarGrad;
  ctx.fillRect(0, 0, W, 60);

  // LIVE indicator with pulse
  const livePulse = 0.5 + 0.5 * Math.sin(now / 400);
  ctx.save();
  ctx.fillStyle = `rgba(255,51,102,${0.8 + 0.2 * livePulse})`;
  ctx.beginPath();
  ctx.arc(28, 30, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#ff3366';
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('LIVE', 42, 35);

  // Title with glitch effect
  ctx.save();
  ctx.shadowColor = '#00d4ff';
  ctx.shadowBlur = 15 + 5 * Math.sin(now / 600);
  ctx.fillStyle = '#ffffff';
  ctx.font = getFont('800', 28);
  ctx.textAlign = 'center';
  ctx.fillText('ВЗЛОМАЙ КОД', W / 2 - 100, 38);
  ctx.restore();

  // Subtitle
  ctx.fillStyle = 'rgba(0,212,255,0.5)';
  ctx.font = getFont('400', 13);
  ctx.textAlign = 'center';
  ctx.fillText('ЧАТ ПРОТИВ СИСТЕМЫ', W / 2 - 100, 55);

  // ========== ROUND & ATTEMPTS (top right) ==========
  ctx.textAlign = 'right';

  // Round badge
  ctx.save();
  const roundGrad = ctx.createLinearGradient(W - 200, 8, W - 10, 8);
  roundGrad.addColorStop(0, 'rgba(0,212,255,0.1)');
  roundGrad.addColorStop(1, 'rgba(0,212,255,0.05)');
  ctx.fillStyle = roundGrad;
  roundRect(ctx, W - 200, 8, 190, 28, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,212,255,0.3)';
  ctx.lineWidth = 1;
  roundRect(ctx, W - 200, 8, 190, 28, 6);
  ctx.stroke();
  ctx.fillStyle = 'rgba(0,212,255,0.7)';
  ctx.font = getFont('600', 12);
  ctx.textAlign = 'center';
  ctx.fillText(`РАУНД #${state.roundNumber || '?'}`, W - 105, 27);
  ctx.restore();

  // ========== MAIN GAME AREA (left/center) ==========
  const gameX = 30, gameW = 850;

  // ========== HINT BOX ==========
  const hintY = 75;
  ctx.save();
  const hintGrad = ctx.createLinearGradient(gameX, hintY, gameX + gameW, hintY);
  hintGrad.addColorStop(0, 'rgba(0,212,255,0.06)');
  hintGrad.addColorStop(0.5, 'rgba(0,212,255,0.03)');
  hintGrad.addColorStop(1, 'rgba(0,212,255,0.06)');
  ctx.fillStyle = hintGrad;
  roundRect(ctx, gameX, hintY, gameW, 55, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,212,255,0.15)';
  ctx.lineWidth = 1;
  roundRect(ctx, gameX, hintY, gameW, 55, 8);
  ctx.stroke();

  // Hint icon
  ctx.fillStyle = 'rgba(0,212,255,0.5)';
  ctx.font = getFont('600', 11);
  ctx.textAlign = 'left';
  ctx.fillText('\u2139 ПОДСКАЗКА', gameX + 15, hintY + 18);
  ctx.fillStyle = '#e0e0e0';
  ctx.font = getFont('700', 17);
  ctx.fillText(state.hint || 'Загрузка...', gameX + 15, hintY + 43);
  ctx.restore();

  // ========== POINTS DISPLAY ==========
  const pointsY = hintY + 68;
  ctx.save();
  const ptsGrad = ctx.createLinearGradient(gameX, pointsY, gameX + gameW / 2, pointsY);
  ptsGrad.addColorStop(0, 'rgba(255,215,0,0.06)');
  ptsGrad.addColorStop(1, 'rgba(255,215,0,0.02)');
  ctx.fillStyle = ptsGrad;
  roundRect(ctx, gameX, pointsY, gameW / 2 - 10, 50, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,215,0,0.15)';
  ctx.lineWidth = 1;
  roundRect(ctx, gameX, pointsY, gameW / 2 - 10, 50, 8);
  ctx.stroke();

  // Points value with animation
  const ptsColor = state.currentPoints > 50000 ? '#ffd700' :
                   state.currentPoints > 20000 ? '#ff8800' :
                   state.currentPoints > 5000 ? '#ff5544' : '#ff3366';
  ctx.fillStyle = 'rgba(255,215,0,0.5)';
  ctx.font = getFont('600', 11);
  ctx.textAlign = 'left';
  ctx.fillText('НАГРАДА', gameX + 15, pointsY + 18);
  ctx.fillStyle = ptsColor;
  ctx.font = getFont('800', 22);
  ctx.shadowColor = ptsColor;
  ctx.shadowBlur = 10;
  ctx.fillText(`${state.currentPoints.toLocaleString('ru-RU')} баллов`, gameX + 15, pointsY + 44);
  ctx.restore();

  // Points decrease bar
  ctx.save();
  const barX = gameX + gameW / 2 + 10, barY = pointsY;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  roundRect(ctx, barX, barY, gameW / 2 - 40, 50, 8);
  ctx.fill();

  const progress = (state.currentPoints - state.minPoints) / (state.basePoints - state.minPoints);
  ctx.fillStyle = 'rgba(20,20,30,0.5)';
  roundRect(ctx, barX + 10, barY + 28, gameW / 2 - 60, 12, 4);
  ctx.fill();

  const barGrad = ctx.createLinearGradient(barX + 10, 0, barX + 10 + (gameW / 2 - 60) * progress, 0);
  barGrad.addColorStop(0, ptsColor);
  barGrad.addColorStop(1, `${ptsColor}88`);
  ctx.fillStyle = barGrad;
  roundRect(ctx, barX + 10, barY + 28, (gameW / 2 - 60) * Math.max(0.02, progress), 12, 4);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = getFont('600', 11);
  ctx.textAlign = 'left';
  ctx.fillText('Шанс награды', barX + 15, barY + 20);
  ctx.restore();

  // ========== PASSWORD SLOTS ==========
  const slotY = pointsY + 65;
  const slotW = 85, slotH = 105, slotGap = 18;
  const totalSlotsW = 4 * slotW + 3 * slotGap;
  const slotStartX = gameX + (gameW - totalSlotsW) / 2;

  // "ВВЕДИТЕ КОД" label
  ctx.save();
  ctx.fillStyle = 'rgba(0,212,255,0.6)';
  ctx.font = getFont('700', 14);
  ctx.textAlign = 'center';
  ctx.letterSpacing = '3px';
  ctx.fillText('ВВЕДИТЕ КОД', gameX + gameW / 2, slotY - 8);
  ctx.restore();

  // Shake offset
  let shakeX = 0, shakeY = 0;
  if (state.lockShake > 0) {
    shakeX = (Math.random() - 0.5) * state.lockShake;
    shakeY = (Math.random() - 0.5) * state.lockShake;
    state.lockShake = Math.max(0, state.lockShake - 0.5);
  }

  for (let i = 0; i < 4; i++) {
    const sx = slotStartX + i * (slotW + slotGap) + shakeX;
    const sy = slotY + shakeY;
    const isRevealed = (state.phase === 'hacked' || state.phase === 'winner_message') && state.digitRevealIndex >= i;
    const pulse = Math.sin(state.pulsePhase * Math.PI * 2 + i * 0.7) * 0.15 + 0.85;

    ctx.save();
    // Slot background
    if (isRevealed) {
      const revGrad = ctx.createLinearGradient(sx, sy, sx, sy + slotH);
      revGrad.addColorStop(0, 'rgba(0,255,136,0.12)');
      revGrad.addColorStop(1, 'rgba(0,255,136,0.04)');
      ctx.fillStyle = revGrad;
    } else if (state.wrongFlashAlpha > 0) {
      const wrongGrad = ctx.createLinearGradient(sx, sy, sx, sy + slotH);
      wrongGrad.addColorStop(0, `rgba(255,51,102,${0.15 * state.wrongFlashAlpha})`);
      wrongGrad.addColorStop(1, `rgba(255,51,102,${0.05 * state.wrongFlashAlpha})`);
      ctx.fillStyle = wrongGrad;
    } else {
      const slotGrad = ctx.createLinearGradient(sx, sy, sx, sy + slotH);
      slotGrad.addColorStop(0, 'rgba(15,15,35,0.95)');
      slotGrad.addColorStop(1, 'rgba(8,8,25,0.95)');
      ctx.fillStyle = slotGrad;
    }
    roundRect(ctx, sx, sy, slotW, slotH, 8);
    ctx.fill();

    // Border with glow
    let borderColor, glowColor, glowSize;
    if (isRevealed) {
      borderColor = 'rgba(0,255,136,0.8)';
      glowColor = '#00ff88';
      glowSize = 15;
    } else if (state.wrongFlashAlpha > 0.3) {
      borderColor = `rgba(255,51,102,${0.9 * state.wrongFlashAlpha})`;
      glowColor = '#ff3366';
      glowSize = 20;
    } else {
      borderColor = `rgba(0,212,255,${0.25 * pulse + 0.1})`;
      glowColor = '#00d4ff';
      glowSize = 8;
    }
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = glowSize;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    roundRect(ctx, sx, sy, slotW, slotH, 8);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();

    // Digit content
    ctx.textAlign = 'center';
    if (isRevealed && state.password[i]) {
      ctx.save();
      ctx.shadowColor = '#00ff88';
      ctx.shadowBlur = 20;
      ctx.fillStyle = '#00ff88';
      ctx.font = 'bold 50px monospace';
      ctx.fillText(state.password[i], sx + slotW / 2, sy + slotH / 2 + 18);
      ctx.restore();
    } else {
      ctx.fillStyle = `rgba(0,212,255,${0.25 + 0.15 * Math.sin(state.pulsePhase * Math.PI * 2 + i)})`;
      ctx.font = 'bold 44px monospace';
      ctx.fillText('?', sx + slotW / 2, sy + slotH / 2 + 16);
    }
  }

  // Wrong flash overlay
  if (state.wrongFlashAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = state.wrongFlashAlpha * 0.08;
    ctx.fillStyle = '#ff3366';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    state.wrongFlashAlpha = Math.max(0, state.wrongFlashAlpha - 0.03);
  }

  // ========== LOCK ICON ==========
  const lockX = slotStartX + totalSlotsW + 20;
  const lockY = slotY + slotH / 2;

  ctx.save();
  ctx.textAlign = 'center';
  if (state.lockUnlockAnim > 0) {
    // Unlocked - green glow
    ctx.shadowColor = '#00ff88';
    ctx.shadowBlur = 30 * state.lockUnlockAnim;
    ctx.fillStyle = `rgba(0,255,136,${0.3 + 0.7 * state.lockUnlockAnim})`;
    ctx.font = '42px sans-serif';
    ctx.fillText('\uD83D\uDD13', lockX + 25, lockY + 14); // unlocked
    state.lockUnlockAnim = Math.max(0, state.lockUnlockAnim - 0.008);
  } else {
    // Locked - with subtle glow
    ctx.shadowColor = '#00d4ff';
    ctx.shadowBlur = 8 + 4 * Math.sin(now / 800);
    ctx.fillStyle = 'rgba(0,212,255,0.6)';
    ctx.font = '42px sans-serif';
    ctx.fillText('\uD83D\uDD12', lockX + 25, lockY + 14); // locked
  }
  ctx.restore();

  // ========== ACCESS STATUS ==========
  const statusY = slotY + slotH + 12;
  ctx.save();
  ctx.textAlign = 'center';
  if (state.phase === 'hacked' || state.phase === 'winner_message') {
    ctx.shadowColor = '#00ff88';
    ctx.shadowBlur = 15;
    ctx.fillStyle = '#00ff88';
    ctx.font = getFont('800', 16);
    ctx.fillText('ДОСТУП РАЗРЕШЁН', gameX + gameW / 2, statusY + 12);
  } else {
    const accessPulse = 0.5 + 0.5 * Math.sin(now / 600);
    ctx.shadowColor = '#ff3366';
    ctx.shadowBlur = 8 * accessPulse;
    ctx.fillStyle = `rgba(255,51,102,${0.5 + 0.5 * accessPulse})`;
    ctx.font = getFont('800', 16);
    ctx.fillText('ДОСТУП ЗАПРЕЩЁН', gameX + gameW / 2, statusY + 12);
  }
  ctx.restore();

  // ========== EXCLUDED DIGITS ==========
  const exclY = statusY + 25;
  ctx.save();
  ctx.fillStyle = 'rgba(255,51,102,0.6)';
  ctx.font = getFont('700', 12);
  ctx.textAlign = 'center';
  ctx.fillText('ЦИФРЫ КОТОРЫХ НЕТ В КОДЕ:', gameX + gameW / 2, exclY + 5);

  const exclDigitsY = exclY + 18;
  const dbW = 38, dbH = 38, dbGap = 10;
  const totalDbW = 5 * dbW + 4 * dbGap;
  const dbStartX = gameX + (gameW - totalDbW) / 2;

  for (let i = 0; i < 5; i++) {
    const dx = dbStartX + i * (dbW + dbGap);
    const digit = state.excludedDigits[i] || '?';

    ctx.fillStyle = 'rgba(255,51,102,0.06)';
    roundRect(ctx, dx, exclDigitsY, dbW, dbH, 5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,51,102,0.25)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, dx, exclDigitsY, dbW, dbH, 5);
    ctx.stroke();

    ctx.fillStyle = '#ff3366';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(digit, dx + dbW / 2, exclDigitsY + dbH / 2 + 7);

    // Cross-out
    ctx.strokeStyle = 'rgba(255,51,102,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(dx + 5, exclDigitsY + dbH - 5);
    ctx.lineTo(dx + dbW - 5, exclDigitsY + 5);
    ctx.stroke();
  }
  ctx.restore();

  // ========== ATTEMPTS & INFO ==========
  const infoY = exclDigitsY + dbH + 15;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = getFont('400', 13);
  ctx.fillText(`Попыток: ${state.attempts}`, gameX + 15, infoY + 5);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(0,212,255,0.4)';
  ctx.fillText(`Всего попыток: ${state.totalAttempts}`, gameX + gameW - 15, infoY + 5);
  ctx.restore();

  // ========== HACKED / WINNER OVERLAY ==========
  if (state.phase === 'hacked' || state.phase === 'winner_message') {
    // Animate digit reveal
    if (state.phase === 'hacked' && state.digitRevealIndex < 3) {
      if (Date.now() - state.digitRevealTimer > 600) {
        state.digitRevealIndex++;
        state.digitRevealTimer = Date.now();
      }
    }

    if (state.hackedBy) {
      const bannerY = infoY + 15;

      // Winner box with gold border
      ctx.save();
      const winGrad = ctx.createLinearGradient(gameX + 80, bannerY, gameX + gameW - 80, bannerY);
      winGrad.addColorStop(0, 'rgba(255,215,0,0.08)');
      winGrad.addColorStop(0.5, 'rgba(255,215,0,0.03)');
      winGrad.addColorStop(1, 'rgba(255,215,0,0.08)');
      ctx.fillStyle = winGrad;
      roundRect(ctx, gameX + 80, bannerY, gameW - 160, 90, 12);
      ctx.fill();

      // Animated gold border
      const goldPulse = 0.7 + 0.3 * Math.sin(now / 300);
      ctx.strokeStyle = `rgba(255,215,0,${goldPulse * 0.6})`;
      ctx.lineWidth = 2;
      ctx.shadowColor = '#ffd700';
      ctx.shadowBlur = 15 * goldPulse;
      roundRect(ctx, gameX + 80, bannerY, gameW - 160, 90, 12);
      ctx.stroke();

      // Avatar
      const avatarCX = gameX + 130;
      const avatarCY = bannerY + 45;
      if (state.hackedBy.avatarImg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarCX, avatarCY, 30, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(state.hackedBy.avatarImg, avatarCX - 30, avatarCY - 30, 60, 60);
        ctx.restore();
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(avatarCX, avatarCY, 31, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255,215,0,0.15)';
        ctx.beginPath();
        ctx.arc(avatarCX, avatarCY, 30, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffd700';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(avatarCX, avatarCY, 30, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#ffd700';
        ctx.font = getFont('700', 24);
        ctx.textAlign = 'center';
        ctx.fillText(state.hackedBy.displayName?.[0]?.toUpperCase() || '?', avatarCX, avatarCY + 9);
      }

      // Winner name
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffd700';
      ctx.font = getFont('800', 22);
      ctx.fillText(state.hackedBy.displayName || state.hackedBy.username, gameX + 180, bannerY + 38);

      // Points earned
      ctx.fillStyle = 'rgba(0,255,136,0.8)';
      ctx.font = getFont('700', 17);
      ctx.fillText(`+${state.winnerScore.toLocaleString('ru-RU')} баллов`, gameX + 180, bannerY + 62);

      // "ВЗЛОМАНО!" label
      ctx.textAlign = 'right';
      ctx.save();
      ctx.shadowColor = '#00ff88';
      ctx.shadowBlur = 15;
      ctx.fillStyle = '#00ff88';
      ctx.font = getFont('800', 18);
      ctx.fillText('ВЗЛОМАНО!', gameX + gameW - 100, bannerY + 45);
      ctx.restore();
      ctx.restore();

      // Winner message section
      const msgY = bannerY + 105;
      if (state.phase === 'winner_message') {
        ctx.save();
        ctx.textAlign = 'center';
        if (state.winnerMessage && state.winnerMessage !== '__ABSTAIN__') {
          ctx.fillStyle = 'rgba(0,212,255,0.5)';
          ctx.font = getFont('500', 12);
          ctx.fillText('Сообщение победителя:', gameX + gameW / 2, msgY);
          ctx.fillStyle = '#ffffff';
          ctx.font = getFont('700', 18);
          ctx.fillText(`"${state.winnerMessage}"`, gameX + gameW / 2, msgY + 25);
        } else if (state.winnerMessage === '__ABSTAIN__') {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.font = getFont('400', 14);
          ctx.fillText('Победитель решил воздержаться', gameX + gameW / 2, msgY + 15);
        } else {
          const dots = '.'.repeat(Math.floor((now / 500) % 4));
          ctx.fillStyle = 'rgba(0,212,255,0.5)';
          ctx.font = getFont('500', 14);
          ctx.fillText(`Ожидание сообщения от победителя${dots}`, gameX + gameW / 2, msgY + 15);
        }
        ctx.restore();
      }
    }
  }

  // ========== CORRECT FLASH ==========
  if (state.correctFlashAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = state.correctFlashAlpha * 0.12;
    ctx.fillStyle = '#00ff88';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    state.correctFlashAlpha = Math.max(0, state.correctFlashAlpha - 0.015);
  }

  // ========== PARTICLES ==========
  state.particles = state.particles.filter(p => p.life > 0);
  state.particles.forEach(p => {
    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 6;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.12;
    p.life -= 0.012;
  });

  // ========== RIGHT PANEL: LEADERBOARD ==========
  const panelX = 880, panelW = 370;

  // Leaderboard panel background
  ctx.save();
  const lbBg = ctx.createLinearGradient(panelX, 0, panelX + panelW, H);
  lbBg.addColorStop(0, 'rgba(5,5,20,0.9)');
  lbBg.addColorStop(0.5, 'rgba(8,8,25,0.85)');
  lbBg.addColorStop(1, 'rgba(5,5,20,0.9)');
  ctx.fillStyle = lbBg;
  roundRect(ctx, panelX, 5, panelW, H - 50, 12);
  ctx.fill();

  // Neon border
  ctx.strokeStyle = `rgba(0,212,255,${0.15 + 0.1 * Math.sin(now / 1500)})`;
  ctx.lineWidth = 1;
  roundRect(ctx, panelX, 5, panelW, H - 50, 12);
  ctx.stroke();

  // Left neon accent line
  const accentGrad = ctx.createLinearGradient(0, 10, 0, H - 60);
  accentGrad.addColorStop(0, 'rgba(0,212,255,0.6)');
  accentGrad.addColorStop(0.5, 'rgba(0,255,136,0.3)');
  accentGrad.addColorStop(1, 'rgba(0,212,255,0.6)');
  ctx.fillStyle = accentGrad;
  ctx.fillRect(panelX + 1, 10, 3, H - 65);
  ctx.restore();

  // Leaderboard title with crown
  ctx.save();
  ctx.shadowColor = '#ffd700';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#ffd700';
  ctx.font = getFont('800', 17);
  ctx.textAlign = 'center';
  ctx.fillText('\u2605 ТОП ВЗЛОМЩИКОВ \u2605', panelX + panelW / 2, 38);
  ctx.restore();

  // Separator line
  ctx.save();
  const sepGrad = ctx.createLinearGradient(panelX + 20, 0, panelX + panelW - 20, 0);
  sepGrad.addColorStop(0, 'rgba(0,212,255,0)');
  sepGrad.addColorStop(0.5, 'rgba(0,212,255,0.3)');
  sepGrad.addColorStop(1, 'rgba(0,212,255,0)');
  ctx.strokeStyle = sepGrad;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(panelX + 20, 50);
  ctx.lineTo(panelX + panelW - 20, 50);
  ctx.stroke();
  ctx.restore();

  // Leaderboard entries
  const lbTop5 = state.leaderboard.slice(0, 5);
  const lbEntryH = 58;
  const lbStartY = 60;

  if (lbTop5.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = getFont('400', 13);
    ctx.textAlign = 'center';
    ctx.fillText('Пока нет игроков', panelX + panelW / 2, lbStartY + 40);
  } else {
    const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49', '4', '5'];
    const medalColors = ['#ffd700', '#c0c0c0', '#cd7f32', 'rgba(0,212,255,0.6)', 'rgba(0,212,255,0.4)'];

    lbTop5.forEach((player, i) => {
      const ey = lbStartY + i * lbEntryH;
      const medalColor = medalColors[i];

      // Entry background
      ctx.save();
      const eGrad = ctx.createLinearGradient(panelX + 12, ey, panelX + panelW - 12, ey);
      eGrad.addColorStop(0, i === 0 ? 'rgba(255,215,0,0.05)' : 'rgba(255,255,255,0.015)');
      eGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = eGrad;
      roundRect(ctx, panelX + 12, ey, panelW - 24, lbEntryH - 6, 8);
      ctx.fill();

      // Left accent
      ctx.fillStyle = medalColor;
      roundRect(ctx, panelX + 12, ey, 3, lbEntryH - 6, 1.5);
      ctx.fill();

      // Rank / medal
      ctx.textAlign = 'left';
      if (i < 3) {
        ctx.font = '18px sans-serif';
        ctx.fillText(medals[i], panelX + 24, ey + 28);
      } else {
        ctx.fillStyle = medalColor;
        ctx.font = getFont('700', 16);
        ctx.fillText(`${i + 1}`, panelX + 28, ey + 28);
      }

      // Player name
      ctx.fillStyle = i === 0 ? '#ffd700' : '#ffffff';
      ctx.font = getFont('700', 15);
      ctx.fillText(player.display_name || player.username, panelX + 55, ey + 22);

      // Stats line
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = getFont('400', 10);
      ctx.fillText(`${player.correct_guesses} взломов`, panelX + 55, ey + 38);

      // Score
      ctx.fillStyle = '#00ff88';
      ctx.font = getFont('800', 17);
      ctx.textAlign = 'right';
      ctx.fillText(player.score.toLocaleString('ru-RU'), panelX + panelW - 25, ey + 24);

      // Score label
      ctx.fillStyle = 'rgba(0,255,136,0.35)';
      ctx.font = getFont('400', 9);
      ctx.fillText('баллов', panelX + panelW - 25, ey + 38);

      ctx.restore();
    });
  }

  // ========== CHAT AREA ==========
  const chatStartY = lbStartY + 5 * lbEntryH + 15;
  const chatX = panelX + 8;
  const chatW = panelW - 16;
  const chatH = H - chatStartY - 60;

  // Chat background
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  roundRect(ctx, chatX, chatStartY, chatW, chatH, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,212,255,0.08)';
  ctx.lineWidth = 1;
  roundRect(ctx, chatX, chatStartY, chatW, chatH, 8);
  ctx.stroke();

  // Chat title
  ctx.fillStyle = 'rgba(0,212,255,0.5)';
  ctx.font = getFont('700', 11);
  ctx.textAlign = 'center';
  ctx.fillText('\u25CF ЧАТ TWITCH', chatX + chatW / 2, chatStartY + 16);

  // Process chat queue
  while (state.chatQueue.length > 0) {
    const msg = state.chatQueue.shift();
    state.chatMessages.push(msg);
  }
  if (state.chatMessages.length > 50) state.chatMessages = state.chatMessages.slice(-30);

  // Render chat messages
  const msgLineH = 17;
  const maxMsgs = Math.floor((chatH - 30) / msgLineH);
  const visibleMsgs = state.chatMessages.slice(-maxMsgs);
  visibleMsgs.forEach((msg, i) => {
    const my = chatStartY + 30 + i * msgLineH;
    // Username with custom color
    const userColor = msg.color || '#00ff88';
    ctx.fillStyle = userColor;
    ctx.font = getFont('700', 10);
    ctx.textAlign = 'left';
    const nameStr = msg.displayName + ':';
    ctx.fillText(nameStr, chatX + 6, my);
    const nameW = ctx.measureText(nameStr).width;
    // Message
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = getFont('400', 10);
    const maxMsgW = chatW - nameW - 18;
    let msgText = msg.message;
    if (ctx.measureText(msgText).width > maxMsgW) {
      while (ctx.measureText(msgText + '...').width > maxMsgW && msgText.length > 0) msgText = msgText.slice(0, -1);
      msgText += '...';
    }
    ctx.fillText(msgText, chatX + 10 + nameW, my);
  });
  ctx.restore();

  // ========== BOTTOM BAR ==========
  ctx.save();
  const botGrad = ctx.createLinearGradient(0, H - 38, 0, H);
  botGrad.addColorStop(0, 'rgba(0,0,0,0.7)');
  botGrad.addColorStop(1, 'rgba(0,0,0,0.9)');
  ctx.fillStyle = botGrad;
  ctx.fillRect(0, H - 38, W, 38);

  // Bottom border
  const botLineGrad = ctx.createLinearGradient(0, 0, W, 0);
  botLineGrad.addColorStop(0, 'rgba(0,212,255,0)');
  botLineGrad.addColorStop(0.3, 'rgba(0,212,255,0.3)');
  botLineGrad.addColorStop(0.7, 'rgba(0,255,136,0.3)');
  botLineGrad.addColorStop(1, 'rgba(0,212,255,0)');
  ctx.strokeStyle = botLineGrad;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, H - 38);
  ctx.lineTo(W, H - 38);
  ctx.stroke();
  ctx.restore();

  // Stream title
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = getFont('400', 12);
  ctx.textAlign = 'center';
  ctx.fillText('Взломай Код | Интерактивная игра в прямом эфире | Пиши 4 цифры в чат', W / 2, H - 17);

  // Time
  const elapsed = Math.floor((Date.now() - state.roundStartTime) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  ctx.fillStyle = 'rgba(0,212,255,0.5)';
  ctx.font = '12px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`, W - 20, H - 17);

  // ========== GLITCH EFFECT ==========
  if (Math.random() < 0.015) state.glitchTimer = 2;
  if (state.glitchTimer > 0) {
    const gy = Math.random() * H;
    const gh = Math.random() * 15 + 3;
    const gx = Math.random() * 20 - 10;
    try {
      const imgData = ctx.getImageData(0, Math.max(0, Math.floor(gy)), W, Math.min(Math.floor(gh), H - Math.floor(gy)));
      ctx.putImageData(imgData, gx, gy);
    } catch(e) {}
    state.glitchTimer--;
  }

  // ========== PIPE TO FFMPEG ==========
  if (ffmpegProc && ffmpegProc.stdin && !ffmpegProc.stdin.destroyed && ffmpegProc.stdin.writable) {
    try {
      const buf = canvas.toBuffer('image/jpeg', { quality: 0.88 });
      ffmpegProc.stdin.write(buf);
    } catch(e) {}
  }

  frameCount++;
  if (frameCount % (FPS * 15) === 0) refreshLeaderboard();
  setTimeout(renderFrame, 1000 / FPS);
}

// ========== UTILITY ==========
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ========== STREAM ENGINE ==========
let ffmpegProc = null;
let streamActive = false;
let frameCount = 0;
const TWITCH_STREAM_KEY = process.env.TWITCH_STREAM_KEY || 'live_1510273597_jnmGuetTXLqxOlebzYkguxnOvGBODQ';

function spawnFFmpeg() {
  console.log('[STREAM] Spawning FFmpeg for Twitch...');
  if (ffmpegProc) { try { ffmpegProc.kill('SIGKILL'); } catch(e) {} ffmpegProc = null; }

  const args = [
    '-y',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-r', String(FPS), '-i', '-',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '5000k',
    '-pix_fmt', 'yuv420p', '-g', '20', '-keyint_min', '20', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-f', 'flv',
    `rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY}`,
  ];

  ffmpegProc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  ffmpegProc.stderr.on('data', d => {
    const m = d.toString();
    if (m.includes('error') || m.includes('Error') || m.includes('Invalid')) console.error('[FFmpeg ERR]', m.trim().substring(0, 200));
    if (m.includes('frame=') && frameCount % (FPS * 10) === 0) console.log('[FFmpeg]', m.trim().substring(0, 120));
  });
  ffmpegProc.stdin.on('error', e => console.error('[FFmpeg stdin]', e.message));
  ffmpegProc.on('close', code => {
    console.log('[FFmpeg] Exited with code:', code);
    streamActive = false;
    setTimeout(() => { if (!streamActive) { console.log('[STREAM] Auto-restarting...'); spawnFFmpeg(); } }, 3000);
  });
  streamActive = true;
  frameCount = 0;
  console.log(`[STREAM] FFmpeg -> Twitch (rtmp://live.twitch.tv/app/${TWITCH_STREAM_KEY.substring(0,5)}...)`);
}

// ========== EXPRESS ==========
const app = express();
app.use(express.json());
app.get('/api/state', (req, res) => res.json({
  success: true, phase: state.phase, currentPoints: state.currentPoints,
  password: state.phase === 'playing' ? null : state.password,
  hint: state.hint, excludedDigits: state.excludedDigits,
  attempts: state.attempts, roundNumber: state.roundNumber, roundId: state.roundId,
  hackedBy: state.hackedBy, winnerMessage: state.winnerMessage, winnerScore: state.winnerScore,
  leaderboard: state.leaderboard.slice(0, 10),
}));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ========== START ==========
async function start() {
  app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
  spawnFFmpeg();
  renderFrame();
  console.log('[STREAM] Canvas rendering started');

  try {
    await twitchClient.connect();
    console.log('[TWITCH] Chat client connected');
  } catch(e) {
    console.error('[TWITCH] Failed to connect:', e.message);
    setTimeout(async () => { try { await twitchClient.connect(); } catch(e2) { console.error('[TWITCH] Retry failed:', e2.message); } }, 5000);
  }

  refreshLeaderboard();
  await startNewRound();
  console.log('[GAME] First round started!');
}

start().catch(e => console.error('[START] Fatal error:', e));

process.on('SIGINT', () => {
  console.log('\n[SERVER] Shutting down...');
  if (ffmpegProc) ffmpegProc.kill();
  twitchClient.disconnect();
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (ffmpegProc) ffmpegProc.kill();
  twitchClient.disconnect();
  db.close();
  process.exit(0);
});
