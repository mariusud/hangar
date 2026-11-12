import { LANGUAGES, LIMIT_FIELDS, bookingBody, canRerun, canRotate, capSeconds, capValue, daysText, deviceRows, duration, endingText, flowRecordings, heldText, isLanguageTag, leaseClass, limitsText, linkPath, logTail, mcpSettings, openAgainError, openAgainTarget, parseEnv, percent, viewExpiry, windowStatus, withView } from './lib.js';

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
    throw Object.assign(new Error(e.hint ? `${e.message} ${e.hint}` : e.message), { code: e.code });
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
  const recording = path.match(/^\/recordings\/([^/]+)$/);
  const view = new URLSearchParams(location.search).get('view');
  if (!me && recording && view) {
    nav.replaceChildren();
    who.replaceChildren();
    return recordingView(recording[1], view);
  }
  if (!me) return loginView();
  who.replaceChildren(`${me.name} · `, h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await api('POST', '/v1/logout'); go('/'); } }, 'Sign out'));
  const links = [['/', 'Devices'], ['/runs', 'Runs'], ['/tests/flaky', 'Flaky flows'], ['/recordings', 'Recordings'], ['/schedule', 'Schedule'], ['/nights', 'Nights'], ['/connect', 'Connect']];
  if (me.role === 'operator') {
    links.splice(1, 0, ['/fleet', 'Fleet']);
    links.push(['/people', 'People']);
  }
  nav.replaceChildren(...links.map(([href, label]) => h('a', { href, 'data-link': true, class: path === href || (href !== '/' && path.startsWith(`${href}/`)) ? 'on' : '' }, label)));
  const lease = path.match(/^\/leases\/([^/]+)$/);
  if (lease) return leaseView(lease[1]);
  if (recording) return recordingView(recording[1], view);
  if (path === '/recordings') return recordingsView();
  const run = path.match(/^\/runs\/([^/]+)$/);
  if (run) return runView(run[1]);
  if (path === '/runs') return runsView();
  if (path === '/tests/flaky') return flakyView();
  if (path === '/schedule') return scheduleView();
  const night = path.match(/^\/nights\/([^/]+)$/);
  if (night) return nightView(night[1]);
  if (path === '/nights') return nightsView();
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
  const [devices, leases, images] = await Promise.all([api('GET', '/v1/devices'), api('GET', '/v1/leases'), api('GET', '/v1/images').catch(() => [])]);
  const mine = leases.filter((l) => l.state !== 'ended');
  if (chosenImage && !images.some((i) => i.name === chosenImage)) chosenImage = null;
  const rows = deviceRows(devices, chosenImage);
  let waiting = false;
  const use = async (row, button, label) => {
    waiting = true;
    button.disabled = true;
    button.textContent = 'Getting a device…';
    try {
      const lease = await api('POST', '/v1/leases?wait=120', { class: leaseClass(row, chosenImage), via: 'Console' });
      go(`/leases/${lease.id}`);
    } catch (x) {
      err.textContent = x.message;
      button.disabled = false;
      button.textContent = label;
      waiting = false;
    }
  };
  const picker = images.length
    ? h('div', { class: 'row', style: 'margin-bottom:10px' },
        h('label', { for: 'image', style: 'margin:0' }, 'Image'),
        h('select', { id: 'image', onchange: (e) => { chosenImage = e.target.value || null; render(); } },
          h('option', { value: '', selected: !chosenImage }, 'None: a clean device'),
          ...images.map((i) => h('option', { value: i.name, selected: i.name === chosenImage }, imageLabel(i)))),
      )
    : '';
  const waitButton = h('button', { class: 'primary', onclick: () => use(null, waitButton, 'Wait for one') }, 'Wait for one');
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
    rows.length
      ? h('div', { class: 'card' },
          picker,
          h('table', {},
            h('tr', {}, h('th', {}, 'Device'), h('th', {}, 'Free'), h('th', {}, 'Mac'), h('th', {})),
            ...rows.map((row) => {
              const b = h('button', { class: 'primary', onclick: () => use(row, b, 'Use one') }, 'Use one');
              return h('tr', {}, h('td', {}, system(row)), h('td', {}, `${row.free} of ${row.total}`), h('td', { class: 'muted' }, row.host), h('td', { style: 'text-align:right' }, b));
            }),
          ))
      : chosenImage
        ? h('div', { class: 'card' },
            picker,
            h('p', { class: 'muted' }, `No device has the image ${chosenImage} yet. Each Mac builds its image devices after an operator sets the image, which takes a few minutes. You can wait in the queue for one.`),
            waitButton)
        : h('p', { class: 'card muted' }, 'No Mac is connected yet. Run `npx hangar up` on a Mac with Xcode.'),
    err,
  );
  const t = setInterval(() => !waiting && render(), 10_000);
  cleanup = () => clearInterval(t);
}

let chosenImage = null;

const imageLabel = (i) => {
  const extras = [i.apps.length ? `${i.apps.length} app${i.apps.length === 1 ? '' : 's'}` : '', i.locale ?? '', i.appearance ?? ''].filter(Boolean);
  return extras.length ? `${i.name} (${extras.join(', ')})` : i.name;
};

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

  const ends = h('p', { class: 'muted', style: 'margin-top:0' });
  const showEnd = (l) => {
    ends.textContent = l.expiresAt ? `If nothing happens on it, it ends at ${new Date(l.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : '';
  };
  showEnd(lease);

  // Preemption and window ends come as 'lease_ending' on the lease's event stream.
  const warning = h('div', { class: 'ending', role: 'alert', hidden: true });
  let ending = lease.ending;
  const tickEnding = () => {
    warning.hidden = !ending;
    if (ending) warning.textContent = endingText(ending, Date.now());
  };
  tickEnding();
  const countdownTimer = setInterval(tickEnding, 1000);
  const events = new EventSource(`/v1/leases/${id}/events`);
  events.addEventListener('lease_ending', (e) => {
    ending = JSON.parse(e.data).ending;
    tickEnding();
  });
  events.addEventListener('ended', (e) => {
    events.close();
    ending = null;
    tickEnding();
    const l = JSON.parse(e.data);
    warning.hidden = false;
    warning.textContent = `This lease has ended (${l.reason}).`;
  });
  const heldCard = h('div', { class: 'card', hidden: true });
  const q = new URLSearchParams(location.search);
  if (q.get('run') && q.get('flow')) void heldContext(q.get('run'), q.get('flow'), heldCard);
  // An open, visible tab counts as use. The checkbox lets a hidden tab count too, up to the longest-lease limit.
  const background = h('input', { type: 'checkbox' });
  const renew = setInterval(() => {
    if (document.visibilityState === 'visible' || background.checked) {
      api('POST', `/v1/leases/${id}/renew`).then(showEnd, () => {});
    }
  }, 60_000);
  cleanup = () => {
    clearInterval(renew);
    clearInterval(countdownTimer);
    events.close();
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
  const bundleInput = h('input', { type: 'text', placeholder: 'App bundle ID, such as com.example.app', 'aria-label': 'App bundle ID' });
  const languageInput = h('input', { type: 'text', list: 'languages', placeholder: 'nb-NO', 'aria-label': 'Language', style: 'width:9em' });
  const setLanguage = () => run('Changing the language', async () => {
    const bundleId = bundleInput.value.trim();
    const language = languageInput.value.trim();
    if (!bundleId) throw new Error('Enter the bundle ID of the app to change. Installing an app here fills it in.');
    if (!isLanguageTag(language)) throw new Error(`"${language}" is not a language tag such as nb-NO or en-US.`);
    await api('POST', `/v1/leases/${id}/locale`, { bundleId, language });
    // The app reads its language when it starts, so restart it if it is running.
    await api('POST', `/v1/leases/${id}/apps/${encodeURIComponent(bundleId)}/terminate`).catch(() => {});
    await api('POST', `/v1/leases/${id}/apps/${encodeURIComponent(bundleId)}/launch`);
    return `${bundleId} now runs in ${language}.`;
  });

  const tags = [`Priority ${lease.priority ?? 'interactive'}`];
  if (lease.booking) tags.push(`booking ${lease.booking}`);
  app.replaceChildren(
    warning,
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
        heldCard,
        h('div', { class: 'card' },
          h('h1', { style: 'margin-bottom:4px' }, system(lease.device)),
          h('p', { class: 'muted', style: 'margin-top:0;margin-bottom:4px' }, tags.join(', ')),
          h('p', { class: 'muted', style: 'margin-top:0;margin-bottom:4px' }, limitsText(lease.limits)),
          ends,
          h('label', { class: 'check', title: `Keeps the device while you work in another tab. It still ends ${duration(lease.limits.maxMs)} after you got it, and soon after you close this tab.` },
            background, ' Keep it while this tab is in the background'),
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
            bundleInput.value = r.bundleId;
            await api('POST', `/v1/leases/${id}/apps/${encodeURIComponent(r.bundleId)}/launch`);
            return `Installed and opened ${r.name}.`;
          }) }, 'Install')),
        ),
        h('div', { class: 'card' },
          h('h2', { style: 'margin-top:0' }, 'Device settings'),
          h('div', { class: 'row' },
            h('span', { class: 'muted' }, 'Appearance'),
            h('button', { onclick: () => run('Switching to light', () => api('POST', `/v1/leases/${id}/appearance`, { mode: 'light' })) }, 'Light'),
            h('button', { onclick: () => run('Switching to dark', () => api('POST', `/v1/leases/${id}/appearance`, { mode: 'dark' })) }, 'Dark'),
          ),
          canRotate(lease.device.platform)
            ? h('div', { class: 'row', style: 'margin-top:8px' },
                h('span', { class: 'muted' }, 'Rotation'),
                h('button', { onclick: () => run('Rotating', () => api('POST', `/v1/leases/${id}/orientation`, { orientation: 'portrait' })) }, 'Portrait'),
                h('button', { onclick: () => run('Rotating', () => api('POST', `/v1/leases/${id}/orientation`, { orientation: 'landscapeLeft' })) }, 'Landscape'),
              )
            : '',
          isAndroid
            ? ''
            : h('div', {},
                h('p', { class: 'muted' }, 'Language for one app. The app restarts in that language.'),
                h('div', { class: 'row' }, bundleInput),
                h('div', { class: 'row', style: 'margin-top:8px' },
                  languageInput,
                  h('datalist', { id: 'languages' }, ...LANGUAGES.map(([tag, name]) => h('option', { value: tag }, name))),
                  h('button', { onclick: setLanguage }, 'Set language')),
              ),
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
          const t = await api('POST', '/v1/tokens', { label: `CLI on ${computer}`, ...(me.role === 'operator' ? { scopes: ['operator', 'install:upload'] } : {}) });
          callback.searchParams.set('token', t.token);
          location.href = callback.toString();
        } }, 'Approve'),
        h('a', { href: '/', 'data-link': true }, 'Cancel'),
      ),
    ),
  );
}

async function peopleView() {
  const [people, teams, limits] = await Promise.all([api('GET', '/v1/people'), api('GET', '/v1/teams'), api('GET', '/v1/lease-limits').catch(() => null)]);
  const result = h('div');
  const status = h('p', { class: 'muted' });
  const role = h('select', {}, h('option', { value: 'member' }, 'Member: uses devices'), h('option', { value: 'operator' }, 'Operator: runs Hangar, can upload apps'));
  const save = (fn) => fn().then(() => peopleView(), (x) => (status.textContent = x.message));
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
    ...(limits ? leaseLimitsCard(limits.caps) : []),
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

const ROLE_NAMES = { member: 'Members', operator: 'Operators', agent: 'Agent tokens' };

function leaseLimitsCard(caps) {
  const status = h('p', { class: 'muted' });
  const rows = Object.entries(caps).map(([role, cap]) => {
    const inputs = LIMIT_FIELDS.map((f) => h('input', { type: 'number', min: 0, step: 'any', value: capValue(cap[`${f.key}Ms`], f), 'aria-label': `${f.label} for ${role}, in ${f.unit}`, style: 'width:7em' }));
    const saveButton = h('button', { onclick: async () => {
      try {
        const b = Object.fromEntries(LIMIT_FIELDS.map((f, i) => [`${f.key}Seconds`, capSeconds(inputs[i]?.value ?? '', f)]));
        const next = await api('PUT', `/v1/lease-limits/${role}`, b);
        LIMIT_FIELDS.forEach((f, i) => {
          const input = inputs[i];
          if (input) input.value = capValue(next[`${f.key}Ms`], f);
        });
        status.textContent = `Saved the caps for ${ROLE_NAMES[role]?.toLowerCase() ?? role}. Leases already running keep the limits they started with.`;
      } catch (x) {
        status.textContent = x.message;
      }
    } }, 'Save');
    return h('tr', {}, h('td', {}, ROLE_NAMES[role] ?? role), ...inputs.map((i) => h('td', {}, i)), h('td', {}, saveButton));
  });
  return [
    h('h2', {}, 'Lease limits'),
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'The most a token may ask for, per role. A lease ends when it has been idle this long, or held this long in all. Reconnect grace is how long a lease waits for a client that lost its connection. Empty a field to go back to the built-in cap.'),
      h('table', {},
        h('tr', {}, h('th', {}, 'Role'), ...LIMIT_FIELDS.map((f) => h('th', {}, `${f.label} (${f.unit})`)), h('th', {})),
        ...rows,
      ),
      status,
    ),
  ];
}

render();

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

async function recordingView(id, view = null) {
  const rec = await api('GET', withView(`/v1/recordings/${id}`, view)).catch((x) => ({ error: x.message }));
  if (rec.error) {
    app.replaceChildren(
      h('p', { class: 'error' }, me ? rec.error : 'This link has expired or is not valid. Ask the person who shared it for a new one.'),
      me ? h('a', { href: '/recordings', 'data-link': true }, 'All recordings') : '',
    );
    return;
  }
  const files = Object.fromEntries(Object.entries(rec.files).map(([k, v]) => [k, withView(v, view)]));
  const title = h('h1', { style: 'margin-bottom:4px' }, `${rec.device ?? 'Device'}, recorded by ${rec.owner}`);
  const meta = h('p', { class: 'muted', style: 'margin-top:0' }, rec.startedAt ? `${new Date(rec.startedAt).toLocaleString()} · ${rec.durationMs === null ? '' : seconds(rec.durationMs)}` : '');
  if (rec.state !== 'ready') {
    const why = { waiting: 'Waiting for the device.', recording: 'Still recording.', saving: 'The Mac is saving the recording. Reload in a moment.', failed: `The recording failed: ${rec.error}` };
    app.replaceChildren(title, meta, h('p', {}, why[rec.state] ?? rec.state));
    return;
  }

  const video = h('video', { src: files.video, controls: true, playsinline: true, preload: 'auto' });
  const seek = (ms) => {
    video.currentTime = ms / 1000;
    video.play().catch(() => {});
  };
  const timeline = await fetch(files.timeline).then((r) => (r.ok ? r.json() : []), () => []);
  const logText = await fetch(files.log).then((r) => (r.ok ? r.text() : ''), () => '');
  const log = logText.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const e = JSON.parse(line);
      return [{ at: Date.parse(e.timestamp.replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) - rec.startedAt, process: e.processImagePath?.split('/').pop() ?? '', level: e.messageType ?? '', message: e.eventMessage ?? '' }];
    } catch {
      return [];
    }
  });

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
          view ? h('p', { class: 'muted' }, `View only. This link works until ${new Date(viewExpiry(view) ?? 0).toLocaleString()}.`) : '',
          h('div', { class: 'row' },
            me ? h('button', { onclick: (e) => navigator.clipboard.writeText(location.origin + location.pathname).then(() => (e.target.textContent = 'Link copied')) }, 'Copy link') : '',
            me ? shareButton(id) : '',
            h('a', { class: 'button', href: files.video, download: `hangar-${id}.mp4` }, 'Video'),
            h('a', { class: 'button', href: files.screenshot, download: `hangar-${id}.png` }, 'Last screenshot'),
            h('a', { class: 'button', href: files.log, download: `hangar-${id}.ndjson` }, 'App log'),
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

function shareButton(id) {
  const button = h('button', { title: 'A link anyone can open for 7 days to watch this recording, without an account', onclick: async () => {
    button.disabled = true;
    try {
      const link = await api('POST', `/v1/recordings/${id}/share`);
      await navigator.clipboard.writeText(link.url);
      button.textContent = `View-only link copied, works until ${new Date(link.expiresAt).toLocaleDateString()}`;
    } catch (x) {
      button.textContent = x.message;
    } finally {
      button.disabled = false;
    }
  } }, 'Copy view-only link');
  return button;
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
  let events = null;
  const follow = () => {
    events?.close();
    events = new EventSource(`/v1/runs/${id}/events`);
    const stream = events;
    for (const state of ['running', 'passed', 'failed', 'cancelled']) {
      stream.addEventListener(state, (e) => {
        show(JSON.parse(e.data));
        // The server ends the stream once the run is over; without this EventSource reconnects.
        if (state !== 'running') stream.close();
      });
    }
  };
  cleanup = () => events?.close();
  // Hangar keeps a run's environment values in memory only, so after a restart a rerun asks for them again.
  const status = h('p', { class: 'muted' });
  const envBox = h('div', { class: 'card', hidden: true });
  const rerun = async (flow, env) => {
    status.textContent = `Rerunning ${flow} on a fresh device…`;
    try {
      const r = await api('POST', `/v1/runs/${id}/flows/${encodeURIComponent(flow)}/rerun`, env ? { env } : {});
      envBox.hidden = true;
      status.textContent = `Rerunning ${flow} on a fresh device. The result shows here when it is done.`;
      show(r);
      follow();
    } catch (x) {
      status.textContent = x.message;
      if (x.code === 'ENV_NEEDED') askEnv(flow);
    }
  };
  const askEnv = (flow) => {
    const text = h('textarea', { rows: 4, placeholder: 'USER=test\nPASSWORD=…', 'aria-label': 'Environment values' });
    const err = h('p', { class: 'error' });
    envBox.replaceChildren(
      h('h2', { style: 'margin-top:0' }, `Environment for ${flow}`),
      h('p', { class: 'muted' }, 'One KEY=value per line. Hangar uses them for this rerun and does not save them.'),
      text,
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'primary', onclick: () => {
        try {
          void rerun(flow, parseEnv(text.value));
        } catch (x) {
          err.textContent = x.message;
        }
      } }, 'Rerun'), h('button', { onclick: () => (envBox.hidden = true) }, 'Cancel')),
      err,
    );
    envBox.hidden = false;
    text.focus();
  };
  const takeHeld = async (flow) => {
    status.textContent = `Getting the device ${flow} failed on…`;
    try {
      const lease = await api('POST', `/v1/runs/${id}/flows/${encodeURIComponent(flow)}/hold-lease`);
      go(`/leases/${lease.id}?run=${encodeURIComponent(id)}&flow=${encodeURIComponent(flow)}`);
    } catch (x) {
      status.textContent = x.message;
    }
  };
  const releaseHeld = async (flow) => {
    try {
      show(await api('DELETE', `/v1/runs/${id}/flows/${encodeURIComponent(flow)}/hold`));
      status.textContent = `Released the device ${flow} failed on. Hangar wipes it and puts it back in the pool.`;
    } catch (x) {
      status.textContent = x.message;
    }
  };
  const show = (r) => {
    const cancel = r.state === 'running' && (r.owner === me.name || me.role === 'operator')
      ? h('button', { onclick: () => api('DELETE', `/v1/runs/${id}`).then(show) }, 'Cancel run')
      : '';
    if (r.state !== 'running' && status.textContent.startsWith('Rerunning')) status.textContent = '';
    app.replaceChildren(
      h('h1', { style: 'margin-bottom:4px' }, `${r.build}, started by ${r.owner}`),
      h('p', { class: 'muted', style: 'margin-top:0' }, `${new Date(r.createdAt).toLocaleString()} · ${r.shards} shard${r.shards === 1 ? '' : 's'} · ${seconds(r.durationMs)} · `, h('span', { class: `state ${r.state}` }, r.state)),
      r.error ? h('p', { class: 'error' }, r.error) : '',
      h('div', { class: 'row' }, h('a', { class: 'button', href: r.junit, download: `hangar-run-${id}.xml` }, 'JUnit report'), cancel),
      h('table', {},
        h('tr', {}, h('th', {}, 'Flow'), h('th', {}, 'Shard'), h('th', {}, 'Attempts'), h('th', {}, 'State'), h('th', {}, '')),
        ...r.flows.map((f) => h('tr', {},
          h('td', {}, f.flow, f.message ? h('div', { class: 'muted' }, f.message) : '', f.held ? h('div', { class: 'state held' }, heldText(f.held.until, Date.now())) : ''),
          h('td', {}, f.shard + 1),
          h('td', {}, f.attempts),
          h('td', { class: `state ${f.status}` }, f.status),
          h('td', {},
            h('div', { class: 'row' },
              ...flowRecordings(f).map((l) => h('a', { href: l.href, 'data-link': true }, l.label)),
              canRerun(r, f) ? h('button', { title: 'Run this flow again on a fresh device, recorded', onclick: () => rerun(f.flow) }, 'Rerun') : '',
              f.held ? h('button', { class: 'primary', title: 'Lease the device this flow failed on, as the flow left it', onclick: () => takeHeld(f.flow) }, 'Take the device') : '',
              f.held ? h('button', { title: 'Let the device go. Hangar wipes it and puts it back in the pool.', onclick: () => releaseHeld(f.flow) }, 'Release') : '',
            ),
          ),
        )),
      ),
      status,
      envBox,
    );
  };
  show(first);
  if (first.state === 'running') follow();
}

async function flakyView() {
  const data = await api('GET', '/v1/tests/flaky');
  const recordingLink = (url) => {
    const [link] = flowRecordings({ flow: '', status: 'failed', recording: url });
    return link ? h('a', { href: link.href, 'data-link': true }, 'Recording') : '';
  };
  app.replaceChildren(
    h('h1', { style: 'margin-bottom:4px' }, 'Flaky flows'),
    h('p', { class: 'muted', style: 'margin-top:0' }, `From your team's last ${data.runs} finished run${data.runs === 1 ? '' : 's'}. A flow is flaky in a run when it failed and then passed on a retry or a rerun.`),
    data.tests.length === 0
      ? h('p', { class: 'card muted' }, 'No flow has failed or been flaky in these runs.')
      : h('div', { class: 'card' },
          h('table', {},
            h('tr', {}, h('th', {}, 'Flow'), h('th', {}, 'Runs'), h('th', {}, 'Flaky'), h('th', {}, 'Failed'), h('th', {}, 'Last')),
            ...data.tests.map((t) => h('tr', {},
              h('td', {}, t.test, t.kind !== 'maestro' ? h('span', { class: 'muted' }, ` (${t.kind})`) : ''),
              h('td', {}, t.runs),
              h('td', {}, `${percent(t.flakeRate)} (${t.flaky})`),
              h('td', {}, `${percent(t.failRate)} (${t.failed})`),
              h('td', { class: `state ${t.lastStatus}` }, t.lastStatus, h('span', { class: 'muted' }, ` · ${new Date(t.lastRunAt).toLocaleDateString()}`)),
            )),
          )),
    h('h2', {}, 'Failures by message'),
    data.failures.length === 0
      ? h('p', { class: 'card muted' }, 'No failures.')
      : h('div', { class: 'card' },
          h('p', { class: 'muted', style: 'margin-top:0' }, 'Messages that differ only in numbers, ids and timings are counted together.'),
          h('table', {},
            h('tr', {}, h('th', {}, 'Message'), h('th', {}, 'Times'), h('th', {}, 'Flows'), h('th', {})),
            ...data.failures.map((g) => h('tr', {},
              h('td', {}, h('code', {}, g.example)),
              h('td', {}, g.count),
              h('td', {}, g.tests.join(', ')),
              h('td', {}, h('div', { class: 'row' }, h('a', { href: `/runs/${g.lastRunId}`, 'data-link': true }, 'Last run'), g.recording ? recordingLink(g.recording) : '')),
            )),
          )),
  );
}

const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

const stepList = (steps) =>
  steps.length
    ? h('div', { class: 'steps' }, steps.map((s) => h('div', { class: s.failed ? 'step error' : 'step' }, h('span', { class: 'muted' }, seconds(s.at)), ' ', s.what, s.failed ? ` (failed: ${s.failed})` : '')))
    : h('p', { class: 'muted' }, 'No steps were recorded.');

// Beside the stream of a held device: what the flow did and how it failed.
async function heldContext(runId, flow, card) {
  const run = await api('GET', `/v1/runs/${runId}`).catch(() => null);
  const f = run?.flows.find((x) => x.flow === flow);
  if (!run || !f) return;
  const recording = f.recording ?? f.firstRecording;
  const recordingId = recording ? /\/recordings\/([^/?#]+)/.exec(linkPath(recording))?.[1] : null;
  let steps = null;
  if (recordingId) {
    const rec = await api('GET', `/v1/recordings/${recordingId}`).catch(() => null);
    steps = rec?.files?.timeline ? await fetch(rec.files.timeline).then((r) => (r.ok ? r.json() : null), () => null) : null;
  }
  card.replaceChildren(
    h('h2', { style: 'margin-top:0' }, `${f.flow} ${f.status === 'flaky' ? 'was flaky' : 'failed'} here`),
    h('p', { class: 'muted', style: 'margin-top:0' }, `Run of ${run.build}, started by ${run.owner}. `, f.held ? heldText(f.held.until, Date.now()) : 'The hold has ended.'),
    f.message ? h('code', { class: 'code error' }, f.message) : '',
    h('h2', {}, 'Steps'),
    steps ? stepList(steps) : h('p', { class: 'muted' }, 'This flow kept no recording, so its steps are not known.'),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('a', { href: `/runs/${runId}`, 'data-link': true }, 'Back to the run'),
      recordingId ? h('a', { href: `/recordings/${recordingId}`, 'data-link': true }, 'Recording') : '',
    ),
    h('p', { class: 'muted' }, 'Release below ends this lease, and Hangar wipes the device.'),
  );
  card.hidden = false;
}

async function scheduleView() {
  const [data, floors, images] = await Promise.all([api('GET', '/v1/bookings'), api('GET', '/v1/ci-floors').catch(() => []), api('GET', '/v1/images').catch(() => [])]);
  const status = h('p', { class: 'muted' });
  const tokenBox = h('div', { class: 'card', hidden: true });
  const now = Date.now();
  const makeToken = async (b) => {
    try {
      const t = await api('POST', `/v1/bookings/${encodeURIComponent(b.name)}/tokens`, { label: `booking ${b.name} from the console`, agent: true });
      const s = mcpSettings(t.mcp, t.token);
      tokenBox.replaceChildren(
        h('h2', { style: 'margin-top:0' }, `Token for ${b.name}`),
        h('p', { class: 'muted' }, `It leases only from ${b.name}, only while its window is open. A lease asked for early waits for the window. Copy it now; it is shown only once.`),
        h('code', { class: 'code' }, t.token),
        h('h2', {}, 'MCP settings for an agent'),
        h('p', { class: 'muted' }, 'For Cursor, or any client that reads mcpServers.'),
        h('pre', { class: 'code' }, s.json),
        h('h2', {}, 'Claude Code'),
        h('code', { class: 'code' }, s.claude),
        h('button', { onclick: () => (tokenBox.hidden = true) }, 'Done'),
      );
      tokenBox.hidden = false;
      tokenBox.scrollIntoView({ block: 'nearest' });
    } catch (x) {
      status.textContent = x.message;
    }
  };
  const remove = async (b) => {
    if (!confirm(`Remove the booking ${b.name}? Leases from it end now.`)) return;
    try {
      await api('DELETE', `/v1/bookings/${encodeURIComponent(b.name)}`);
      await scheduleView();
    } catch (x) {
      status.textContent = x.message;
    }
  };
  const describeClass = (c) => [c.image ? `image ${c.image}` : '', c.model ?? '', c.os ? `OS ${c.os}` : '', c.platform === 'android-emulator' ? 'Android' : ''].filter(Boolean).join(', ');

  const fields = {
    name: h('input', { type: 'text', placeholder: 'nightly-qa', 'aria-label': 'Name', required: true }),
    devices: h('input', { type: 'number', min: 1, value: '1', 'aria-label': 'Devices' }),
    days: h('input', { type: 'text', placeholder: 'weekdays, mon-thu or daily', value: 'weekdays', 'aria-label': 'Days' }),
    from: h('input', { type: 'time', value: '18:00', 'aria-label': 'From' }),
    to: h('input', { type: 'time', value: '07:00', 'aria-label': 'To' }),
    image: h('select', { 'aria-label': 'Image' }, h('option', { value: '' }, 'None: clean devices'), ...images.map((i) => h('option', { value: i.name }, i.name))),
  };
  const formError = h('p', { class: 'error' });
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    formError.textContent = '';
    try {
      const body = bookingBody(Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value])));
      await api('POST', '/v1/bookings', body);
      await scheduleView();
    } catch (x) {
      formError.textContent = x.message;
    }
  } },
    h('div', { class: 'grid' },
      h('div', {}, h('label', {}, 'Name'), fields.name),
      h('div', {}, h('label', {}, 'Devices'), fields.devices),
      h('div', {}, h('label', {}, 'Days'), fields.days),
      h('div', {}, h('label', {}, 'From'), fields.from),
      h('div', {}, h('label', {}, 'To'), fields.to),
      images.length ? h('div', {}, h('label', {}, 'Image'), fields.image) : '',
    ),
    h('p', { class: 'muted' }, `Times are in the broker’s time zone, ${data.timeZone}. A window that ends before it starts runs past midnight.`),
    h('button', { class: 'primary', type: 'submit' }, 'Book'),
    formError,
  );

  const floorRows = floors.map((f) => {
    const input = h('input', { type: 'number', min: 0, value: String(f.floor), 'aria-label': `CI floor for ${f.host}`, style: 'width:6em', disabled: me.role !== 'operator' });
    const save = h('button', { onclick: async () => {
      try {
        const text = input.value.trim();
        const next = await api('PUT', `/v1/ci-floors/${encodeURIComponent(f.host)}`, { floor: text === '' ? null : Number(text) });
        input.value = String(next.floor);
        status.textContent = `Saved. Bookings leave ${next.floor} device${next.floor === 1 ? '' : 's'} on ${f.host} for CI.`;
      } catch (x) {
        status.textContent = x.message;
      }
    } }, 'Save');
    return h('tr', {}, h('td', {}, f.host, f.connected ? '' : h('span', { class: 'muted' }, ' (not connected)')), h('td', {}, f.devices), h('td', {}, input), me.role === 'operator' ? h('td', {}, save) : '');
  });

  app.replaceChildren(
    h('h1', { style: 'margin-bottom:4px' }, 'Schedule'),
    h('p', { class: 'muted', style: 'margin-top:0' }, 'A booking holds devices for a team on given days, such as a night for the nightly suite and QA agents. Only tokens made for a booking lease from it, and CI goes first.'),
    data.bookings.length === 0
      ? h('p', { class: 'card muted' }, 'No bookings yet.')
      : h('div', { class: 'card' },
          h('table', {},
            h('tr', {}, h('th', {}, 'Booking'), h('th', {}, 'Team'), h('th', {}, 'Devices'), h('th', {}, 'When'), h('th', {}, 'Window'), h('th', {}, 'Leases'), h('th', {})),
            ...data.bookings.map((b) => {
              const w = windowStatus(b, now);
              return h('tr', {},
                h('td', {}, h('strong', {}, b.name)),
                h('td', {}, b.team),
                h('td', {}, b.devices, describeClass(b.class) ? h('div', { class: 'muted' }, describeClass(b.class)) : ''),
                h('td', {}, `${daysText(b.days)}, ${b.from} to ${b.to}`),
                h('td', { class: w.open ? 'state active' : 'state' }, w.text, !w.open && b.next ? h('div', { class: 'muted' }, when(b.next.from)) : ''),
                h('td', {}, b.leases),
                h('td', {}, h('div', { class: 'row' },
                  h('button', { title: 'A token for agents that leases only from this booking', onclick: () => makeToken(b) }, 'Make a token'),
                  h('button', { class: 'danger', onclick: () => remove(b) }, 'Remove'))),
              );
            }),
          )),
    status,
    tokenBox,
    h('h2', {}, 'Book devices'),
    h('div', { class: 'card' }, form),
    h('h2', {}, 'CI floor'),
    h('div', { class: 'card' },
      h('p', { class: 'muted', style: 'margin-top:0' }, 'How many devices on each Mac bookings never take, so CI always finds one. The floor and the bookings together may not be more than a Mac has.'),
      floors.length
        ? h('table', {}, h('tr', {}, h('th', {}, 'Mac'), h('th', {}, 'Devices'), h('th', {}, 'Floor'), me.role === 'operator' ? h('th', {}) : ''), ...floorRows)
        : h('p', { class: 'muted' }, 'No Mac is connected yet.'),
      me.role === 'operator' ? '' : h('p', { class: 'muted' }, 'Only an operator can change the floor.'),
    ),
  );
}

async function nightsView() {
  const list = await api('GET', '/v1/nights');
  app.replaceChildren(
    h('h1', {}, 'Nights'),
    list.length === 0
      ? h('p', { class: 'card muted' }, 'No nights yet. A night opens with `hangar night open <booking>` and closes when the booking’s window closes.')
      : h('div', { class: 'card' },
          h('table', {},
            h('tr', {}, h('th', {}, 'Opened'), h('th', {}, 'Booking'), h('th', {}, 'Team'), h('th', {}, 'Closed'), h('th', {}, 'State')),
            ...list.map((n) => h('tr', {},
              h('td', {}, h('a', { href: `/nights/${n.id}`, 'data-link': true }, when(n.openedAt))),
              h('td', {}, n.booking),
              h('td', {}, n.team),
              h('td', {}, when(n.closedAt)),
              h('td', { class: `state ${n.state === 'open' ? 'active' : 'ended'}` }, n.state),
            )),
          )),
  );
}

async function nightView(id) {
  const [night, report] = await Promise.all([api('GET', `/v1/nights/${id}`), api('GET', `/v1/nights/${id}/report`)]).catch((x) => [{ error: x.message }, null]);
  if (night.error || !report) {
    app.replaceChildren(h('p', { class: 'error' }, night.error ?? 'No report.'), h('a', { href: '/nights', 'data-link': true }, 'All nights'));
    return;
  }
  const s = report.summary;
  const severities = ['critical', 'high', 'medium', 'low'].filter((k) => s.bySeverity[k]).map((k) => `${s.bySeverity[k]} ${k}`);
  app.replaceChildren(
    h('h1', { style: 'margin-bottom:4px' }, `${night.booking}, ${when(night.openedAt)}`),
    h('p', { class: 'muted', style: 'margin-top:0' },
      `${night.team} · opened by ${night.openedBy} · `,
      night.state === 'open' ? h('span', { class: 'state active' }, 'open') : `closed ${when(night.closedAt)}${night.closedBy ? ` by ${night.closedBy}` : ''}`),
    h('div', { class: 'card' },
      h('p', { style: 'margin-top:0' },
        `${s.findings} finding${s.findings === 1 ? '' : 's'}${severities.length ? ` (${severities.join(', ')})` : ''}, ${s.leases} lease${s.leases === 1 ? '' : 's'}, ${s.runs} run${s.runs === 1 ? '' : 's'} with ${s.failedFlows} failed and ${s.flakyFlows} flaky flow${s.flakyFlows === 1 ? '' : 's'}.`),
      ...report.notes.map((n) => h('p', { class: 'muted' }, n)),
      h('a', { class: 'button', href: linkPath(night.url), download: `night-${night.booking}.md` }, 'Report as Markdown'),
    ),
    h('h2', {}, 'Findings'),
    report.findings.length ? h('div', { class: 'findings' }, report.findings.map(findingCard)) : h('p', { class: 'card muted' }, 'Nothing was reported.'),
    h('h2', {}, 'Runs'),
    night.runs.length
      ? h('div', { class: 'card' }, h('table', {},
          h('tr', {}, h('th', {}, 'Run'), h('th', {}, 'Passed'), h('th', {}, 'Flaky'), h('th', {}, 'Failed'), h('th', {}, 'State')),
          ...night.runs.map((r) => h('tr', {},
            h('td', {}, h('a', { href: linkPath(r.url), 'data-link': true }, r.id.slice(0, 8)),
              ...r.failures.map((f) => h('div', { class: 'muted' }, `${f.flow}: ${f.message ?? 'failed'} `, f.recording ? h('a', { href: linkPath(f.recording), 'data-link': true }, 'Recording') : ''))),
            h('td', {}, r.passed),
            h('td', {}, r.flaky),
            h('td', {}, r.failed),
            h('td', { class: `state ${r.state}` }, r.state),
          ))))
      : h('p', { class: 'card muted' }, 'No runs used this booking.'),
    h('h2', {}, 'Leases'),
    night.leases.length
      ? h('div', { class: 'card' }, h('table', {},
          h('tr', {}, h('th', {}, 'Who'), h('th', {}, 'Device'), h('th', {}, 'From'), h('th', {}, 'To'), h('th', {}, 'Ended'), h('th', {})),
          ...night.leases.map((l) => h('tr', {},
            h('td', {}, l.owner),
            h('td', {}, l.device ?? '', l.image ? h('div', { class: 'muted' }, `image ${l.image}`) : ''),
            h('td', {}, when(l.activatedAt)),
            h('td', {}, when(l.endedAt)),
            h('td', { class: 'muted' }, l.reason ?? (l.endedAt ? '' : 'still active')),
            h('td', {}, l.recording ? h('a', { href: linkPath(l.recording), 'data-link': true }, 'Recording') : ''),
          ))))
      : h('p', { class: 'card muted' }, 'No leases in this night.'),
  );
}

function findingCard(f) {
  const out = h('p', { class: 'muted' });
  const openAgain = h('button', { title: 'Replay the steps on a fresh device with the same image', onclick: async () => {
    openAgain.disabled = true;
    out.textContent = 'Getting a fresh device…';
    try {
      const target = openAgainTarget(await api('POST', `/v1/findings/${f.id}/open-again`));
      if (target) {
        go(target);
        return;
      }
      out.textContent = 'Hangar started it, but did not say where. Look under Devices.';
    } catch (x) {
      out.textContent = openAgainError(x);
    } finally {
      openAgain.disabled = false;
    }
  } }, 'Open again');
  const log = logTail(f.log);
  return h('div', { class: 'card finding' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('h2', { style: 'margin:0' }, h('span', { class: `sev ${f.severity}` }, f.severity), ' ', f.title),
      h('span', { class: 'muted' }, `${f.by} · ${when(f.createdAt)}`)),
    f.device ? h('p', { class: 'muted', style: 'margin:4px 0 0' }, f.device) : '',
    f.description ? h('p', { class: 'description' }, f.description) : '',
    h('div', { class: 'evidence' },
      f.screenshot ? h('a', { href: linkPath(f.screenshot), target: '_blank' }, h('img', { class: 'shot', src: linkPath(f.screenshot), alt: `Screenshot for ${f.title}`, loading: 'lazy' })) : '',
      h('div', {},
        f.video
          ? h('p', { style: 'margin-top:0' },
              h('a', { href: linkPath(f.video.video), target: '_blank' }, `Video from ${seconds(f.video.fromMs)} to ${seconds(f.video.toMs)}`),
              ' · ',
              h('a', { href: linkPath(f.video.url), 'data-link': true }, 'the whole recording'))
          : h('p', { class: 'muted', style: 'margin-top:0' }, 'No video was recording.'),
        h('h3', {}, 'Steps before it'),
        stepList(f.steps),
        h('h3', {}, 'App log'),
        log.length
          ? h('div', { class: 'log' }, log.map((l) => h('div', { class: `step ${l.level === 'error' || l.level === 'fault' ? 'error' : ''}` }, h('span', { class: 'muted' }, new Date(l.time).toLocaleTimeString()), ' ', l.message)))
          : h('p', { class: 'muted' }, f.logError ?? 'The app logged nothing.'),
        ...f.notes.map((n) => h('p', { class: 'muted' }, n)),
        h('div', { class: 'row' }, openAgain),
        out,
      ),
    ),
  );
}
