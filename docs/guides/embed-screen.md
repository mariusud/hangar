# Put a live device screen in your own app

A support tool, an internal dashboard or a chat bot can show a leased device and take taps on
it. The browser usually can't reach the broker, and it should never hold a Devicepool token, so
your server passes the stream on and adds the token itself.

## The server

`proxyStream` from the `devicepool` client library forwards a WebSocket upgrade to the lease's
stream and adds the token as an `Authorization` header. Frames and input go through unchanged.

```ts
import { createServer } from 'node:http';
import { proxyStream } from 'devicepool';

const server = createServer(app);
server.on('upgrade', (req, socket, head) => {
  const leaseId = leaseForThisUser(req);
  if (!leaseId) {
    socket.destroy();
    return;
  }
  proxyStream(req, socket, head, { url: process.env.DEVICEPOOL_URL, token: process.env.DEVICEPOOL_TOKEN, leaseId });
});
```

Check who the browser is before you call it: anyone who reaches the socket can tap on the
device. `codec` is `h264` by default; pass `codec: 'jpeg'` for browsers without WebCodecs
(`VideoDecoder` needs HTTPS or localhost).

## The page

The broker serves the console's viewer as one file at `/screen.js`. Copy it next to your page,
or serve it through your server, and use the `<devicepool-screen>` element:

```html
<script type="module" src="/screen.js"></script>
<devicepool-screen src="/device-stream" style="width: 320px; aspect-ratio: 402 / 874"></devicepool-screen>
```

`src` is your server's socket path. A path or `http(s)` URL is turned into `ws(s)`, and the
codec the browser can decode is added as `?codec=`. A click is a tap, a drag is a swipe, and
typed keys go to the device once the element has focus. The element fires `status` events
("Connecting…", "The lease ended.") and `error` events, each with the text in `detail`. Its
`send(message)` method sends other input, such as `{ "type": "button", "button": "home" }`.

To build your own view instead, `mountScreen(element, wsUrl)` from the same file draws into any
element and returns `{ send, close }`.

## The socket

`/v1/leases/:id/stream?codec=h264|jpeg` takes the token as `?token=`, a session cookie or an
`Authorization: Bearer` header.

- Each binary message starts with one type byte: 1 is a JPEG frame, 2 is an H.264 record. An
  H.264 record is 1 flag byte (bit 0 set on a keyframe), the capture time as a float64 in
  seconds, the width and height as uint16, then Annex B data.
- Text messages from the broker are JSON. `{ "type": "error", "message": "..." }` reports input
  that failed.
- Input is JSON text: `tap` with `point: [x, y]`, `swipe` with `from`, `to` and `durationMs`,
  `type` with `text`, `key` with `key` and optional `modifiers`, `button` with `button`, and
  `keyframe` to ask for a new keyframe after a decode error. Points are fractions of the screen,
  from 0 to 1.
- The broker closes the socket with code 4000 when the lease ends.
