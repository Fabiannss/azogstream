/**
 * AzogStream — Voz
 * Dispositivos de entrada/saída, volumes, mudo e ensurdecer, detecção de voz,
 * apertar para falar, teste de microfone, filtros e indicador de quem está falando.
 *
 * Carregado depois de app.js: usa `state`, `dom`, `showToast`, `broadcastMyState`,
 * `callPeerWithVoice` e `renderMembersList` de lá.
 *
 * O microfone passa por um grafo de Web Audio (ganho + portão de voz) e o que vai
 * para os amigos é a saída desse grafo. Assim dá para trocar de microfone, de filtro
 * ou silenciar sem derrubar nem renegociar a chamada.
 */

const VOICE_SETTINGS_KEY = 'azogstream_voice_settings';

const VOICE_DEFAULTS = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  inputVolume: 100, // 0–200 %
  outputVolume: 100, // 0–100 %
  mode: 'vad', // 'vad' (detecção de voz) | 'ptt' (apertar para falar)
  sensitivity: -50, // limiar da detecção de voz, em dB
  pttKey: 'KeyV',
  pttKeyLabel: 'V',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  users: {} // apelido -> { vol: 0–100, muted: bool }
};

const METER_MIN_DB = -80;

function loadVoiceSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) || '{}');
    return { ...VOICE_DEFAULTS, ...saved, users: { ...(saved.users || {}) } };
  } catch (err) {
    return { ...VOICE_DEFAULTS, users: {} };
  }
}

function saveVoiceSettings() {
  try {
    localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(voice.settings));
  } catch (err) {
    /* armazenamento indisponível: as configurações valem só nesta sessão */
  }
}

const voice = {
  settings: loadVoiceSettings(),

  // Grafo de áudio
  ctx: null,
  destNode: null,
  gateNode: null,
  gateIsWorklet: false,
  testGain: null,
  rawStream: null,
  sourceNode: null,
  fallbackAnalyser: null,
  fallbackTimer: null,
  fallbackHoldUntil: 0,
  graphPromise: null,

  // Estado
  connected: false,
  muted: false,
  deafened: false,
  mutedBeforeDeafen: false,
  pttDown: false,
  capturingKey: false,
  testing: false,
  selfSpeaking: false,
  speakingPeers: new Map(), // peerId -> último instante com áudio
  openMemberMenu: null
};

const vdom = {};

// =========================================================
// GRAFO DE ÁUDIO (ganho de entrada + portão de voz)
// =========================================================

// Roda na thread de áudio: não sofre com o navegador em segundo plano enquanto você joga.
const GATE_WORKLET_SOURCE = `
class AzogVoiceGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { mode: 'vad', threshold: -50, muted: false, ptt: false, gain: 1 };
    this.hold = 0;
    this.g = 0;
    this.sinceReport = 0;
    this.peak = 0;
    this.port.onmessage = (e) => Object.assign(this.p, e.data);
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const ch0 = input && input[0];
    const n = ch0 ? ch0.length : 128;
    const gain = this.p.gain;

    let sum = 0;
    if (ch0) {
      for (let i = 0; i < n; i++) {
        const s = ch0[i] * gain;
        sum += s * s;
      }
    }
    const rms = Math.sqrt(sum / n);
    if (rms > this.peak) this.peak = rms;
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;

    let want;
    if (this.p.muted) {
      want = false;
      this.hold = 0;
    } else if (this.p.mode === 'ptt') {
      want = this.p.ptt;
    } else {
      if (db >= this.p.threshold) this.hold = sampleRate * 0.4;
      else this.hold -= n;
      want = this.hold > 0;
    }

    const target = want ? 1 : 0;
    let g = this.g;
    for (let c = 0; c < output.length; c++) {
      const src = input && (input[c] || ch0);
      const out = output[c];
      g = this.g;
      for (let i = 0; i < out.length; i++) {
        g += (target - g) * 0.02;
        out[i] = src ? src[i] * gain * g : 0;
      }
    }
    this.g = g < 0.0005 && target === 0 ? 0 : g;

    this.sinceReport += n;
    if (this.sinceReport >= 2048) {
      const peakDb = this.peak > 0 ? 20 * Math.log10(this.peak) : -100;
      this.port.postMessage({ db: peakDb, open: want });
      this.sinceReport = 0;
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor('azog-voice-gate', AzogVoiceGate);
`;

function ensureVoiceGraph() {
  if (voice.graphPromise) return voice.graphPromise;

  voice.graphPromise = (async () => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    voice.ctx = ctx;
    voice.destNode = ctx.createMediaStreamDestination();

    // Caminho do "ouvir a si mesmo" no teste de microfone (fora do portão, para sempre dar retorno)
    voice.testGain = ctx.createGain();
    voice.testGain.gain.value = 0;
    voice.testGain.connect(ctx.destination);

    try {
      if (!ctx.audioWorklet) throw new Error('AudioWorklet indisponível');
      const url = URL.createObjectURL(new Blob([GATE_WORKLET_SOURCE], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      voice.gateNode = new AudioWorkletNode(ctx, 'azog-voice-gate', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      voice.gateNode.port.onmessage = (e) => onGateReport(e.data.db, e.data.open);
      voice.gateIsWorklet = true;
    } catch (err) {
      // Navegador sem AudioWorklet: mesmo comportamento, medido por temporizador
      console.warn('[Voz] AudioWorklet indisponível, usando modo de compatibilidade.', err);
      voice.gateNode = ctx.createGain();
      voice.gateNode.gain.value = 0;
      voice.fallbackAnalyser = ctx.createAnalyser();
      voice.fallbackAnalyser.fftSize = 1024;
      voice.gateIsWorklet = false;
      voice.fallbackTimer = setInterval(fallbackGateTick, 50);
    }

    voice.gateNode.connect(voice.destNode);
    pushGateParams();
    applyOutputDevice();
  })();

  return voice.graphPromise;
}

function pushGateParams() {
  if (!voice.gateNode || !voice.gateIsWorklet) return;
  voice.gateNode.port.postMessage({
    mode: voice.settings.mode,
    threshold: voice.settings.sensitivity,
    muted: voice.muted,
    ptt: voice.pttDown,
    gain: voice.settings.inputVolume / 100
  });
}

function fallbackGateTick() {
  if (!voice.fallbackAnalyser || !voice.sourceNode) return;
  const buf = new Float32Array(voice.fallbackAnalyser.fftSize);
  voice.fallbackAnalyser.getFloatTimeDomainData(buf);
  const gain = voice.settings.inputVolume / 100;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = buf[i] * gain;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / buf.length);
  const db = rms > 0 ? 20 * Math.log10(rms) : -100;

  let want;
  if (voice.muted) {
    want = false;
  } else if (voice.settings.mode === 'ptt') {
    want = voice.pttDown;
  } else {
    if (db >= voice.settings.sensitivity) voice.fallbackHoldUntil = performance.now() + 400;
    want = performance.now() < voice.fallbackHoldUntil;
  }
  voice.gateNode.gain.setTargetAtTime(want ? gain : 0, voice.ctx.currentTime, 0.015);
  onGateReport(db, want);
}

function onGateReport(db, open) {
  const speaking = Boolean(open) && voice.connected && !voice.muted;
  if (speaking !== voice.selfSpeaking) {
    voice.selfSpeaking = speaking;
    refreshSpeakingClasses();
  }

  if (vdom.meterFill && isVoiceTabVisible()) {
    const pct = Math.max(0, Math.min(100, ((db - METER_MIN_DB) / -METER_MIN_DB) * 100));
    vdom.meterFill.style.width = `${pct}%`;
    vdom.meterFill.classList.toggle('open', Boolean(open));
  }
}

async function openCapture() {
  await ensureVoiceGraph();
  if (voice.ctx.state === 'suspended') {
    await voice.ctx.resume().catch(() => {});
  }

  const s = voice.settings;
  const buildConstraints = (withDevice) => {
    const audio = {
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl
    };
    if (withDevice && s.inputDeviceId && s.inputDeviceId !== 'default') {
      audio.deviceId = { exact: s.inputDeviceId };
    }
    return { audio, video: false };
  };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(buildConstraints(true));
  } catch (err) {
    // O microfone salvo pode ter sido desconectado: volta para o padrão do sistema
    if (s.inputDeviceId !== 'default' && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      s.inputDeviceId = 'default';
      saveVoiceSettings();
      stream = await navigator.mediaDevices.getUserMedia(buildConstraints(false));
      showToast('Microfone salvo não encontrado. Usando o padrão do sistema.');
    } else {
      throw err;
    }
  }

  releaseRawStream();
  voice.rawStream = stream;
  voice.sourceNode = voice.ctx.createMediaStreamSource(stream);
  voice.sourceNode.connect(voice.gateNode);
  voice.sourceNode.connect(voice.testGain);
  if (voice.fallbackAnalyser) voice.sourceNode.connect(voice.fallbackAnalyser);

  populateVoiceDevices();
}

function releaseRawStream() {
  if (voice.sourceNode) {
    try {
      voice.sourceNode.disconnect();
    } catch (err) {
      /* já desconectado */
    }
    voice.sourceNode = null;
  }
  if (voice.rawStream) {
    voice.rawStream.getTracks().forEach((t) => t.stop());
    voice.rawStream = null;
  }
}

// Fecha o microfone quando ninguém mais precisa dele (fora da voz e sem teste em andamento)
function closeCaptureIfIdle() {
  if (voice.connected || voice.testing) return;
  releaseRawStream();
  if (vdom.meterFill) vdom.meterFill.style.width = '0%';
}

// =========================================================
// ENTRAR / SAIR DA VOZ, MUDO E ENSURDECER
// =========================================================
async function joinVoice() {
  if (voice.connected) return;
  try {
    if (!voice.rawStream) await openCapture();
  } catch (err) {
    console.error('Erro ao acessar microfone:', err);
    showToast('Permissão de microfone negada ou dispositivo indisponível.');
    return;
  }

  voice.connected = true;
  voice.muted = voice.deafened; // quem entra ensurdecido entra mudo, como esperado
  pushGateParams();

  state.localVoiceStream = voice.destNode.stream;
  state.dataConns.forEach((_, peerId) => {
    callPeerWithVoice(peerId);
  });

  renderVoiceUI();
  broadcastMyState();
  showToast(
    voice.settings.mode === 'ptt'
      ? `Voz conectada! Segure ${voice.settings.pttKeyLabel} para falar.`
      : 'Voz conectada!'
  );
}

function leaveVoice() {
  if (!voice.connected) return;
  state.outgoingVoiceCalls.forEach((c) => c.close());
  state.outgoingVoiceCalls.clear();
  state.localVoiceStream = null;

  voice.connected = false;
  voice.muted = false;
  voice.selfSpeaking = false;
  pushGateParams();
  closeCaptureIfIdle();

  renderVoiceUI();
  broadcastMyState();
  showToast('Você saiu da voz.');
}

// Botão de microfone: fora da voz, entra; dentro, alterna o mudo sem derrubar a chamada
function toggleMute() {
  if (!voice.connected) {
    joinVoice();
    return;
  }
  voice.muted = !voice.muted;
  if (!voice.muted && voice.deafened) {
    // Reativar o microfone também volta a ouvir
    voice.deafened = false;
    applyVoiceOutput();
  }
  pushGateParams();
  renderVoiceUI();
  broadcastMyState();
}

function toggleDeafen() {
  voice.deafened = !voice.deafened;
  if (voice.deafened) {
    voice.mutedBeforeDeafen = voice.muted;
    voice.muted = true;
  } else {
    voice.muted = voice.connected ? voice.mutedBeforeDeafen : false;
  }
  pushGateParams();
  applyVoiceOutput();
  renderVoiceUI();
  broadcastMyState();
  showToast(voice.deafened ? 'Ensurdecido: você não ouve as vozes da sala.' : 'Você voltou a ouvir a sala.');
}

// =========================================================
// SAÍDA: VOLUME GERAL, VOLUME POR PESSOA E DISPOSITIVO
// =========================================================
function userVoicePrefs(username) {
  return voice.settings.users[username] || { vol: 100, muted: false };
}

function applyVoiceOutputTo(peerId, audioEl) {
  const member = state.members.get(peerId);
  const prefs = userVoicePrefs(member ? member.username : '');
  const volume = (voice.settings.outputVolume / 100) * (prefs.vol / 100);
  audioEl.volume = Math.max(0, Math.min(1, volume));
  audioEl.muted = voice.deafened || prefs.muted;
  setSink(audioEl);
}

function applyVoiceOutput() {
  dom.voiceAudioContainer.querySelectorAll('audio').forEach((el) => {
    applyVoiceOutputTo(el.id.replace('voice-audio-', ''), el);
  });
}

function setSink(el) {
  const id = voice.settings.outputDeviceId;
  if (typeof el.setSinkId !== 'function') return;
  el.setSinkId(id === 'default' ? '' : id).catch(() => {});
}

// O dispositivo de saída vale para as vozes e também para o som das lives
function applyOutputDevice() {
  document.querySelectorAll('#voice-audio-container audio, video.stream-video').forEach(setSink);
  if (voice.ctx && typeof voice.ctx.setSinkId === 'function') {
    const id = voice.settings.outputDeviceId;
    voice.ctx.setSinkId(id === 'default' ? '' : id).catch(() => {});
  }
}

// =========================================================
// QUEM ESTÁ FALANDO
// =========================================================
function voiceIsSpeaking(peerId) {
  if (peerId === state.myPeerId) return voice.selfSpeaking;
  const last = voice.speakingPeers.get(peerId);
  return last !== undefined && performance.now() - last < 350;
}

function pollRemoteSpeaking() {
  const now = performance.now();
  state.incomingVoiceCalls.forEach((call, peerId) => {
    let level = 0;
    try {
      const pc = call.peerConnection;
      const receiver = pc && pc.getReceivers().find((r) => r.track && r.track.kind === 'audio');
      const sources = receiver && receiver.getSynchronizationSources ? receiver.getSynchronizationSources() : [];
      if (sources[0] && typeof sources[0].audioLevel === 'number') level = sources[0].audioLevel;
    } catch (err) {
      level = 0;
    }
    if (level > 0.012) voice.speakingPeers.set(peerId, now);
  });
  refreshSpeakingClasses();
}

function refreshSpeakingClasses() {
  dom.membersList.querySelectorAll('.member-item[data-peer-id]').forEach((li) => {
    li.classList.toggle('speaking', voiceIsSpeaking(li.dataset.peerId));
  });
  if (dom.userPanelAvatar) {
    dom.userPanelAvatar.classList.toggle('speaking', voice.selfSpeaking);
  }
}

// =========================================================
// MEMBROS: ÍCONES DE ESTADO E VOLUME POR PESSOA
// =========================================================
const VOICE_ICONS = {
  mic: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><title>Microfone ligado</title><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line></svg>',
  micMuted:
    '<svg class="state-off" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><title>Microfone mudo</title><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line></svg>',
  deafened:
    '<svg class="state-off" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><title>Ensurdecido</title><path d="M3 18v-6a9 9 0 0 1 14.5-7.1"></path><path d="M21 12v6"></path><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3z"></path><path d="M3 19a2 2 0 0 0 2 2h1v-6H3z"></path><line x1="2" y1="2" x2="22" y2="22"></line></svg>'
};

function voiceMemberBadges(m) {
  if (!m.hasMic && !m.deafened) return '';
  let html = '';
  if (m.hasMic) html += m.micMuted ? VOICE_ICONS.micMuted : VOICE_ICONS.mic;
  if (m.deafened) html += VOICE_ICONS.deafened;
  return html;
}

// Chamado por renderMembersList logo após inserir o <li> de um amigo
function voiceDecorateMember(li, m) {
  const prefs = userVoicePrefs(m.username);
  li.classList.add('clickable');
  li.title = 'Clique para ajustar o volume desta pessoa';
  if (prefs.muted) li.classList.add('locally-muted');

  li.addEventListener('click', () => {
    voice.openMemberMenu = voice.openMemberMenu === m.peerId ? null : m.peerId;
    renderMembersList();
  });

  if (voice.openMemberMenu !== m.peerId) return;

  const row = document.createElement('li');
  row.className = 'member-volume';
  row.innerHTML = `
    <button type="button" class="panel-btn member-mute-btn${prefs.muted ? ' on' : ''}" title="${prefs.muted ? 'Voltar a ouvir' : 'Silenciar só para mim'}">${prefs.muted ? '🔇' : '🔊'}</button>
    <input type="range" class="voice-range" min="0" max="100" step="1" value="${prefs.vol}" aria-label="Volume desta pessoa" />
    <span class="member-volume-value">${prefs.vol}%</span>
  `;
  dom.membersList.appendChild(row);

  const range = row.querySelector('input');
  const label = row.querySelector('.member-volume-value');
  range.addEventListener('input', () => {
    const next = { ...userVoicePrefs(m.username), vol: Number(range.value) };
    voice.settings.users[m.username] = next;
    label.textContent = `${next.vol}%`;
    saveVoiceSettings();
    applyVoiceOutput();
  });
  row.querySelector('.member-mute-btn').addEventListener('click', () => {
    const current = userVoicePrefs(m.username);
    voice.settings.users[m.username] = { ...current, muted: !current.muted };
    saveVoiceSettings();
    applyVoiceOutput();
    renderMembersList();
  });
}

// =========================================================
// INTERFACE: BOTÕES, FAIXA DE VOZ E CONFIGURAÇÕES
// =========================================================
function renderVoiceUI() {
  const live = voice.connected && !voice.muted;

  // Painel do usuário
  dom.btnUserMic.classList.toggle('mic-active', live);
  dom.btnUserMic.title = !voice.connected
    ? 'Entrar no canal de voz'
    : voice.muted
      ? 'Reativar microfone'
      : 'Silenciar microfone';
  vdom.btnDeafen.classList.toggle('on', voice.deafened);
  vdom.btnDeafen.title = voice.deafened ? 'Voltar a ouvir' : 'Ensurdecer (parar de ouvir as vozes)';

  // Faixa "voz conectada"
  vdom.voiceStrip.classList.toggle('hidden', !voice.connected);
  vdom.voiceStripDetail.textContent =
    voice.settings.mode === 'ptt' ? `Segure ${voice.settings.pttKeyLabel} para falar` : 'Arena de Lives';

  refreshSpeakingClasses();
}

function isVoiceTabVisible() {
  return !dom.settingsModal.classList.contains('hidden') && !vdom.panelVoice.classList.contains('hidden');
}

function setSettingsTab(tab) {
  const isVoice = tab === 'voice';
  vdom.tabVoice.classList.toggle('active', isVoice);
  vdom.tabStream.classList.toggle('active', !isVoice);
  vdom.panelVoice.classList.toggle('hidden', !isVoice);
  vdom.panelStream.classList.toggle('hidden', isVoice);
  if (!isVoice) stopMicTest();
}

function openVoiceSettings() {
  dom.settingsModal.classList.remove('hidden');
  setSettingsTab('voice');
  syncVoiceForm();
  populateVoiceDevices();
}

function closeVoiceSettings() {
  dom.settingsModal.classList.add('hidden');
  stopMicTest();
  voice.capturingKey = false;
  syncVoiceForm();
}

async function startMicTest() {
  try {
    if (!voice.rawStream) await openCapture();
  } catch (err) {
    console.error('Erro ao acessar microfone:', err);
    showToast('Permissão de microfone negada ou dispositivo indisponível.');
    return;
  }
  voice.testing = true;
  voice.testGain.gain.setTargetAtTime(voice.settings.inputVolume / 100, voice.ctx.currentTime, 0.02);
  syncVoiceForm();
}

function stopMicTest() {
  if (!voice.testing) return;
  voice.testing = false;
  if (voice.testGain) voice.testGain.gain.setTargetAtTime(0, voice.ctx.currentTime, 0.02);
  closeCaptureIfIdle();
  syncVoiceForm();
}

async function populateVoiceDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices || !vdom.selectInput) return;
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    return;
  }

  const fill = (select, kind, fallbackName, current) => {
    const list = devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default');
    select.innerHTML = '';
    const def = document.createElement('option');
    def.value = 'default';
    def.textContent = 'Padrão do sistema';
    select.appendChild(def);
    list.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `${fallbackName} ${i + 1}`;
      select.appendChild(opt);
    });
    select.value = list.some((d) => d.deviceId === current) ? current : 'default';
  };

  fill(vdom.selectInput, 'audioinput', 'Microfone', voice.settings.inputDeviceId);
  fill(vdom.selectOutput, 'audiooutput', 'Saída de áudio', voice.settings.outputDeviceId);

  const canPickOutput = typeof HTMLMediaElement.prototype.setSinkId === 'function';
  vdom.selectOutput.disabled = !canPickOutput;
  vdom.outputHint.textContent = canPickOutput
    ? 'Vale para as vozes e para o som das lives.'
    : 'Este navegador não permite escolher a saída; ele usa a padrão do sistema.';

  const hasLabels = devices.some((d) => d.kind === 'audioinput' && d.label);
  vdom.inputHint.textContent = hasLabels
    ? ''
    : 'Clique em "Testar microfone" e permita o acesso para ver os nomes dos dispositivos.';
}

function syncVoiceForm() {
  const s = voice.settings;
  vdom.rangeInput.value = s.inputVolume;
  vdom.rangeInputValue.textContent = `${s.inputVolume}%`;
  vdom.rangeOutput.value = s.outputVolume;
  vdom.rangeOutputValue.textContent = `${s.outputVolume}%`;

  vdom.modeVad.classList.toggle('active', s.mode === 'vad');
  vdom.modePtt.classList.toggle('active', s.mode === 'ptt');
  vdom.vadBox.classList.toggle('hidden', s.mode !== 'vad');
  vdom.pttBox.classList.toggle('hidden', s.mode !== 'ptt');
  vdom.rangeSensitivity.value = s.sensitivity;
  vdom.sensitivityValue.textContent = `${s.sensitivity} dB`;
  vdom.btnPttKey.textContent = voice.capturingKey ? 'Pressione uma tecla…' : s.pttKeyLabel;
  vdom.btnPttKey.classList.toggle('capturing', voice.capturingKey);

  vdom.checkEcho.checked = s.echoCancellation;
  vdom.checkNoise.checked = s.noiseSuppression;
  vdom.checkAgc.checked = s.autoGainControl;

  vdom.btnTest.textContent = voice.testing ? 'Parar teste' : 'Testar microfone';
  vdom.btnTest.classList.toggle('testing', voice.testing);
  vdom.testHint.textContent = voice.testing
    ? 'Fale algo: você está se ouvindo. Use fone para não dar microfonia.'
    : voice.connected
      ? 'O medidor mostra o que seu microfone está captando agora.'
      : 'Teste para se ouvir e ver o nível do microfone.';
}

// Trocar microfone ou filtro reabre a captura; a chamada com os amigos continua a mesma
async function reopenCaptureIfActive() {
  if (!voice.rawStream) return;
  try {
    await openCapture();
  } catch (err) {
    console.error('Erro ao reabrir microfone:', err);
    showToast('Não foi possível usar esse microfone.');
  }
}

function keyLabelFromEvent(e) {
  if (e.code.startsWith('Key')) return e.code.slice(3);
  if (e.code.startsWith('Digit')) return e.code.slice(5);
  const names = {
    Space: 'Espaço',
    ControlLeft: 'Ctrl esq.',
    ControlRight: 'Ctrl dir.',
    ShiftLeft: 'Shift esq.',
    ShiftRight: 'Shift dir.',
    AltLeft: 'Alt esq.',
    AltRight: 'Alt dir.',
    CapsLock: 'Caps Lock',
    Backquote: "'"
  };
  return names[e.code] || e.code;
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function setPtt(down) {
  if (voice.pttDown === down) return;
  voice.pttDown = down;
  pushGateParams();
}

function bindVoiceKeys() {
  window.addEventListener('keydown', (e) => {
    if (voice.capturingKey) {
      e.preventDefault();
      if (e.code !== 'Escape') {
        voice.settings.pttKey = e.code;
        voice.settings.pttKeyLabel = keyLabelFromEvent(e);
        saveVoiceSettings();
      }
      voice.capturingKey = false;
      syncVoiceForm();
      renderVoiceUI();
      return;
    }
    if (voice.settings.mode !== 'ptt' || !voice.connected) return;
    if (e.code !== voice.settings.pttKey || e.repeat || isTypingTarget(e.target)) return;
    setPtt(true);
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === voice.settings.pttKey) setPtt(false);
  });

  // Perdeu o foco com a tecla apertada: solta, para não ficar transmitindo sem querer
  window.addEventListener('blur', () => setPtt(false));
}

function initVoice() {
  const byId = (id) => document.getElementById(id);
  Object.assign(vdom, {
    btnDeafen: byId('btn-user-deafen'),
    voiceStrip: byId('voice-strip'),
    voiceStripDetail: byId('voice-strip-detail'),
    btnLeaveVoice: byId('btn-leave-voice'),
    tabVoice: byId('tab-settings-voice'),
    tabStream: byId('tab-settings-stream'),
    panelVoice: byId('panel-settings-voice'),
    panelStream: byId('panel-settings-stream'),
    selectInput: byId('select-voice-input'),
    selectOutput: byId('select-voice-output'),
    inputHint: byId('voice-input-hint'),
    outputHint: byId('voice-output-hint'),
    rangeInput: byId('range-voice-input'),
    rangeInputValue: byId('range-voice-input-value'),
    rangeOutput: byId('range-voice-output'),
    rangeOutputValue: byId('range-voice-output-value'),
    btnTest: byId('btn-voice-test'),
    testHint: byId('voice-test-hint'),
    meterFill: byId('voice-meter-fill'),
    modeVad: byId('btn-voice-mode-vad'),
    modePtt: byId('btn-voice-mode-ptt'),
    vadBox: byId('voice-vad-box'),
    pttBox: byId('voice-ptt-box'),
    rangeSensitivity: byId('range-voice-sensitivity'),
    sensitivityValue: byId('voice-sensitivity-value'),
    btnPttKey: byId('btn-voice-ptt-key'),
    checkEcho: byId('check-voice-echo'),
    checkNoise: byId('check-voice-noise'),
    checkAgc: byId('check-voice-agc')
  });

  vdom.btnDeafen.addEventListener('click', toggleDeafen);
  vdom.btnLeaveVoice.addEventListener('click', leaveVoice);
  vdom.tabVoice.addEventListener('click', () => setSettingsTab('voice'));
  vdom.tabStream.addEventListener('click', () => setSettingsTab('stream'));

  vdom.selectInput.addEventListener('change', () => {
    voice.settings.inputDeviceId = vdom.selectInput.value;
    saveVoiceSettings();
    reopenCaptureIfActive();
  });
  vdom.selectOutput.addEventListener('change', () => {
    voice.settings.outputDeviceId = vdom.selectOutput.value;
    saveVoiceSettings();
    applyOutputDevice();
  });

  vdom.rangeInput.addEventListener('input', () => {
    voice.settings.inputVolume = Number(vdom.rangeInput.value);
    vdom.rangeInputValue.textContent = `${voice.settings.inputVolume}%`;
    saveVoiceSettings();
    pushGateParams();
    if (voice.testing) {
      voice.testGain.gain.setTargetAtTime(voice.settings.inputVolume / 100, voice.ctx.currentTime, 0.02);
    }
  });
  vdom.rangeOutput.addEventListener('input', () => {
    voice.settings.outputVolume = Number(vdom.rangeOutput.value);
    vdom.rangeOutputValue.textContent = `${voice.settings.outputVolume}%`;
    saveVoiceSettings();
    applyVoiceOutput();
  });

  vdom.btnTest.addEventListener('click', () => {
    if (voice.testing) stopMicTest();
    else startMicTest();
  });

  const setMode = (mode) => {
    voice.settings.mode = mode;
    saveVoiceSettings();
    setPtt(false);
    pushGateParams();
    syncVoiceForm();
    renderVoiceUI();
  };
  vdom.modeVad.addEventListener('click', () => setMode('vad'));
  vdom.modePtt.addEventListener('click', () => setMode('ptt'));

  vdom.rangeSensitivity.addEventListener('input', () => {
    voice.settings.sensitivity = Number(vdom.rangeSensitivity.value);
    vdom.sensitivityValue.textContent = `${voice.settings.sensitivity} dB`;
    saveVoiceSettings();
    pushGateParams();
  });

  vdom.btnPttKey.addEventListener('click', () => {
    voice.capturingKey = !voice.capturingKey;
    syncVoiceForm();
  });

  const bindFilter = (checkbox, key) => {
    checkbox.addEventListener('change', () => {
      voice.settings[key] = checkbox.checked;
      saveVoiceSettings();
      reopenCaptureIfActive();
    });
  };
  bindFilter(vdom.checkEcho, 'echoCancellation');
  bindFilter(vdom.checkNoise, 'noiseSuppression');
  bindFilter(vdom.checkAgc, 'autoGainControl');

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', populateVoiceDevices);
  }

  // Lives novas também saem pelo dispositivo de saída escolhido
  new MutationObserver(applyOutputDevice).observe(dom.streamsGrid, { childList: true, subtree: true });

  bindVoiceKeys();
  setInterval(pollRemoteSpeaking, 120);

  syncVoiceForm();
  renderVoiceUI();
}
