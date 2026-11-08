# Brand

## Name and mark

Hangar is where a team keeps its devices, and where each one goes out to whoever needs it and
comes back. The mark is that: an arch with one device inside.

![The Hangar mark](assets/mark.svg)

The mark is [assets/mark.svg](assets/mark.svg), in amber on any background. It also serves as
the console's favicon (`packages/console/src/mark.svg`, a copy). Keep the clear space around it at
least a quarter of its width, and do not outline, rotate or recolor it.

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

- [assets/header.svg](assets/header.svg): the README header. Six devices under the arch, three
  of them leased to a developer, CI and an agent. Render it to `header.png` with headless
  Chrome at 2x (the README shows the PNG, so the fonts look the same everywhere).
- Screenshots of the console are taken from a real `hangar up`, with the host's name replaced.
