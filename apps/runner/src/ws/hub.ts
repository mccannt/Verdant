import type { Server as HttpServer } from 'node:http';
import type { RunEventEnvelope, RunController } from '../lib/run-controller.js';
import { WebSocketServer } from 'ws';

type ClientState = {
  runId: string | null;
};

export const attachRunWebsocket = (server: HttpServer, controller: RunController): void => {
  const wss = new WebSocketServer({ server, path: '/ws' });

  const clientState = new WeakMap<import('ws').WebSocket, ClientState>();

  wss.on('connection', (socket) => {
    clientState.set(socket, { runId: null });

    socket.send(JSON.stringify({ type: 'ready' }));

    socket.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as { type?: string; runId?: string };
        if (parsed.type === 'subscribe' && parsed.runId) {
          clientState.set(socket, { runId: parsed.runId });
          socket.send(JSON.stringify({ type: 'subscribed', runId: parsed.runId }));
        }
      } catch {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid WS payload.' }));
      }
    });
  });

  const listener = (payload: RunEventEnvelope) => {
    for (const client of wss.clients) {
      if (client.readyState !== client.OPEN) {
        continue;
      }

      const state = clientState.get(client);
      if (state?.runId && state.runId !== payload.runId) {
        continue;
      }

      client.send(JSON.stringify({ type: 'run_event', ...payload }));
    }
  };

  controller.onEvent(listener);

  wss.on('close', () => {
    controller.offEvent(listener);
  });
};
