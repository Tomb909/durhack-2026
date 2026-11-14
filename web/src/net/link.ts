// Connection to the Python server: receives the list of tracked cards.
import type { TrackedCard } from '../cards/store';

export interface Candidate {
  id: number;
  x: number;
  y: number;
  text: string;
  confidence: number;
}

export interface Snapshot {
  camera: { connected: boolean; fps: number; processMs: number };
  playArea: { found: boolean; locked: boolean; flip: boolean; shape?: { aspect: number; outline: number[][] } | null };
  cards: TrackedCard[];
  candidates: Candidate[];
  phoneUrls: string[];
}

export class Link {
  onSnapshot: (snapshot: Snapshot) => void = () => {};
  /** Called when the server cannot be reached at all. */
  onDown: () => void = () => {};
  private socket: WebSocket | null = null;
  up = false;

  connect(): void {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${scheme}://${location.host}/ws`);
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'snapshot') {
          this.up = true;
          this.onSnapshot(data as Snapshot);
        }
      } catch {
        /* ignore malformed messages */
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = null;
        this.up = false;
        this.onDown();
        this.retry();
      }
    };
    socket.onerror = () => socket.close();
  }

  private retry(): void {
    setTimeout(() => this.connect(), 2000);
  }

  send(type: 'flip' | 'relock'): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type }));
  }
}
