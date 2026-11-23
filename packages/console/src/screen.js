const KEYS = { Enter: 'return', Backspace: 'backspace', Tab: 'tab', Escape: 'escape', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const FILL = 'width:100%;height:100%;object-fit:contain;display:block;pointer-events:none';

export function streamUrl(base, leaseId, codec = preferredCodec()) {
  const u = new URL(base, location.href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
  u.searchParams.set('codec', codec);
  return leaseId ? new URL(`/v1/leases/${encodeURIComponent(leaseId)}/stream${u.search}`, u).href : u.href;
}

export function preferredCodec() {
  return window.isSecureContext && 'VideoDecoder' in window ? 'h264' : 'jpeg';
}

export function mountScreen(screen, url, { onStatus = () => {}, onError = () => {} } = {}) {
  const img = document.createElement('img');
  const canvas = document.createElement('canvas');
  img.style.cssText = FILL;
  canvas.style.cssText = FILL;
  img.alt = screen.getAttribute('aria-label') ?? 'Live device screen';
  canvas.hidden = true;
  screen.prepend(img, canvas);
  if (!screen.hasAttribute('tabindex')) screen.tabIndex = 0;

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  const video = h264View(canvas, () => send({ type: 'keyframe' }));
  let lastUrl = null;
  let frames = 0;
  let hasTouch = false;
  onStatus('Connecting…');
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.type === 'error') onError(m.message);
      if (m.type === 'hello') hasTouch = m.input.includes('touch');
      return;
    }
    const bytes = new Uint8Array(e.data);
    if (bytes[0] === 2) {
      canvas.hidden = false;
      img.hidden = true;
      video.push(bytes.subarray(1), performance.timeOrigin + performance.now());
    } else {
      canvas.hidden = true;
      img.hidden = false;
      const next = URL.createObjectURL(new Blob([bytes.subarray(1)], { type: 'image/jpeg' }));
      img.src = next;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = next;
    }
    if (++frames === 1) onStatus('Click to tap, drag to swipe, type to enter text');
  };
  ws.onclose = (e) => {
    video.close();
    onStatus(e.code === 4000 ? 'The lease ended.' : 'Disconnected. Reload to reconnect.');
  };

  let down = null;
  const norm = (e) => {
    const r = screen.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  // With live touches the device sees each move as the browser delivers it.
  screen.addEventListener('pointerdown', (e) => {
    screen.focus();
    screen.setPointerCapture(e.pointerId);
    down = { p: norm(e), t: performance.now() };
    if (hasTouch) send({ type: 'touch', phase: 'down', point: down.p });
  });
  screen.addEventListener('pointermove', (e) => {
    if (down && hasTouch) send({ type: 'touch', phase: 'move', point: norm(e) });
  });
  screen.addEventListener('pointerup', (e) => {
    if (!down) {
      return;
    }
    const p = norm(e);
    if (hasTouch) {
      send({ type: 'touch', phase: 'up', point: p });
      down = null;
      return;
    }
    if (Math.hypot(p[0] - down.p[0], p[1] - down.p[1]) < 0.02) send({ type: 'tap', point: p });
    else send({ type: 'swipe', from: down.p, to: p, durationMs: Math.max(100, Math.round(performance.now() - down.t)) });
    down = null;
  });
  screen.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) {
      return;
    }
    if (KEYS[e.key]) {
      e.preventDefault();
      send({ type: 'key', key: KEYS[e.key] });
    } else if (e.key.length === 1) {
      e.preventDefault();
      send({ type: 'type', text: e.key });
    }
  });

  return { send, close: () => ws.close() };
}

export function h264View(canvas, askKeyframe) {
  const ctx = canvas.getContext('2d', { desynchronized: true, alpha: false });
  const received = new Map();
  const stats = (window.devicepoolStats = []);
  let decoder = null;
  let config = '';
  const make = () =>
    new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        stats.push({ capture: frame.timestamp / 1000, received: received.get(frame.timestamp), decoded: performance.timeOrigin + performance.now() });
        received.delete(frame.timestamp);
        if (stats.length > 2000) stats.splice(0, 1000);
        frame.close();
      },
      error: () => {
        decoder = null;
        config = '';
        askKeyframe();
      },
    });
  return {
    push(record, receivedAt) {
      const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
      const key = (record[0] & 1) === 1;
      const timestamp = Math.round(view.getFloat64(1) * 1000);
      const data = record.subarray(13);
      if (key) {
        const codec = avcCodec(data);
        const next = `${codec}/${view.getUint16(9)}x${view.getUint16(11)}`;
        if (codec && next !== config) {
          if (decoder?.state !== 'closed') decoder?.close();
          decoder = make();
          decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
          config = next;
        }
      }
      if (!decoder || decoder.state !== 'configured') {
        return;
      }
      received.set(timestamp, receivedAt);
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
    },
    close() {
      if (decoder && decoder.state !== 'closed') decoder.close();
    },
  };
}

function avcCodec(data) {
  for (let i = 0; i + 7 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      const hex = (b) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(data[i + 4])}${hex(data[i + 5])}${hex(data[i + 6])}`;
    }
  }
  return null;
}

class DevicepoolScreen extends HTMLElement {
  connectedCallback() {
    this.style.display ||= 'block';
    this.style.position ||= 'relative';
    this.style.background ||= '#000';
    this.mounted = mountScreen(this, streamUrl(this.getAttribute('src') ?? '', this.getAttribute('lease'), this.getAttribute('codec') ?? preferredCodec()), {
      onStatus: (text) => this.dispatchEvent(new CustomEvent('status', { detail: text })),
      onError: (text) => this.dispatchEvent(new CustomEvent('error', { detail: text })),
    });
  }

  disconnectedCallback() {
    this.mounted?.close();
    this.replaceChildren();
  }

  send(message) {
    this.mounted?.send(message);
  }
}

if (!customElements.get('devicepool-screen')) customElements.define('devicepool-screen', DevicepoolScreen);
