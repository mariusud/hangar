# Brand

## Name and mark

Hangar is where a team keeps its devices, and where each one goes out to whoever needs it and
comes back. The mark is a hangar seen from the front, its arch in two ribs, with one device
inside it lit in amber: the one on lease. Only the device is amber, so the mark never reads as a
yellow arch.

![The Hangar mark](assets/mark.svg)

| File | Use |
|---|---|
| [assets/mark.svg](assets/mark.svg) | on light backgrounds (ink arch) |
| [assets/mark-dark.svg](assets/mark-dark.svg) | on dark backgrounds (light arch) |
| [assets/mark-tile.svg](assets/mark-tile.svg) | favicons and app icons, on an ink tile |

The console has copies in `packages/console/src` and shows the light or dark one with the theme.
Keep clear space around the mark of at least a quarter of its width, and do not outline, rotate
or recolor it. On an amber background, use the tile.

The name is written Hangar in prose and `hangar` as a command. The wordmark is the name set in
the system font at weight 700 with tight letter spacing, next to the mark.

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
tokens and logs. Hangar loads no web fonts, because it makes no calls to the internet.

## Voice

Plain sentences that say what happens. Numbers instead of adjectives: "52 fps", not "blazing
fast". Errors say what happened and what to do next. No exclamation marks, no emoji.

## Images

- [assets/header.svg](assets/header.svg): the README header, rendered to `header.png` with
  headless Chrome at 2x so the fonts look the same everywhere.
- [assets/fleet.gif](assets/fleet.gif): the console's Fleet page during a real run: an agent, a
  Maestro run and a tester holding devices at once. The host's name is replaced in the picture.
