// Hangar console. Plain JavaScript, no build step.

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const who = document.getElementById('who');
const banner = document.getElementById('banner');

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body instanceof Blob ? { 'content-type': 'application/zip' } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? { message: `HTTP ${res.status}` };
    throw new Error(e.hint ? `${e.message} ${e.hint}` : e.message);
  }
  return data;
}

let me = null;
let cleanup = () => {};

function go(path) {
  history.pushState({}, '', path);
  render();
}
window.addEventListener('popstate', render);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a) {
    e.preventDefault();
    go(a.getAttribute('href'));
  }
});

async function render() {
  cleanup();
  cleanup = () => {};
  const path = location.pathname;
  const invite = path.match(/^\/invite\/(.+)$/);
  me = await api('GET', '/v1/me').catch(() => null);
  if (location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    banner.hidden = false;
    banner.textContent = 'This connection is not encrypted. Anyone on this network can read your session. Set up TLS before using Hangar beyond a trusted LAN.';
  }
  if (invite) return inviteView(invite[1]);
  if (!me) return loginView();
  who.replaceChildren(`${me.name} · `, h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await api('POST', '/v1/logout'); go('/'); } }, 'Sign out'));
  const links = [['/', 'Devices'], ['/runs', 'Runs'], ['/recordings', 'Recordings'], ['/connect', 'Connect']];
  if (me.role === 'operator') {
    links.splice(1, 0, ['/fleet', 'Fleet']);
    links.push(['/people', 'People']);
  }
  nav.replaceChildren(...links.map(([href, label]) => h('a', { href, 'data-link': true, class: path === href ? 'on' : '' }, label)));
  const lease = path.match(/^\/leases\/([^/]+)$/);
  if (lease) return leaseView(lease[1]);
  const recording = path.match(/^\/recordings\/([^/]+)$/);
  if (recording) return recordingView(recording[1]);
  if (path === '/recordings') return recordingsView();
  const run = path.match(/^\/runs\/([^/]+)$/);
  if (run) return runView(run[1]);
  if (path === '/runs') return runsView();
  if (path === '/connect') return connectView();
  if (path === '/cli-login') return cliLoginView();
  if (path === '/people') return peopleView();
  if (path === '/fleet') return fleetView();
  return devicesView();
}

async function loginView() {
  nav.replaceChildren();
  who.replaceChildren();
  const params = new URLSearchParams(location.search);
  const offer = await api('GET', '/v1/sign-in').catch(() => ({ sso: false, passwords: true }));
  const used = params.get('error') === 'link-used';
  const sso = params.get('error') === 'sso' ? `Single sign-on failed: ${params.get('message') ?? 'no reason given'}.` : '';
  const err = h('p', { class: 'error' }, used ? 'That sign-in link was already used or has expired. Sign in with your name and password, or run `hangar up` again for a new admin link.' : sso);
  const next = location.pathname === '/cli-login' ? location.pathname + location.search : '/';
  const ssoButton = offer.sso ? h('p', {}, h('a', { class: 'button primary', href: `/v1/oidc/start?next=${encodeURIComponent(next)}` }, 'Sign in with your company account')) : '';
  if (!offer.passwords) {
    app.replaceChildren(h('div', { class: 'card narrow' }, h('h1', {}, 'Sign in'), ssoButton, err));
    return;
  }
  const form = h(
    'form',
    {
      class: 'card narrow',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/v1/login', { name: form.name.value, password: form.password.value });
          go(next);
        } catch (x) {
          err.textContent = x.message;
        }
      },
    },
    h('h1', {}, 'Sign in'),
    ssoButton,
    h('label', { for: 'name' }, 'Name'),
    h('input', { id: 'name', name: 'name', type: 'text', autocomplete: 'username', required: true }),
    h('label', { for: 'password' }, 'Password'),
    h('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
    h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Sign in')),
    h('p', { class: 'muted' }, 'New here? Ask someone on your team for an invite link.'),
    err,
  );
  app.replaceChildren(form);
}

function inviteView(code) {
  nav.replaceChildren();
  const err = h('p', { class: 'error' });
  const form = h(
    'form',
    {
      class: 'card narrow',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', `/v1/invites/${encodeURIComponent(code)}/accept`, { name: form.name.value, password: form.password.value });
          go('/');
        } catch (x) {
          err.textContent = x.message;
        }
      },
    },
    h('h1', {}, 'Join Hangar'),
    h('p', { class: 'muted' }, 'Pick a name and a password. You use them to sign in next time.'),
    h('label', { for: 'name' }, 'Name'),
    h('input', { id: 'name', name: 'name', type: 'text', autocomplete: 'username', required: true }),
    h('label', { for: 'password' }, 'Password (8 characters or more)'),
    h('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'new-password', minlength: 8, required: true }),
    h('p', {}, h('button', { class: 'primary', type: 'submit' }, 'Join')),
    err,
  );
  app.replaceChildren(form);
}

async function devicesView() {
  const err = h('p', { class: 'error' });
  const [devices, leases] = await Promise.all([api('GET', '/v1/devices'), api('GET', '/v1/leases')]);
  const mine = leases.filter((l) => l.state !== 'ended');
  const models = [...new Map(devices.map((d) => [`${d.platform}|${d.model}|${d.os}`, d])).values()];
  let waiting = false;
  const use = async (d, button) => {
    waiting = true;
    button.disabled = true;
    button.textContent = 'Getting a device…';
    try {
      const lease = await api('POST', '/v1/leases?wait=120', { class: { platform: d.platform, model: d.model, os: d.os }, via: 'Console' });
      go(`/leases/${lease.id}`);
    } catch (x) {
      err.textContent = x.message;
      button.disabled = false;
      button.textContent = 'Use one';
      waiting = false;
    }
  };
  app.replaceChildren(
    h('h1', {}, 'Devices'),
    mine.length
      ? h('div', { class: 'card' }, h('h2', { style: 'margin-top:0' }, 'Your devices'), ...mine.map((l) =>
          h('div', { class: 'row', style: 'justify-content:space-between;padding:6px 0' },
            h('span', {}, `${l.device ? system(l.device) : 'Waiting for a device'} `, h('span', { class: `state ${l.state}` }, l.state)),
            h('a', { href: `/leases/${l.id}`, 'data-link': true }, 'Open')),
        ))
      : '',
    h('h2', {}, 'Available'),
    models.length
      ? h('div', { class: 'card' },
          h('table', {},
            h('tr', {}, h('th', {}, 'Device'), h('th', {}, 'Free'), h('th', {}, 'Mac'), h('th', {})),
            ...models.map((d) => {
              const same = devices.filter((x) => x.platform === d.platform && x.model === d.model && x.os === d.os);
              const free = same.filter((x) => x.state === 'ready').length;
              const b = h('button', { class: 'primary', onclick: () => use(d, b) }, 'Use one');
              return h('tr', {}, h('td', {}, system(d)), h('td', {}, `${free} of ${same.length}`), h('td', { class: 'muted' }, d.host), h('td', { style: 'text-align:right' }, b));
            }),
          ))
      : h('p', { class: 'card muted' }, 'No Mac is connected yet. Run `npx hangar up` on a Mac with Xcode.'),
    err,
  );
  const t = setInterval(() => !waiting && render(), 10_000);
  cleanup = () => clearInterval(t);
}

// Decodes the agent's H.264 frame records (u8 flags, f64 capture ms, u16 width, u16 height,
// Annex B) with WebCodecs and draws each frame as soon as it is decoded. Timings per frame go to
// window.hangarStats for bench/stream.
function h264View(canvas, askKeyframe) {
  const ctx = canvas.getContext('2d');
  const received = new Map();
  const stats = (window.hangarStats = []);
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
        const capture = frame.timestamp / 1000;
        stats.push({ capture, received: received.get(frame.timestamp), decoded: performance.timeOrigin + performance.now() });
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
      if (!decoder || decoder.state !== 'configured') return;
      received.set(timestamp, receivedAt);
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
    },
    close() {
      if (decoder && decoder.state !== 'closed') decoder.close();
    },
  };
}

// The codec string (avc1.PPCCLL) from the first SPS in an Annex B keyframe.
function avcCodec(data) {
  for (let i = 0; i + 7 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7) {
      const hex = (b) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(data[i + 4])}${hex(data[i + 5])}${hex(data[i + 6])}`;
    }
  }
  return null;
}

async function leaseView(id) {
  let lease = await api('GET', `/v1/leases/${id}`).catch((x) => ({ error: x.message }));
  if (lease.error) {
    app.replaceChildren(h('p', { class: 'error' }, lease.error), h('a', { href: '/', 'data-link': true }, 'Back to devices'));
    return;
  }
  if (lease.state === 'queued' || lease.state === 'preparing') {
    app.replaceChildren(h('h1', {}, 'Waiting for a device'), h('p', { class: 'muted' }, lease.queuePosition ? `You are number ${lease.queuePosition} in the queue.` : 'Starting the device…'));
    lease = await api('GET', `/v1/leases/${id}?wait=120`);
  }
  if (lease.state !== 'active') {
    app.replaceChildren(h('h1', {}, 'This lease has ended'), h('p', { class: 'muted' }, `Reason: ${lease.reason}. The device was wiped.`), h('a', { href: '/', 'data-link': true }, 'Get another device'));
    return;
  }

  const img = h('img', { alt: `Live screen of ${lease.device.model}` });
  const canvas = h('canvas', { role: 'img', 'aria-label': `Live screen of ${lease.device.model}`, hidden: true });
  const status = h('div', { class: 'hint' }, 'Connecting…');
  const screen = h('div', { class: 'screen', tabindex: '0', title: 'Click to tap, drag to swipe, type to enter text' }, img, canvas, status);
  const out = h('p', { class: 'muted' });
  const tree = h('div', { class: 'tree' });

  // H.264 needs WebCodecs, which browsers only offer on HTTPS and localhost. Elsewhere: JPEG.
  const codec = window.isSecureContext && 'VideoDecoder' in window ? 'h264' : 'jpeg';
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/leases/${id}/stream?codec=${codec}`);
  ws.binaryType = 'arraybuffer';
  const video = h264View(canvas, () => send({ type: 'keyframe' }));
  let lastUrl = null;
  let frames = 0;
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.type === 'error') out.textContent = m.message;
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
      const url = URL.createObjectURL(new Blob([bytes.subarray(1)], { type: 'image/jpeg' }));
      img.src = url;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = url;
    }
    if (++frames === 1) status.textContent = 'Click to tap, drag to swipe, type to enter text';
  };
  ws.onclose = (e) => {
    video.close();
    status.textContent = e.code === 4000 ? 'The lease ended.' : 'Disconnected. Reload to reconnect.';
  };
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));

  // Pointer: a short press is a tap, a drag is a swipe. Coordinates are 0 to 1.
  let down = null;
  const norm = (e) => {
    const r = screen.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  screen.addEventListener('pointerdown', (e) => {
    screen.focus();
    screen.setPointerCapture(e.pointerId);
    down = { p: norm(e), t: performance.now() };
  });
  screen.addEventListener('pointerup', (e) => {
    if (!down) return;
    const p = norm(e);
    const moved = Math.hypot(p[0] - down.p[0], p[1] - down.p[1]);
    if (moved < 0.02) send({ type: 'tap', point: p });
    else send({ type: 'swipe', from: down.p, to: p, durationMs: Math.max(100, Math.round(performance.now() - down.t)) });
    down = null;
  });
  let typed = '';
  let typeTimer = null;
  const flush = () => {
    if (typed) send({ type: 'type', text: typed });
    typed = '';
  };
  screen.addEventListener('keydown', (e) => {
    const keys = { Enter: 'return', Backspace: 'backspace', Tab: 'tab', Escape: 'escape', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (e.metaKey || e.ctrlKey) return;
    if (keys[e.key]) {
      e.preventDefault();
      flush();
      send({ type: 'key', key: keys[e.key] });
    } else if (e.key.length === 1) {
      e.preventDefault();
      typed += e.key;
      clearTimeout(typeTimer);
      typeTimer = setTimeout(flush, 150);
    }
  });

  // Keep the lease alive while this page is open and visible.
  const renew = setInterval(() => {
    if (document.visibilityState === 'visible') api('POST', `/v1/leases/${id}/renew`).catch(() => {});
  }, 60_000);
  cleanup = () => {
    clearInterval(renew);
    ws.close();
  };

  const run = async (label, fn) => {
    out.textContent = `${label}…`;
    try {
      const r = await fn();
      out.textContent = typeof r === 'string' ? r : `${label}: done.`;
    } catch (x) {
      out.textContent = x.message;
    }
  };
  const isAndroid = lease.device.platform === 'android-emulator';
  const file = h('input', { type: 'file', accept: isAndroid ? '.apk' : '.zip,.tar,.tgz,.gz' });
  const urlInput = h('input', { type: 'url', placeholder: 'https://example.com or myapp://path' });

  app.replaceChildren(
    h('div', { class: 'lease' },
      h('div', {},
        screen,
        h('div', { class: 'row', style: 'margin-top:10px;justify-content:center' },
          h('button', { onclick: () => send({ type: 'button', button: 'home' }) }, 'Home'),
          h('button', { onclick: () => send({ type: 'button', button: 'lock' }) }, 'Lock'),
          h('button', { title: 'React Native dev menu (command-D)', onclick: () => send({ type: 'key', key: 'd', modifiers: ['command'] }) }, 'Dev menu'),
          h('button', { title: 'Reload the React Native bundle (command-R)', onclick: () => send({ type: 'key', key: 'r', modifiers: ['command'] }) }, 'Reload'),
          h('a', { class: 'button', href: `/v1/leases/${id}/screenshot`, download: 'screenshot.png' }, 'Screenshot'),
        ),
      ),
      h('div', { class: 'side' },
        h('div', { class: 'card' },
          h('h1', { style: 'margin-bottom:4px' }, system(lease.device)),
          h('p', { class: 'muted', style: 'margin-top:0' }, 'Yours until you release it or leave it idle for 5 minutes. It is wiped when released.'),
          h('div', { class: 'row' },
            recordButton(id, out),
            h('button', { onclick: () => navigator.clipboard.writeText(location.href).then(() => (out.textContent = 'Link copied.')) }, 'Copy link'),
            h('button', { class: 'danger', onclick: async () => { await api('DELETE', `/v1/leases/${id}`); go('/'); } }, 'Release'),
          ),
          out,
        ),
        h('div', { class: 'card' },
          h('h2', { style: 'margin-top:0' }, 'Install an app'),
          h('p', { class: 'muted' }, `${isAndroid ? 'An .apk' : 'A zipped simulator build (.app folder)'}. Uploading needs permission from an operator.`),
          h('div', { class: 'row' }, file, h('button', { onclick: () => file.files[0] && run('Installing', async () => {
            const r = await api('POST', `/v1/leases/${id}/apps?name=${encodeURIComponent(file.files[0].name)}`, file.files[0]);
            await api('POST', `/v1/leases/${id}/apps/${encodeURIComponent(r.bundleId)}/launch`);
            return `Installed and opened ${r.name}.`;
          }) }, 'Install')),
        ),
        h('div', { class: 'card' },
          h('h2', { style: 'margin-top:0' }, 'Open a URL'),
          h('div', { class: 'row' }, urlInput, h('button', { onclick: () => run('Opening', () => api('POST', `/v1/leases/${id}/open-url`, { url: urlInput.value })) }, 'Open')),
        ),
        h('div', { class: 'card' },
          h('div', { class: 'row', style: 'justify-content:space-between' },
            h('h2', { style: 'margin:0' }, 'Elements on screen'),
            h('button', { onclick: async () => {
              const ui = await api('GET', `/v1/leases/${id}/ui`);
              tree.replaceChildren(...ui.nodes.filter((n) => n.label || n.identifier).map((n) =>
                h('div', {}, h('strong', {}, n.role), ' ', n.label ?? '', n.identifier ? h('span', { class: 'muted' }, ` #${n.identifier}`) : '')));
            } }, 'Refresh'),
          ),
          tree,
        ),
      ),
    ),
  );
  screen.focus();
}

// Every device at once, for operators: what each holder is doing, with a live picture.
async function fleetView() {
  const grid = h('div', { class: 'fleet' });
  const count = h('p', { class: 'muted' });
  app.replaceChildren(h('h1', {}, 'Fleet'), count, grid);
  const tiles = new Map();
  let stopped = false;
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
  };
  const watch = async (id, img) => {
    while (!stopped && tiles.has(id)) {
      if (!document.hidden) {
        const res = await fetch(`/v1/leases/${id}/screenshot?format=jpeg&maxSize=360`).catch(() => null);
        if (res?.ok) {
          const url = URL.createObjectURL(await res.blob());
          img.onload = () => URL.revokeObjectURL(url);
          img.src = url;
        }
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  };
  const refresh = async () => {
    const [leases, devices] = await Promise.all([api('GET', '/v1/leases?all=1'), api('GET', '/v1/devices')]);
    const active = leases.filter((l) => l.state === 'active' && l.device);
    const free = devices.filter((d) => d.state === 'ready');
    count.textContent = `${active.length} in use, ${free.length} ready`;
    for (const [id, t] of tiles) {
      if (!active.some((l) => l.id === id)) {
        t.el.remove();
        tiles.delete(id);
      }
    }
    for (const l of active) {
      let t = tiles.get(l.id);
      if (!t) {
        const img = h('img', { alt: '' });
        const holder = h('div', { class: 'holder' });
        const via = h('div', { class: 'via muted' });
        const doing = h('div', { class: 'doing' });
        const el = h('a', { class: 'tile', href: `/leases/${l.id}`, 'data-link': true }, h('div', { class: 'shot' }, img), h('div', { class: 'meta' }, holder, via, doing));
        t = { el, holder, via, doing };
        tiles.set(l.id, t);
        void watch(l.id, img);
      }
      t.holder.replaceChildren(h('b', {}, l.owner), h('span', { class: 'muted' }, ` · ${l.device.model}`));
      t.via.textContent = l.via ?? '';
      t.doing.textContent = l.activity ? `${l.activity} · ${ago(l.activityAt)}` : 'Just started';
    }
    grid.replaceChildren(
      ...active.map((l) => tiles.get(l.id).el),
      ...free.map((d) => h('div', { class: 'tile ready' }, h('div', { class: 'shot' }, h('span', {}, 'Ready')), h('div', { class: 'meta' }, h('div', { class: 'holder' }, h('b', {}, system(d))), h('div', { class: 'via muted' }, d.host)))),
    );
  };
  await refresh();
  const t = setInterval(() => void refresh().catch(() => {}), 2000);
  cleanup = () => {
    stopped = true;
    clearInterval(t);
  };
}

async function connectView() {
  const result = h('div');
  app.replaceChildren(
    h('h1', {}, 'Connect an agent or a script'),
    h('div', { class: 'card' },
      h('p', {}, 'Make a token for each agent, script or CI job, so you can revoke one without breaking the others.'),
      h('label', { for: 'label' }, 'What is it for?'),
      h('input', { id: 'label', type: 'text', placeholder: 'For example: support agent, nightly CI' }),
      me.role === 'operator'
        ? h('label', { class: 'check' }, h('input', { id: 'upload', type: 'checkbox' }), ' Can upload apps. CI needs this to install the build it tests.')
        : '',
      h('p', {}, h('button', { class: 'primary', onclick: async () => {
        const label = document.getElementById('label').value || 'token';
        const upload = document.getElementById('upload')?.checked;
        const t = await api('POST', '/v1/tokens', { label, ...(upload ? { scopes: ['install:upload'] } : {}) });
        result.replaceChildren(
          h('h2', {}, 'Your token'),
          h('p', { class: 'muted' }, 'Copy it now. It is shown only once.'),
          h('code', { class: 'code' }, t.token),
          h('h2', {}, 'Add Hangar to Claude Code'),
          h('code', { class: 'code' }, t.mcp),
          h('h2', {}, 'Use it from a script'),
          h('code', { class: 'code' }, `export HANGAR_URL=${location.origin}\nexport HANGAR_TOKEN=${t.token}\nnpx hangar lease`),
        );
      } }, 'Make a token')),
      result,
    ),
  );
}

// Approves `hangar login` on another computer. The token only goes to a loopback address, so a
// crafted link cannot send it anywhere else.
function cliLoginView() {
  const q = new URLSearchParams(location.search);
  let callback = null;
  try {
    const u = new URL(q.get('callback') ?? '');
    if (u.protocol === 'http:' && u.hostname === '127.0.0.1') callback = u;
  } catch {}
  if (!callback) {
    app.replaceChildren(h('p', { class: 'error' }, 'This sign-in link is not valid. Run `hangar login` again.'));
    return;
  }
  const computer = q.get('name') || 'a computer';
  app.replaceChildren(
    h('div', { class: 'card narrow' },
      h('h1', {}, 'Sign in the command line?'),
      h('p', {}, `The hangar command on ${computer} wants to act as ${me.name}. Only approve this if you just ran \`hangar login\`.`),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: async () => {
          const t = await api('POST', '/v1/tokens', { label: `CLI on ${computer}` });
          callback.searchParams.set('token', t.token);
          location.href = callback.toString();
        } }, 'Approve'),
        h('a', { href: '/', 'data-link': true }, 'Cancel'),
      ),
    ),
  );
}

async function peopleView() {
  const [people, teams] = await Promise.all([api('GET', '/v1/people'), api('GET', '/v1/teams')]);
  const result = h('div');
  const status = h('p', { class: 'muted' });
  const role = h('select', {}, h('option', { value: 'member' }, 'Member: uses devices'), h('option', { value: 'operator' }, 'Operator: runs Hangar, can upload apps'));
  const save = (fn) => fn().then(() => peopleView(), (x) => (status.textContent = x.message));
  // Only shown once there is a second team: one-team setups never see the concept.
  const teamPicker = (p) => h('select', { onchange: (e) => save(() => api('PUT', `/v1/people/${encodeURIComponent(p.name)}/team`, { team: e.target.value })) },
    ...teams.map((t) => h('option', { value: t.id, selected: t.id === p.team }, t.name)));
  const manyTeams = teams.length > 1;
  const newTeam = h('input', { placeholder: 'Team name' });
  app.replaceChildren(
    h('h1', {}, 'People'),
    h('div', { class: 'card' },
      h('table', {},
        h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role'), manyTeams ? h('th', {}, 'Team') : ''),
        ...people.map((p) => h('tr', {}, h('td', {}, p.name), h('td', { class: 'muted' }, p.role), manyTeams ? h('td', {}, teamPicker(p)) : '')),
      ),
    ),
    h('h2', {}, 'Teams'),
    h('div', { class: 'card' },
      h('p', { class: 'muted' }, 'A quota is the most devices a team holds at once. Requests over it wait in the queue. Leave it empty for no limit.'),
      h('table', {},
        h('tr', {}, h('th', {}, 'Team'), h('th', {}, 'People'), h('th', {}, 'In use'), h('th', {}, 'Quota')),
        ...teams.map((t) => h('tr', {},
          h('td', {}, t.name),
          h('td', {}, t.members),
          h('td', {}, t.activeLeases),
          h('td', {}, h('input', { type: 'number', min: 0, value: t.quota ?? '', style: 'width:6em', onchange: (e) => save(() => api('PATCH', `/v1/teams/${t.id}`, { quota: e.target.value === '' ? null : Number(e.target.value) })) })),
        )),
      ),
      h('div', { class: 'row' }, newTeam, h('button', { onclick: () => save(() => api('POST', '/v1/teams', { name: newTeam.value })) }, 'Add team')),
      status,
    ),
    h('h2', {}, 'Invite someone'),
    h('div', { class: 'card' },
      role,
      h('p', {}, h('button', { class: 'primary', onclick: async () => {
        const inv = await api('POST', '/v1/invites', { role: role.value });
        result.replaceChildren(h('p', {}, `Send this link. It works once, for ${inv.expiresInDays} days.`), h('code', { class: 'code' }, inv.url));
      } }, 'Make an invite link')),
      result,
    ),
  );
}

render();

// Recordings: start one while testing, stop it, and paste the link into the bug report.

function recordButton(leaseId, out) {
  let recording = false;
  const button = h('button', { onclick: async () => {
    button.disabled = true;
    try {
      if (!recording) {
        await api('POST', `/v1/leases/${leaseId}/recording`);
        out.textContent = 'Recording the screen, the app log and what you do.';
      } else {
        out.textContent = 'Saving the recording…';
        const rec = await api('POST', `/v1/leases/${leaseId}/recording/stop`);
        out.replaceChildren('Saved: ', h('a', { href: `/recordings/${rec.id}`, 'data-link': true }, 'open the recording'), '. Paste its link into the bug report.');
      }
      recording = !recording;
      button.textContent = recording ? 'Stop recording' : 'Record';
      button.classList.toggle('recording', recording);
    } catch (x) {
      out.textContent = x.message;
    } finally {
      button.disabled = false;
    }
  } }, 'Record');
  return button;
}

const seconds = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

async function recordingsView() {
  const list = await api('GET', '/v1/recordings?all=1');
  app.replaceChildren(
    h('h1', {}, 'Recordings'),
    list.length === 0
      ? h('p', { class: 'muted' }, 'No recordings yet. Press Record on a device, or lease with `hangar lease --record`. Recordings are kept for 14 days.')
      : h('table', {},
          h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'Device'), h('th', {}, 'Length'), h('th', {}, 'State')),
          ...list.map((r) => h('tr', {},
            h('td', {}, h('a', { href: `/recordings/${r.id}`, 'data-link': true }, r.startedAt ? new Date(r.startedAt).toLocaleString() : 'not started')),
            h('td', {}, r.owner),
            h('td', {}, r.device ?? ''),
            h('td', {}, r.durationMs === null ? '' : seconds(r.durationMs)),
            h('td', { class: `state ${r.state}` }, r.state),
          )),
        ),
  );
}

async function recordingView(id) {
  const rec = await api('GET', `/v1/recordings/${id}`).catch((x) => ({ error: x.message }));
  if (rec.error) {
    app.replaceChildren(h('p', { class: 'error' }, rec.error), h('a', { href: '/recordings', 'data-link': true }, 'All recordings'));
    return;
  }
  const title = h('h1', { style: 'margin-bottom:4px' }, `${rec.device ?? 'Device'}, recorded by ${rec.owner}`);
  const meta = h('p', { class: 'muted', style: 'margin-top:0' }, rec.startedAt ? `${new Date(rec.startedAt).toLocaleString()} · ${rec.durationMs === null ? '' : seconds(rec.durationMs)}` : '');
  if (rec.state !== 'ready') {
    const why = { waiting: 'Waiting for the device.', recording: 'Still recording.', saving: 'The Mac is saving the recording. Reload in a moment.', failed: `The recording failed: ${rec.error}` };
    app.replaceChildren(title, meta, h('p', {}, why[rec.state] ?? rec.state));
    return;
  }

  const video = h('video', { src: rec.files.video, controls: true, playsinline: true, preload: 'auto' });
  const seek = (ms) => {
    video.currentTime = ms / 1000;
    video.play().catch(() => {});
  };
  const timeline = await fetch(rec.files.timeline).then((r) => (r.ok ? r.json() : []), () => []);
  const logText = await fetch(rec.files.log).then((r) => (r.ok ? r.text() : ''), () => '');
  const log = logText.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const e = JSON.parse(line);
      return [{ at: Date.parse(e.timestamp.replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) - rec.startedAt, process: e.processImagePath?.split('/').pop() ?? '', level: e.messageType ?? '', message: e.eventMessage ?? '' }];
    } catch {
      return [];
    }
  });

  // Highlights the step that was last done at the video's current time.
  const steps = timeline.map((e) => h('button', { class: e.failed ? 'step error' : 'step', title: e.failed ?? '', onclick: () => seek(e.at) }, h('span', { class: 'muted' }, seconds(e.at)), ' ', e.what, e.failed ? ` (failed: ${e.failed})` : ''));
  video.addEventListener('timeupdate', () => {
    const now = video.currentTime * 1000;
    let current = -1;
    timeline.forEach((e, i) => { if (e.at <= now) current = i; });
    steps.forEach((el, i) => el.classList.toggle('on', i === current));
  });

  app.replaceChildren(
    h('div', { class: 'lease' },
      h('div', {}, h('div', { class: 'screen recording' }, video)),
      h('div', { class: 'side' },
        h('div', { class: 'card' },
          title,
          meta,
          h('div', { class: 'row' },
            h('button', { onclick: (e) => navigator.clipboard.writeText(location.href).then(() => (e.target.textContent = 'Link copied')) }, 'Copy link'),
            h('a', { class: 'button', href: rec.files.video, download: `hangar-${id}.mp4` }, 'Video'),
            h('a', { class: 'button', href: rec.files.screenshot, download: `hangar-${id}.png` }, 'Last screenshot'),
            h('a', { class: 'button', href: rec.files.log, download: `hangar-${id}.ndjson` }, 'App log'),
          ),
        ),
        h('div', { class: 'card' },
          h('h2', { style: 'margin-top:0' }, 'What happened'),
          steps.length ? h('div', { class: 'steps' }, steps) : h('p', { class: 'muted' }, 'No actions were taken during the recording.'),
        ),
        h('div', { class: 'card' },
          h('h2', { style: 'margin-top:0' }, 'App log'),
          log.length
            ? h('div', { class: 'log' }, log.slice(-500).map((e) => h('button', { class: `step ${e.level.toLowerCase()}`, onclick: () => seek(e.at) }, h('span', { class: 'muted' }, seconds(e.at)), ' ', h('strong', {}, e.process), ' ', e.message)))
            : h('p', { class: 'muted' }, 'The apps on the device logged nothing.'),
        ),
      ),
    ),
  );
}

const system = (d) => `${d.model}, ${d.platform === 'android-emulator' ? 'Android' : 'iOS'} ${d.os}`;

const counts = (r) => [r.counts.passed && `${r.counts.passed} passed`, r.counts.flaky && `${r.counts.flaky} flaky`, r.counts.failed && `${r.counts.failed} failed`, r.counts.pending && `${r.counts.pending} to go`].filter(Boolean).join(', ');

async function runsView() {
  const list = await api('GET', '/v1/runs');
  app.replaceChildren(
    h('h1', {}, 'Runs'),
    list.length === 0
      ? h('p', { class: 'muted' }, 'No runs yet. Start one with `hangar run maestro <flows-dir> --app <App.app>`, or from CI with the GitHub Action.')
      : h('table', {},
          h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'Build'), h('th', {}, 'Flows'), h('th', {}, 'Length'), h('th', {}, 'State')),
          ...list.map((r) => h('tr', {},
            h('td', {}, h('a', { href: `/runs/${r.id}`, 'data-link': true }, new Date(r.createdAt).toLocaleString())),
            h('td', {}, r.owner),
            h('td', {}, r.build),
            h('td', {}, counts(r)),
            h('td', {}, seconds(r.durationMs)),
            h('td', { class: `state ${r.state}` }, r.state),
          )),
        ),
  );
}

async function runView(id) {
  const first = await api('GET', `/v1/runs/${id}`).catch((x) => ({ error: x.message }));
  if (first.error) {
    app.replaceChildren(h('p', { class: 'error' }, first.error), h('a', { href: '/runs', 'data-link': true }, 'All runs'));
    return;
  }
  const show = (r) => {
    const cancel = r.state === 'running' && (r.owner === me.name || me.role === 'operator')
      ? h('button', { onclick: () => api('DELETE', `/v1/runs/${id}`).then(show) }, 'Cancel run')
      : '';
    app.replaceChildren(
      h('h1', { style: 'margin-bottom:4px' }, `${r.build}, started by ${r.owner}`),
      h('p', { class: 'muted', style: 'margin-top:0' }, `${new Date(r.createdAt).toLocaleString()} · ${r.shards} shard${r.shards === 1 ? '' : 's'} · ${seconds(r.durationMs)} · `, h('span', { class: `state ${r.state}` }, r.state)),
      r.error ? h('p', { class: 'error' }, r.error) : '',
      h('div', { class: 'row' }, h('a', { class: 'button', href: r.junit, download: `hangar-run-${id}.xml` }, 'JUnit report'), cancel),
      h('table', {},
        h('tr', {}, h('th', {}, 'Flow'), h('th', {}, 'Shard'), h('th', {}, 'Attempts'), h('th', {}, 'State'), h('th', {}, '')),
        ...r.flows.map((f) => h('tr', {},
          h('td', {}, f.flow, f.message ? h('div', { class: 'muted' }, f.message) : ''),
          h('td', {}, f.shard + 1),
          h('td', {}, f.attempts),
          h('td', { class: `state ${f.status}` }, f.status),
          h('td', {}, f.recording ? h('a', { href: new URL(f.recording).pathname, 'data-link': true }, 'Recording') : ''),
        )),
      ),
    );
  };
  show(first);
  if (first.state === 'running') {
    const events = new EventSource(`/v1/runs/${id}/events`);
    for (const state of ['running', 'passed', 'failed', 'cancelled']) {
      events.addEventListener(state, (e) => {
        show(JSON.parse(e.data));
        // The server ends the stream once the run is over; without this EventSource reconnects.
        if (state !== 'running') events.close();
      });
    }
    cleanup = () => events.close();
  }
}
