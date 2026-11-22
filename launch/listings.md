# Listings

Rules were read on 2026-11-22 from each list's own repository or site. The project's state on that date: first commit 2026-11-06, tag v0.1.0 on 2026-11-15, not on npm, close to zero stars. Two lists forbid entries written by a machine; for those this file gives the rules and leaves the text to you.

## Summary

| List | Qualifies today | What is in the way |
|---|---|---|
| TheJambo/awesome-testing | Yes | Nothing |
| jaywcjlove/awesome-mac | Yes | Entry must be added to four README files |
| mcpservers.org (wong2's list) | Yes | Web form, review within 2 weeks |
| mcp.so | Probably | Rules not checked |
| AlternativeTo | Probably | Long free review queue; "released" is easier to show after npm publish |
| punkpeye/awesome-mcp-servers | Not yet | Needs a Glama listing that passes Glama's checks first |
| jondot/awesome-react-native | On paper, in practice no | "Real adoption" bar; no pull request merged since 2021 |
| awesome-selfhosted | No | First release must be more than 4 months old: earliest 2027-03-15. Entry must be written by a human |
| hesreallyhim/awesome-claude-code | Not yet | 14 days since first commit (met on 2026-11-20) and signs of activity, or 100 stars; a human must file the issue |
| PulseMCP | No | Submissions are paused; it says it will read the official MCP Registry |
| appcypher/awesome-mcp-servers | No | Repository is archived |

## TheJambo/awesome-testing

- Where Tapflow is listed. https://github.com/TheJambo/awesome-testing
- Target: `README.md`, section `### UI & End-to-End Testing`.
- Rules: one pull request per suggestion, description ends with a period. No star or age rule.
- Entry:

```markdown
- [Devicepool](https://github.com/mariusud/devicepool) - Self-hosted device farm that lends fresh iOS simulators and Android emulators to people, CI and AI agents, with sharded Maestro runs and JUnit reports.
```

## jaywcjlove/awesome-mac

- Where Tapflow is listed. https://github.com/jaywcjlove/awesome-mac
- Target: section `### Developer Utilities`, alphabetical within the section, in `README.md`, `README-zh.md`, `README-ja.md` and `README-ko.md`. All four must be kept in sync, so the description needs a Chinese, Japanese and Korean version. The contribution guide says AI-assisted contributions are welcome.
- No star or age rule.
- Entry (English). The list's own icon references mark it as open source and free:

```markdown
* [Devicepool](https://github.com/mariusud/devicepool) - Self-hosted device farm for iOS simulators and Android emulators on Macs you own, for a team, CI and AI agents. [![Open-Source Software][OSS Icon]](https://github.com/mariusud/devicepool) ![Freeware][Freeware Icon]
```

## punkpeye/awesome-mcp-servers

- Where mobile-mcp is listed. https://github.com/punkpeye/awesome-mcp-servers
- Target: `README.md`, section `### 💻 Developer Tools` (mobile-mcp and the simulator servers are there; the list has no mobile section). The guide asks for alphabetical order within the section.
- Format, checked by a bot: link text must be `owner/repo`, the URL must be on github.com, and the entry needs at least one emoji from the list's legend. For Devicepool: TypeScript, runs locally, macOS.
- Rule that blocks it today: the bot asks for a listing on glama.ai/mcp/servers that passes Glama's checks, and for Glama's score badge in the entry. Since 2026-09-01, 1718 merged pull requests had the `has-glama` label and 6 had `missing-glama`. Glama builds and starts the server in its own Docker container and needs it to answer introspection requests. Devicepool's MCP endpoint is part of the broker, and the broker does run alone in Docker (`Dockerfile` in the repo), so this may pass without any simulator. I could not confirm that. Try the Glama listing first (see mcp-registry/README.md).
- The list has 5140 open pull requests. Expect a wait.
- Entry, with the badge to add once Glama gives one:

```markdown
- [mariusud/devicepool](https://github.com/mariusud/devicepool) 📇 🏠 🍎 - Self-hosted device farm for iOS simulators and Android emulators. Each MCP session leases its own fresh device, with mobile-mcp's tool names.
```

## mcpservers.org (wong2/awesome-mcp-servers)

- wong2's README says it takes no pull requests and points to https://mcpservers.org/submit.
- The form asks for: name, category, short description, repository or website, optional official MCP Registry name, a "remote" checkbox, and a contact email. Free review within 2 weeks. A paid option exists; it is not needed.
- Values:
  - Name: `Devicepool`
  - Category: the closest to developer tools or mobile in the form's list
  - Description: `Self-hosted device farm for iOS simulators and Android emulators. Each MCP session leases its own fresh device from your own Macs. Uses mobile-mcp's tool names.`
  - Link: `https://github.com/mariusud/devicepool`
  - Remote: no. The server runs on the user's own Mac.

## mcp.so

- mobile-mcp is listed there with the tag "mobile". Submission is through the site. I did not read its rules. Use the same name, description and link as for mcpservers.org.

## AlternativeTo

- Tapflow and Maestro have pages there.
- How: an account with a verified email, then the user menu, "Suggest new application". Fill in platforms, license, description and tags. The description may not contain links or contact details. Apps must be released; "coming soon" and closed betas are rejected. The free review queue holds several thousand apps with no promised date. A paid priority review exists and does not buy approval.
- Do this after the npm publish, so "released" is not in question.
- Fields:
  - Name: `Devicepool`
  - Platforms: Mac, Self-Hosted
  - License: Open Source (Apache-2.0), Free
  - Tags: device farm, ios simulator, android emulator, mobile testing, test automation, mcp server
  - Description:

    ```
    Devicepool is an open source, self-hosted device farm for iOS simulators and Android emulators, for your team, your CI and your AI agents. It runs on Macs you own. A person, a CI job or an agent takes a lease on a device, uses it in the browser, over an API or over MCP, and gives it back. Devicepool then deletes the device and clones a fresh one. It splits Maestro flows over several devices and writes one JUnit report with a video of each failed flow. It sends no telemetry. Physical phones are not supported.
    ```
- After approval, suggest it as an alternative on these existing pages (the page's "Contribute to this page", then "Suggest Alternatives"): Appetize.io, BrowserStack, Maestro, Sauce Labs, Genymotion, tapflow, DeviceLab. AWS Device Farm and Firebase Test Lab have no page.

## jondot/awesome-react-native

- Where mobile-mcp is listed. https://github.com/jondot/awesome-react-native
- Target: `README.md`, `## AI-Assisted Development`, `### MCP Servers` (mobile-mcp and Maestro are there). Second choice: `## Development Tools`, `### Testing`.
- Format from the guide: `[NAME](LINK) - Description.`, short, ending with a period. One pull request per suggestion. No ordering rule; append.
- Rules that matter: the project must be actively maintained, and libraries "should have real adoption or be exceptionally novel"; your own project is welcome but must clear the same bar.
- State of the list: the owner rebuilt it by direct commit on 2026-08-26. The last merged pull request is from 2021-04-25, and 59 are open, including one for Argent from November 2026. A pull request here is unlikely to be merged. Send it late in the week, once there are stars to point to, or skip it.
- Entry:

```markdown
- [Devicepool](https://github.com/mariusud/devicepool) - Self-hosted device farm for iOS simulators and Android emulators, with an MCP endpoint, sharded Maestro runs and Fast Refresh on leased devices.
```

## awesome-selfhosted

- Submissions go to https://github.com/awesome-selfhosted/awesome-selfhosted-data as one file, `software/devicepool.yml`, one project per pull request.
- Devicepool does not qualify yet. The rule: the project must have been first released more than 4 months ago, counted from the first tagged release. v0.1.0 is dated 2026-11-15, so the earliest date is 2027-03-15. It must also be actively maintained and have working installation instructions.
- I have not written the entry. The contribution guide says machine or LLM generated contributions are not allowed and lead to a ban, the pull request template has a checkbox that a human made the submission, and the guide carries a note asking AI agents not to write entry text for a person to submit. Write the YAML and the pull request text yourself in March.
- What you will need to know when you do:
  - Fields: `name`, `website_url`, `source_code_url`, `description`, `licenses`, `platforms`, `tags`. Optional: `depends_3rdparty`, `demo_url`, `related_software_url`, `icon_url`.
  - The description must be under 250 characters, in sentence case, without the words open-source, free or self-hosted, and may end with "(alternative to X, Y)".
  - License value: `Apache-2.0`.
  - Platform values are runtimes, not operating systems: `Nodejs`. Add `Docker` only if it is required to run.
  - Fitting tag: `Software Development - Testing`. Only the first tag shows in the single-page list.
  - Open question to raise in the pull request yourself: the guide does not say whether software that needs macOS hosts is accepted.

## hesreallyhim/awesome-claude-code

- None of the comparable tools is listed there, but the Claude Code plugin would fit.
- Rules: submissions are by issue form only, not by pull request and not through the `gh` CLI. The resource must be at least 14 days old counted from the first commit on the default branch and show active development, or have at least 100 stars. Recommendations must be made by a human. One resource at a time.
- First commit was 2026-11-06, so the age rule is met from 2026-11-20. Fill in the issue form yourself. I have not drafted it.

## Official MCP Registry, Glama, Claude plugin directory

See mcp-registry/README.md. mobile-mcp and Argent are both in the official MCP Registry, and mobile-mcp is on Glama.

## Other places the comparable tools appear

- up-for-grabs.net lists Tapflow. Entry is a pull request adding `_data/projects/devicepool.yml`, and the project needs open issues with a label for newcomers. Devicepool has no such issues yet. Not ready.
- Product Hunt: Tapflow launched there. A Product Hunt launch needs an account and a scheduled launch; it is not in this week's plan.
- awesome.ecosyste.ms and trackawesomelist index other lists automatically. Nothing to submit.
- stefanofa/awesome lists Simlock, Tapflow, Argent and serve-sim. It is one person's starred repositories. Nothing to submit.
- GADS appears only in auto-generated lists. Nothing worth submitting to.
- Checked, with none of the comparable tools listed: SrinivasanTarget/awesome-appium, atinfo/awesome-test-automation, vsouza/awesome-ios, JStumpp/awesome-android, awesome-foss/awesome-sysadmin, ComposioHQ/awesome-claude-plugins, ligurio/awesome-ci. awesome-appium has a device farm area, but Devicepool has no Appium endpoint, so it does not belong there.
- OpenAlternative and selfh.st: I could not read their submission rules.
