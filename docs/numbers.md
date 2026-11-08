# Numbers

From `pnpm bench:stream` on an M4 Pro with Xcode 26.6 and an iPhone 17 simulator at 1206 by
2622, through the real broker and agent ([baseline](../bench/stream.baseline.json)). The targets
are in [the design](design.md#targets).

| | H.264 (HTTPS, localhost) | JPEG (plain-HTTP LAN) | Target |
|---|---|---|---|
| Frame rate during motion | 52 fps | 38 fps | 60 fps |
| Capture to client | 10.7 ms p50, 28.9 ms p95 | not measured | |
| Input to first changed frame | 109 ms p50, 197 ms p95 | 137 ms p50, 443 ms p95 | p95 under 80 ms |
| Bandwidth during motion | 509 KB/s | 1168 KB/s | |
| Fast Refresh, save to first frame on the leased device (`bench:metro`) | 87 ms p50, 163 ms p95 | | under 1 s |

Decoding in the browser adds about 2 ms (3 ms p95). The input p95 is not met, but most of it is
iOS, not Hangar: in a trace, the viewer's swipe reached the simulator's HID input in 1 to 7 ms,
and the rest went to iOS recognizing a scroll that starts on a table row. The JPEG fallback went
from 6 to 38 fps when screenshots started coming from the display (decision 0010). Comparisons
with other tools on the same hardware will be added here when they are measured.

Device calls on the same Mac, 10 calls each on a booted simulator, before and after they went
straight to the idb companion's gRPC (decision 0010):

| | Before | After |
|---|---|---|
| Element tree | 303 ms median | 3 to 5 ms median |
| PNG screenshot | 302 ms | 91 ms |
| JPEG screenshot, 800 px | 594 ms | 39 ms, from the display's IOSurface |
| Tap at a point | 4 ms | 2 to 10 ms |
