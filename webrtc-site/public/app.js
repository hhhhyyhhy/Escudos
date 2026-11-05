// Cliente WebRTC: captura mídia local, conecta-se à sala via sinalização
// (EventSource + fetch) e estabelece vídeo/áudio + chat (RTCDataChannel) P2P.

const ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

const $ = (selector) => document.querySelector(selector);
const ui = {
  status: $("#status"),
  lobby: $("#lobby"),
  call: $("#call"),
  joinForm: $("#join-form"),
  room: $("#room"),
  randomRoom: $("#random-room"),
  withVideo: $("#with-video"),
  withAudio: $("#with-audio"),
  localVideo: $("#local-video"),
  remoteVideo: $("#remote-video"),
  remoteLabel: $("#remote-label"),
  toggleAudio: $("#toggle-audio"),
  toggleVideo: $("#toggle-video"),
  shareScreen: $("#share-screen"),
  copyLink: $("#copy-link"),
  leave: $("#leave"),
  messages: $("#messages"),
  chatForm: $("#chat-form"),
  chatInput: $("#chat-input"),
  chatSend: $("#chat-send"),
};

const state = {
  room: "",
  peerId: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
  events: null,
  localStream: null,
  screenTrack: null,
  pc: null,
  channel: null,
  pendingCandidates: [],
};

function setStatus(text, kind) {
  ui.status.textContent = text;
  ui.status.dataset.state = kind;
}

function addMessage(text, kind = "theirs") {
  const item = document.createElement("li");
  item.className = kind;
  item.textContent = text;
  ui.messages.append(item);
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function setChatEnabled(enabled) {
  ui.chatInput.disabled = !enabled;
  ui.chatSend.disabled = !enabled;
}

async function signal(data) {
  const url = `/signal/${encodeURIComponent(state.room)}?peer=${state.peerId}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`Falha na sinalização (${response.status})`);
}

// ---------- Mídia local ----------

async function startLocalMedia() {
  const video = ui.withVideo.checked;
  const audio = ui.withAudio.checked;
  if (!video && !audio) return new MediaStream();
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch (error) {
    addMessage(`Não foi possível acessar câmera/microfone: ${error.message}`, "system");
    return new MediaStream();
  }
}

function currentVideoSender() {
  return state.pc?.getSenders().find((sender) => sender.track?.kind === "video");
}

async function stopScreenShare() {
  if (!state.screenTrack) return;
  state.screenTrack.stop();
  state.screenTrack = null;
  const cameraTrack = state.localStream.getVideoTracks()[0] ?? null;
  await currentVideoSender()?.replaceTrack(cameraTrack);
  ui.localVideo.srcObject = state.localStream;
  ui.localVideo.parentElement.classList.remove("screen");
  ui.shareScreen.textContent = "Compartilhar tela";
}

async function startScreenShare() {
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch {
    return;
  }
  const [track] = display.getVideoTracks();
  const sender = currentVideoSender();
  if (sender) {
    await sender.replaceTrack(track);
  } else if (state.pc) {
    // Sem câmera: adiciona a faixa de tela e renegocia.
    state.pc.addTrack(track, display);
    await makeOffer();
  }
  state.screenTrack = track;
  track.addEventListener("ended", () => void stopScreenShare());
  ui.localVideo.srcObject = display;
  ui.localVideo.parentElement.classList.add("screen");
  ui.shareScreen.textContent = "Parar compartilhamento";
}

// ---------- Conexão P2P ----------

function setupChannel(channel) {
  state.channel = channel;
  channel.addEventListener("open", () => {
    setChatEnabled(true);
    addMessage("Chat conectado.", "system");
  });
  channel.addEventListener("close", () => setChatEnabled(false));
  channel.addEventListener("message", (event) => addMessage(String(event.data)));
}

function createPeerConnection() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.pc = pc;
  state.pendingCandidates = [];

  for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
  if (state.screenTrack) pc.addTrack(state.screenTrack);

  pc.addEventListener("icecandidate", ({ candidate }) => {
    if (candidate) void signal({ type: "candidate", candidate }).catch(console.error);
  });

  pc.addEventListener("track", ({ streams, track }) => {
    ui.remoteVideo.srcObject = streams[0] ?? new MediaStream([track]);
    ui.remoteLabel.textContent = "Participante";
  });

  pc.addEventListener("datachannel", ({ channel }) => setupChannel(channel));

  pc.addEventListener("connectionstatechange", () => {
    const labels = {
      connecting: ["Conectando…", "waiting"],
      connected: ["Conectado (P2P)", "connected"],
      disconnected: ["Conexão instável…", "waiting"],
      failed: ["Falha na conexão", "error"],
    };
    const label = labels[pc.connectionState];
    if (label) setStatus(...label);
  });

  return pc;
}

async function makeOffer() {
  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);
  await signal({ type: "description", description: state.pc.localDescription });
}

async function flushCandidates() {
  for (const candidate of state.pendingCandidates.splice(0)) {
    await state.pc.addIceCandidate(candidate);
  }
}

async function handleSignal({ data }) {
  if (data.type === "description") {
    const { description } = data;
    if (!state.pc) createPeerConnection();
    await state.pc.setRemoteDescription(description);
    await flushCandidates();
    if (description.type === "offer") {
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      await signal({ type: "description", description: state.pc.localDescription });
    }
  } else if (data.type === "candidate") {
    if (state.pc?.remoteDescription) await state.pc.addIceCandidate(data.candidate);
    else state.pendingCandidates.push(data.candidate);
  }
}

function closePeer() {
  state.channel?.close();
  state.pc?.close();
  state.channel = null;
  state.pc = null;
  state.pendingCandidates = [];
  ui.remoteVideo.srcObject = null;
  ui.remoteLabel.textContent = "Aguardando outra pessoa…";
  setChatEnabled(false);
}

// ---------- Sala ----------

function onEvent(type, handler) {
  state.events.addEventListener(type, (event) => {
    Promise.resolve(handler(JSON.parse(event.data))).catch((error) => {
      console.error(error);
      addMessage(`Erro: ${error.message}`, "system");
    });
  });
}

async function joinRoom(room) {
  state.room = room;
  state.localStream = await startLocalMedia();
  ui.localVideo.srcObject = state.localStream;
  ui.toggleAudio.disabled = state.localStream.getAudioTracks().length === 0;
  ui.toggleVideo.disabled = state.localStream.getVideoTracks().length === 0;

  history.replaceState(null, "", `?sala=${encodeURIComponent(room)}`);
  ui.lobby.hidden = true;
  ui.call.hidden = false;
  setStatus("Aguardando participante…", "waiting");
  addMessage(`Você entrou na sala “${room}”. Compartilhe o link para convidar alguém.`, "system");

  state.events = new EventSource(`/signal/${encodeURIComponent(room)}?peer=${state.peerId}`);

  onEvent("welcome", ({ peers }) => {
    if (peers.length > 0) addMessage("Outra pessoa já está na sala. Conectando…", "system");
  });

  // Quem já estava na sala inicia a negociação e cria o canal de chat.
  onEvent("peer-joined", async () => {
    addMessage("Um participante entrou.", "system");
    closePeer();
    createPeerConnection();
    setupChannel(state.pc.createDataChannel("chat"));
    await makeOffer();
  });

  onEvent("signal", handleSignal);

  onEvent("peer-left", () => {
    addMessage("O participante saiu.", "system");
    closePeer();
    setStatus("Aguardando participante…", "waiting");
  });

  state.events.addEventListener("error", () => {
    if (state.events?.readyState === EventSource.CLOSED) {
      setStatus("Sala indisponível (cheia ou servidor fora do ar)", "error");
    }
  });
}

function leaveRoom() {
  state.events?.close();
  state.events = null;
  closePeer();
  state.screenTrack?.stop();
  state.screenTrack = null;
  for (const track of state.localStream?.getTracks() ?? []) track.stop();
  state.localStream = null;
  ui.localVideo.srcObject = null;
  ui.messages.replaceChildren();
  ui.call.hidden = true;
  ui.lobby.hidden = false;
  history.replaceState(null, "", location.pathname);
  setStatus("Desconectado", "idle");
}

// ---------- Interface ----------

function toggleTracks(kind, button, onLabel, offLabel) {
  const tracks = kind === "audio" ? state.localStream.getAudioTracks() : state.localStream.getVideoTracks();
  const enabled = !tracks.every((track) => track.enabled);
  for (const track of tracks) track.enabled = enabled;
  button.setAttribute("aria-pressed", String(!enabled));
  button.textContent = enabled ? onLabel : offLabel;
}

ui.randomRoom.addEventListener("click", () => {
  ui.room.value = `sala-${crypto.randomUUID().slice(0, 8)}`;
});

ui.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (ui.room.reportValidity()) void joinRoom(ui.room.value.trim());
});

ui.toggleAudio.addEventListener("click", () =>
  toggleTracks("audio", ui.toggleAudio, "Silenciar", "Ativar microfone"),
);
ui.toggleVideo.addEventListener("click", () =>
  toggleTracks("video", ui.toggleVideo, "Desligar câmera", "Ligar câmera"),
);
ui.shareScreen.addEventListener("click", () => {
  void (state.screenTrack ? stopScreenShare() : startScreenShare());
});
ui.copyLink.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    addMessage("Link copiado!", "system");
  } catch {
    addMessage(`Link da sala: ${location.href}`, "system");
  }
});
ui.leave.addEventListener("click", leaveRoom);

ui.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = ui.chatInput.value.trim();
  if (!text || state.channel?.readyState !== "open") return;
  state.channel.send(text);
  addMessage(text, "mine");
  ui.chatInput.value = "";
});

window.addEventListener("beforeunload", () => state.events?.close());

const presetRoom = new URLSearchParams(location.search).get("sala");
if (presetRoom) ui.room.value = presetRoom;
if (!navigator.mediaDevices?.getDisplayMedia) ui.shareScreen.hidden = true;
