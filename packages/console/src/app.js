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
  const links = [['/', 'Devices'], ['/connect', 'Connect']];
  if (me.role === 'operator') links.push(['/people', 'People']);
  nav.replaceChildren(...links.map(([href, label]) => h('a', { href, 'data-link': true, class: path === href ? 'on' : '' }, label)));
  const lease = path.match(/^\/leases\/([^/]+)$/);
  if (lease) return leaseView(lease[1]);
  if (path === '/connect') return connectView();
  if (path === '/cli-login') return cliLoginView();
  if (path === '/people') return peopleView();
  return devicesView();
}

function loginView() {
  nav.replaceChildren();
  who.replaceChildren();
  const used = new URLSearchParams(location.search).get('error') === 'link-used';
  const err = h('p', { class: 'error' }, used ? 'That sign-in link was already used or has expired. Sign in with your name and password, or run `hangar up` again for a new admin link.' : '');
  const form = h(
    'form',
    {
      class: 'card narrow',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/v1/login', { name: form.name.value, password: form.password.value });
          go(location.pathname === '/cli-login' ? location.pathname + location.search : '/');
        } catch (x) {
          err.textContent = x.message;
        }
      },
    },
    h('h1', {}, 'Sign in'),
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
  const models = [...new Map(devices.map((d) => [`${d.model}|${d.os}`, d])).values()];
  let waiting = false;
  const use = async (d, button) => {
    waiting = true;
    button.disabled = true;
    button.textContent = 'Getting a device…';
    try {
      const lease = await api('POST', '/v1/leases?wait=120', { class: { model: d.model, os: d.os } });
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
            h('span', {}, `${l.device ? `${l.device.model}, iOS ${l.device.os}` : 'Waiting for a device'} `, h('span', { class: `state ${l.state}` }, l.state)),
            h('a', { href: `/leases/${l.id}`, 'data-link': true }, 'Open')),
        ))
      : '',
    h('h2', {}, 'Available'),
    models.length
      ? h('div', { class: 'card' },
          h('table', {},
            h('tr', {}, h('th', {}, 'Device'), h('th', {}, 'Free'), h('th', {}, 'Mac'), h('th', {})),
            ...models.map((d) => {
              const same = devices.filter((x) => x.model === d.model && x.os === d.os);
              const free = same.filter((x) => x.state === 'ready').length;
              const b = h('button', { class: 'primary', onclick: () => use(d, b) }, 'Use one');
              return h('tr', {}, h('td', {}, `${d.model}, iOS ${d.os}`), h('td', {}, `${free} of ${same.length}`), h('td', { class: 'muted' }, d.host), h('td', { style: 'text-align:right' }, b));
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
  const file = h('input', { type: 'file', accept: '.zip,.tar,.tgz,.gz' });
  const urlInput = h('input', { type: 'url', placeholder: 'https://example.com or myapp://path' });

  app.replaceChildren(
    h('div', { class: 'lease' },
      h('div', {},
        screen,
        h('div', { class: 'row', style: 'margin-top:10px;justify-content:center' },
          h('button', { onclick: () => send({ type: 'button', button: 'home' }) }, 'Home'),
          h('button', { onclick: () => send({ type: 'button', button: 'lock' }) }, 'Lock'),
          h('a', { class: 'button', href: `/v1/leases/${id}/screenshot`, download: 'screenshot.png' }, 'Screenshot'),
        ),
      ),
      h('div', { class: 'side' },
        h('div', { class: 'card' },
          h('h1', { style: 'margin-bottom:4px' }, `${lease.device.model}, iOS ${lease.device.os}`),
          h('p', { class: 'muted', style: 'margin-top:0' }, 'Yours until you release it or leave it idle for 5 minutes. It is wiped when released.'),
          h('div', { class: 'row' },
            h('button', { onclick: () => navigator.clipboard.writeText(location.href).then(() => (out.textContent = 'Link copied.')) }, 'Copy link'),
            h('button', { class: 'danger', onclick: async () => { await api('DELETE', `/v1/leases/${id}`); go('/'); } }, 'Release'),
          ),
          out,
        ),
        h('div', { class: 'card' },
          h('h2', { style: 'margin-top:0' }, 'Install an app'),
          h('p', { class: 'muted' }, 'A zipped simulator build (.app folder). Uploading needs permission from an operator.'),
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

async function connectView() {
  const result = h('div');
  app.replaceChildren(
    h('h1', {}, 'Connect an agent or a script'),
    h('div', { class: 'card' },
      h('p', {}, 'Make a token for each agent, script or CI job, so you can revoke one without breaking the others.'),
      h('label', { for: 'label' }, 'What is it for?'),
      h('input', { id: 'label', type: 'text', placeholder: 'For example: support agent, nightly CI' }),
      h('p', {}, h('button', { class: 'primary', onclick: async () => {
        const label = document.getElementById('label').value || 'token';
        const t = await api('POST', '/v1/tokens', { label });
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
  const people = await api('GET', '/v1/people');
  const result = h('div');
  const role = h('select', {}, h('option', { value: 'member' }, 'Member: uses devices'), h('option', { value: 'operator' }, 'Operator: runs Hangar, can upload apps'));
  app.replaceChildren(
    h('h1', {}, 'People'),
    h('div', { class: 'card' },
      h('table', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role')), ...people.map((p) => h('tr', {}, h('td', {}, p.name), h('td', { class: 'muted' }, p.role)))),
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
