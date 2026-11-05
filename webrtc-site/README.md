# Sala WebRTC

Site de chamada de vídeo e chat **peer-to-peer** feito com a API WebRTC do navegador.
Vídeo, áudio, chat e compartilhamento de tela vão direto entre os dois navegadores;
o servidor só faz a *sinalização* (troca de offer/answer e candidatos ICE).

## Recursos

- Vídeo e áudio (`getUserMedia` + `RTCPeerConnection`)
- Chat de texto pelo `RTCDataChannel`
- Compartilhamento de tela (`getDisplayMedia` + `replaceTrack`)
- Silenciar microfone / desligar câmera
- Salas por nome, com link de convite (`?sala=nome`) — até 2 pessoas por sala
- Tema claro/escuro e layout responsivo

## Como rodar

Requer Node.js 18+ e nenhuma dependência externa.

```sh
cd webrtc-site
npm start            # ou: node server.mjs
# PORT=3000 npm start para outra porta
```

Abra <http://localhost:8080>, escolha um nome de sala e envie o link para a outra pessoa.

> Navegadores só liberam câmera/microfone em `localhost` ou em **HTTPS**.
> Para usar entre máquinas diferentes, publique atrás de um proxy HTTPS
> (por exemplo Caddy, nginx ou um túnel).

## Como funciona

```
Navegador A ──(SSE + POST /signal/:sala)──► server.mjs ◄──(SSE + POST)── Navegador B
     ▲                                                                       ▲
     └───────────────── mídia + chat P2P (WebRTC, via STUN) ─────────────────┘
```

1. Cada navegador abre um `EventSource` em `/signal/<sala>?peer=<id>`.
2. Quando o segundo participante entra, quem já estava cria o `RTCDataChannel`
   e envia a *offer*; o outro responde com a *answer*.
3. Candidatos ICE são trocados pelo mesmo canal até a conexão direta abrir.

Usa servidores STUN públicos do Google. Em redes muito restritivas (NAT simétrico)
pode ser necessário adicionar um servidor TURN em `ICE_SERVERS` (`public/app.js`).

## Arquivos

| Arquivo | Função |
| --- | --- |
| `server.mjs` | Servidor HTTP estático + sinalização (Node nativo) |
| `public/index.html` | Estrutura da página |
| `public/style.css` | Estilos |
| `public/app.js` | Lógica WebRTC do cliente |
