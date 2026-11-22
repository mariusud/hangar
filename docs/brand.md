# Brand

## Name and mark

Devicepool is a pool of devices. Each device goes out on lease to whoever needs it, and comes
back wiped.

The mark is an arch drawn as two ribs, the outer one heavier, with one device standing inside it
in amber: the device that is out on lease. The arch is the pool that holds the devices. Only the
device is amber, so the mark never reads as a yellow arch. The mark was drawn before the project
took the name Devicepool and has not changed.

![The Devicepool mark](assets/mark.svg)

| File | Use |
|---|---|
| [assets/mark.svg](assets/mark.svg) | on light backgrounds (ink arch) |
| [assets/mark-dark.svg](assets/mark-dark.svg) | on dark backgrounds (light arch) |
| [assets/mark-tile.svg](assets/mark-tile.svg) | favicons and app icons, on an ink tile |

The console has copies in `packages/console/src` and shows the light or dark one with the theme.
Keep clear space around the mark of at least a quarter of its width, and do not outline, rotate
or recolor it. On an amber background, use the tile.

The name is written Devicepool in prose, as one word with one capital, and `devicepool` as a
command. The wordmark is the name set in the system font at weight 700 with tight letter spacing,
next to the mark.

## Color

| Name | Hex | Use |
|---|---|---|
| Ink | `#0C0E12` | dark backgrounds, text on amber |
| Panel | `#14171C` | cards and the top bar in dark mode |
| Line | `#262B33` | borders in dark mode |
| Mist | `#9AA3AE` | secondary text in dark mode |
| Paper | `#F7F6F3` | light backgrounds |
| Signal amber | `#F5A524` | the mark, primary buttons, the current page, focus |
| Sky | `#7CC4FA` | a second lease holder, such as CI, in illustrations |
| Mint | `#8BE0A4` | a third lease holder, such as an agent; success in dark mode |

Amber is for fills and the mark. Text in amber on a light background is too faint, so links
there use a darker amber, `#9A5800`. The console's tokens are in
`packages/console/src/style.css`.

## Type

The system UI font (SF Pro on a Mac), and the system monospace font (SF Mono) for commands,
tokens and logs. Devicepool loads no web fonts, because it makes no calls to the internet.

## Message

| | Wording |
|---|---|
| Headline | The open source, self-hosted device farm. |
| Second line | iOS simulators and Android emulators for your team, your CI and your AI agents. |
| One sentence | Devicepool is an open source, self-hosted device farm for iOS simulators and Android emulators, for your team, your CI and your AI agents. |
| Uses | Develop on a device you don't have. Test every pull request. Let AI agents check their own work. Try a build by hand. |

The one sentence appears word for word in the README, in [index.md](index.md) and in `llms.txt`.

The category is "device farm", because that is what people search for: "open source device
farm", "self-hosted device farm". The broker is the name of one component, the process that
hands out leases, and never the name of the category. Simulators and emulators work today.
Physical phones are on the roadmap, so say "next", never "supported", until they ship.

Name Expo only to compare: "an alternative to Expo Simulators". Never put Expo in a product name,
domain or logo, and never suggest that Devicepool comes from Expo. Expo's brand page forbids
both. The README ends with "Devicepool is not affiliated with Expo." The same goes for the other
services on the [alternatives pages](alternatives/index.md): name them to compare, and say on the
page that Devicepool is not affiliated with them.

Lead with open source, self-hosted and the four uses. Leave cost sums out of the pitch, because
readers start arguing about hardware and upkeep instead. Hosted prices stay in
[comparison.md](comparison.md).

## Voice

Plain sentences that say what happens. Numbers instead of adjectives: "52 fps", not "blazing
fast". Errors say what happened and what to do next. No exclamation marks, no emoji.

## Images

- [assets/header.svg](assets/header.svg): the README header, rendered to `header.png` with
  headless Chrome at 2x so the fonts look the same everywhere:
  `chrome --headless --screenshot=header.png --window-size=1280,400 --force-device-scale-factor=2
  header.svg`.
- [assets/how-it-works.gif](assets/how-it-works.gif): Claude tests a sign-in screen, a pull
  request runs 12 Maestro flows on three devices, a developer saves a file, and Devicepool wipes
  each device afterwards. It ends on the name and `devicepool up`. Its source is
  [assets/how-it-works.html](assets/how-it-works.html), recorded from headless Chrome and turned
  into a GIF with ffmpeg.
