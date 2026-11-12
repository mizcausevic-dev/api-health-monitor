// Server-Sent Events hub for /v1/events. Keeps a ring buffer so a client that
// reconnects with Last-Event-ID receives what it missed instead of a gap.
export class EventHub {
  constructor({ buffer = 500, maxClients = 100 } = {}) {
    this.seq = 0;
    this.ring = [];
    this.size = buffer;
    this.clients = new Set();
    this.maxClients = maxClients;
  }

  publish({ type, data }) {
    const evt = { id: ++this.seq, type, data, at: new Date().toISOString() };
    this.ring.push(evt);
    if (this.ring.length > this.size) this.ring.shift();
    for (const c of this.clients) c(evt);
    return evt;
  }

  since(lastId) {
    return this.ring.filter((e) => e.id > lastId);
  }

  subscribe(fn) {
    this.clients.add(fn);
    return () => this.clients.delete(fn);
  }
}

export const formatSse = (e) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;
