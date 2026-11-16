/**
 * AzogStream — Salas: nome, cor e salas recentes
 *
 * Como não existe servidor, "salas recentes" é uma memória do navegador de cada
 * pessoa. Voltar para uma sala só funciona enquanto o host estiver com ela aberta.
 * Se você era o host e ela está fechada, entrar de novo a recria com o mesmo código.
 */

const ROOMS_KEY = 'azogstream_rooms';
const ROOMS_MAX = 8;
const ROOM_NAME_MAX = 24;
const ROOM_COLORS = ['#9333ea', '#ef4444', '#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#14b8a6', '#f97316'];
const ROOM_NAME_STOPWORDS = ['de', 'do', 'da', 'dos', 'das', 'e', 'a', 'o'];

let lobbyRoomColor = ROOM_COLORS[0];

// ---------------------------------------------------------
// Dados
// ---------------------------------------------------------
function cleanRoomName(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, ROOM_NAME_MAX);
}

function cleanRoomColor(raw) {
  return ROOM_COLORS.includes(raw) ? raw : ROOM_COLORS[0];
}

function roomInitials(name) {
  const words = String(name || '')
    .split(/[\s\-_]+/)
    .filter((w) => w && !ROOM_NAME_STOPWORDS.includes(w.toLowerCase()));
  let out = '';
  if (words.length >= 2) out = words[0][0] + words[1][0];
  else if (words.length === 1) out = words[0].slice(0, 2);
  out = out.replace(/[^A-Za-z0-9À-ÿ]/g, '').toUpperCase();
  return out || '#';
}

function loadRecentRooms() {
  try {
    const list = JSON.parse(localStorage.getItem(ROOMS_KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return list
      .filter((r) => r && typeof r.code === 'string' && r.code)
      .map((r) => ({
        code: sanitizeCode(r.code),
        name: cleanRoomName(r.name) || sanitizeCode(r.code),
        color: cleanRoomColor(r.color),
        role: r.role === 'host' ? 'host' : 'guest',
        last: Number(r.last) || 0
      }))
      .filter((r) => r.code)
      .sort((a, b) => b.last - a.last)
      .slice(0, ROOMS_MAX);
  } catch (err) {
    return [];
  }
}

function saveRecentRooms(list) {
  try {
    localStorage.setItem(ROOMS_KEY, JSON.stringify(list.slice(0, ROOMS_MAX)));
  } catch (err) {
    /* vale só nesta sessão */
  }
}

function upsertRecentRoom(entry) {
  const list = loadRecentRooms().filter((r) => r.code !== entry.code);
  list.unshift({ ...entry, last: Date.now() });
  saveRecentRooms(list);
}

function removeRecentRoom(code) {
  saveRecentRooms(loadRecentRooms().filter((r) => r.code !== code));
}

// ---------------------------------------------------------
// Identidade da sala atual (nome, cor, trilho)
// ---------------------------------------------------------
function applyRoomIdentity() {
  const name = state.roomName || state.roomCode;
  const color = state.roomColor || ROOM_COLORS[0];
  dom.roomTitleName.textContent = name;
  dom.railRoomIcon.textContent = roomInitials(name);
  dom.railRoomIcon.style.background = color;
  dom.railRoomIcon.title = `${name} · ${state.roomCode}`;
  document.title = `${name} — AzogStream`;

  upsertRecentRoom({
    code: state.roomCode,
    name,
    color,
    role: state.isHost ? 'host' : 'guest'
  });
  renderRailRecents();
}

// O host manda nome e cor da sala no HELLO; quem entra passa a mostrar igual
function applyRoomMeta(meta) {
  if (!meta || typeof meta !== 'object') return;
  const name = cleanRoomName(meta.name);
  state.roomName = name || state.roomName;
  state.roomColor = cleanRoomColor(meta.color);
  applyRoomIdentity();
}

// ---------------------------------------------------------
// Trilho: salas recentes
// ---------------------------------------------------------
function renderRailRecents() {
  const box = document.getElementById('rail-recents');
  if (!box) return;
  box.innerHTML = '';
  loadRecentRooms()
    .filter((r) => r.code !== state.roomCode)
    .slice(0, 6)
    .forEach((r) => {
      const slot = document.createElement('div');
      slot.className = 'rail-slot';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rail-item rail-recent';
      btn.style.background = r.color;
      btn.textContent = roomInitials(r.name);
      btn.title = `${r.name} · ${r.code}${r.role === 'host' ? ' (sua sala)' : ''}`;
      btn.addEventListener('click', () => switchRoom(r));
      slot.appendChild(btn);
      box.appendChild(slot);
    });
}

function switchRoom(entry) {
  const busy = state.localScreenStream || voice.connected;
  if (busy && !window.confirm(`Sair desta sala e ir para "${entry.name}"? Sua transmissão e sua voz serão encerradas.`)) {
    return;
  }
  const go = entry.role === 'host' ? 'host' : 'guest';
  leaveRoom(`${window.location.pathname}?room=${encodeURIComponent(entry.code)}&go=${go}`);
}

// ---------------------------------------------------------
// Lobby: cor, nome e salas recentes
// ---------------------------------------------------------
function getCreateRoomMeta() {
  const typed = cleanRoomName(document.getElementById('create-room-name').value);
  const nick = dom.usernameInput.value.trim() || 'Player';
  return { name: typed || `Sala de ${nick}`.slice(0, ROOM_NAME_MAX), color: lobbyRoomColor };
}

function renderRoomColorPicker() {
  const box = document.getElementById('create-room-colors');
  box.innerHTML = '';
  ROOM_COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'av-swatch room-swatch' + (c === lobbyRoomColor ? ' active' : '');
    b.style.background = c;
    b.title = 'Cor da sala';
    b.addEventListener('click', () => {
      lobbyRoomColor = c;
      renderRoomColorPicker();
      renderRoomPreview();
    });
    box.appendChild(b);
  });
}

function renderRoomPreview() {
  const meta = getCreateRoomMeta();
  const icon = document.getElementById('create-room-icon');
  icon.textContent = roomInitials(meta.name);
  icon.style.background = meta.color;
}

function renderLobbyRecents() {
  const box = document.getElementById('recent-rooms');
  const list = document.getElementById('recent-rooms-list');
  const rooms = loadRecentRooms();
  box.classList.toggle('hidden', rooms.length === 0);
  list.innerHTML = '';
  rooms.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'recent-room';
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'recent-room-main';
    main.innerHTML = `
      <span class="recent-room-icon" style="background:${r.color}">${escapeHtml(roomInitials(r.name))}</span>
      <span class="recent-room-text">
        <strong>${escapeHtml(r.name)}</strong>
        <small>${escapeHtml(r.code)} · ${r.role === 'host' ? 'Sua sala' : 'Convidado'}</small>
      </span>
      <span class="recent-room-go">Entrar</span>`;
    main.addEventListener('click', () => {
      startSession(r.code, r.role === 'host', { name: r.name, color: r.color, autoGo: true });
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'recent-room-del';
    del.title = 'Esquecer esta sala';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      removeRecentRoom(r.code);
      renderLobbyRecents();
    });
    row.appendChild(main);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function initRooms() {
  lobbyRoomColor = ROOM_COLORS[Math.floor(Math.random() * ROOM_COLORS.length)];
  renderRoomColorPicker();
  renderRoomPreview();
  renderLobbyRecents();

  document.getElementById('create-room-name').addEventListener('input', renderRoomPreview);
  dom.usernameInput.addEventListener('input', renderRoomPreview);
}
