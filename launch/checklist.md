# Launch checklist

Manual steps in order. The blocking ones come first: if the name fails the trademark search, everything below changes. Names of files, variables and commands were checked against `packages/devicepool/src`, `packages/broker/src` and `packages/agent/src` on 2026-11-22, with the old names taken from the last commit.

## 1. Blocking: the name

1. Trademark search for "Devicepool" and "Device Pool", classes 9 (software) and 42 (software as a service, hosting).
   - EUIPO: eSearch plus at euipo.europa.eu/eSearch, and TMview at tmdn.org/tmview for national marks.
   - USPTO: Trademark Search at tmsearch.uspto.gov.
   - Search the joined and the two-word spelling. Note the result and the date in `docs/decisions/` if it changes anything.
   - This is a search, not legal clearance. If something close turns up in class 9 or 42, ask a trademark lawyer before going on.
2. Search volume in Google Keyword Planner for "device farm", "ios simulator farm", "self hosted device farm", "remote ios simulator", "device pool". This decides the wording of the repo description and page titles. It does not block the launch.
3. Register a domain. `devicepool.dev`, `devicepool.sh` and `devicepool.io` had no name servers on 2026-11-22. No name servers does not prove a domain is free, so check at a registrar. Do this the same day as the trademark search.
4. Claim the npm name. `npm view devicepool` returned 404 on 2026-11-22, so the unscoped name was free. The packages also use the scope `@devicepool` (`@devicepool/protocol`, `@devicepool/broker`, `@devicepool/agent`, `@devicepool/console`), so create the `devicepool` organization on npm too. You create the account and the organization yourself.

## 2. Repository

5. Commit the rename. The working tree still has it uncommitted.
6. Rename the GitHub repo from `hangar` to `devicepool` (Settings, General). GitHub redirects the old URL. Update the local remote: `git remote set-url origin git@github.com:mariusud/devicepool.git`. Rename the local folder if you want; nothing depends on it.
7. Set the description to: `Devicepool is an open source, self-hosted device farm for iOS simulators and Android emulators, for your team, your CI and your AI agents.`
8. Set the topics: `device-farm`, `ios-simulator`, `android-emulator`, `mcp`, `maestro`, `react-native`, `self-hosted`.
9. Set the website field to the domain or the Pages URL once one exists.
10. Check that the README's first paragraph and the repo description say the same thing. On 2026-11-22 the README said "device broker" and the fixed sentence says "device farm". Other people are editing the README, so check the final text.
11. Add `"description"` to `.claude-plugin/marketplace.json`. `claude plugin validate --strict .` fails without it (see mcp-registry/README.md).

## 3. Migrate the existing install on the Mac mini

Devicepool has no migration code for the old names. A new `devicepool up` on a Mac that ran Hangar starts with an empty database unless you move the files. Steps:

12. Stop and remove the old service with the old CLI, before installing the new one: `hangar up --uninstall` (add `--system` under sudo if you installed the LaunchDaemon). The old label is `dev.hangar.up`: `~/Library/LaunchAgents/dev.hangar.up.plist` or `/Library/LaunchDaemons/dev.hangar.up.plist`. If the old CLI is gone, run `launchctl bootout gui/$(id -u)/dev.hangar.up` and delete the plist.
13. Take a backup: copy `~/.hangar` somewhere else.
14. Move the data folder and the database:

    ```bash
    mv ~/.hangar ~/.devicepool
    mv ~/.devicepool/hangar.db ~/.devicepool/devicepool.db
    ```

    If SQLite left `hangar.db-wal` and `hangar.db-shm` next to it, the broker was not stopped cleanly. Start the old version once more and stop it, then move the files. `client.json` (the CLI's login) and `bin/` keep their names.
15. If the service ran with `HANGAR_HOME` set, the folder is wherever that pointed. The new variable is `DEVICEPOOL_HOME`.
16. Install the new CLI (`npm install -g ./packages/devicepool`) and the service: `devicepool up --install`. The new label is `dev.devicepool.up`.
17. Old simulators. The agent owns simulators whose names start with `devicepool-`. Before the rename the prefix was `hangar-`. The new agent will not clean up the old ones, so delete them by hand: list with `xcrun simctl list devices | grep hangar-` and remove each with `xcrun simctl delete <udid>`. I did not check how device images behave after the prefix change; lease one image after the move and see whether it has to be built again.
18. Existing tokens keep working. Tokens still start with `hgr_` in the new code (`packages/broker/src/auth.ts`), and they are stored in the database you moved. Decide whether the prefix should change before launch; changing it later means users see two prefixes.
19. Replace the environment variables everywhere they are set: CI secrets, shell profiles, the cloud service's config, Kubernetes values. Each `HANGAR_*` name became the same name with `DEVICEPOOL_`:

    | Old | New | Where it is usually set |
    |---|---|---|
    | `HANGAR_URL` | `DEVICEPOOL_URL` | CI secrets, agent environments, the Claude Code plugin |
    | `HANGAR_TOKEN` | `DEVICEPOOL_TOKEN` | CI secrets, agent environments, the Claude Code plugin |
    | `HANGAR_HOME` | `DEVICEPOOL_HOME` | the Mac, service environment |
    | `HANGAR_LEASE` | `DEVICEPOOL_LEASE` | scripts that run on an existing lease |
    | `HANGAR_TIME_ZONE` | `DEVICEPOOL_TIME_ZONE` | the broker |
    | `HANGAR_OIDC_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_GROUPS`, `_ONLY` | `DEVICEPOOL_OIDC_*` | the broker |
    | `HANGAR_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY`, `_SECRET_KEY` | `DEVICEPOOL_S3_*` | the broker |
    | `HANGAR_HOST_TOKEN` | `DEVICEPOOL_HOST_TOKEN` | a joining Mac |
    | `HANGAR_REQUIRE_SMOKE`, `HANGAR_VERSIONS`, `HANGAR_SIM_PREFIX` | `DEVICEPOOL_*` | the Mac |
    | `HANGAR_NO_OPEN`, `HANGAR_CAPTURE`, `HANGAR_REAL`, `HANGAR_COMMENT_FILE`, `HANGAR_COMMENT_KEY` | `DEVICEPOOL_*` | tests and the GitHub Action's own steps |

    `HANGAR_SMOKE_APP` is now `DEVICEPOOL_SMOKE_APP` (`bench/smoke.ts`).
20. In workflows, change `uses: mariusud/hangar@...` to `uses: mariusud/devicepool@...` and the secrets to `secrets.DEVICEPOOL_URL` and `secrets.DEVICEPOOL_TOKEN`. In MCP client configs, the server was named `hangar`; `devicepool connect claude` adds it again under the new name. Remove the old entry with `claude mcp remove hangar`.
21. Verify: `devicepool doctor`, open the console, take one lease, and check that people, teams and recordings from before are there.

## 4. Publish

22. npm. The package is built by `pnpm build:npm` into `dist/npm` (decision 0014). It was installed from its tarball and run with `--help`, `doctor` and `broker`; `devicepool up` from the installed build has not been run, so do that once on a Mac with no other Devicepool running before you publish.
    - Bump `version` in `packages/devicepool/package.json`, then `pnpm check` and `pnpm build:npm`.
    - `npm pack ./dist/npm --dry-run` and read the file list.
    - `npm login`, then `npm publish ./dist/npm`. `packages/devicepool/package.json` stays private on purpose so the `.ts` sources cannot be published by mistake.
    - After publishing, change the Start block in README.md and docs/index.md to `npm install -g devicepool`, and replace the body of `install_devicepool` in action.yml with the same line.
    - Add `"mcpName": "io.github.mariusud/devicepool"` if you want the MCP Registry listing.
    - Release gate 1 in ROADMAP.md names `npx devicepool up` tested by someone new. Decide whether launch waits for the gates or goes out as "early, install from git". Every launch text in this folder says "not on npm yet"; change them if you publish first.
23. Tag the release and write GitHub release notes from CHANGELOG.md. Move the `v1` tag only if you want `uses: mariusud/devicepool@v1` to work; the guides use `@main` today.
24. GitHub Marketplace for the Action. `action.yml` is at the repo root with a name, description and branding. On the release page, tick "Publish this Action to the GitHub Marketplace", accept the Marketplace developer agreement yourself, and pick categories (Testing, Continuous integration). The action name "Devicepool Maestro" must be unique on the Marketplace. GitHub's docs have had rules about what else an action's repository may contain; read the current "Publishing actions in GitHub Marketplace" page before the release, because this repo holds much more than the action.
25. GitHub Pages. There is no `docs/index.html` and no Pages workflow in the repo. Choose a source (Settings, Pages): the `docs/` folder on `main` renders the Markdown with Jekyll, with `docs/design.md` and the guides as they are. Add an index page first, or the site root is a 404. Point the domain at it if you registered one.
26. Claude Code plugin and MCP Registry: follow mcp-registry/README.md. The registry step needs npm first.

## 5. Before launch day

27. Fill in the placeholders in show-hn.md, post.md, reddit.md and newsletters.md (why you built it, AI involvement, your name). Rewrite the Hacker News comment in your own words; HN's guidelines forbid generated or AI-edited text.
28. Publish post.md where your blog lives. If you have no blog, GitHub Pages from step 25 can hold it.
29. Recheck the numbers in every text against docs/numbers.md, and the comparison claims against docs/comparison.md. Other people are editing both.
30. On a clean Mac, run the three install lines from the README and confirm `devicepool up` prints a link that works. Launch readers will do exactly this.
31. Turn on GitHub Discussions or decide that issues are the only channel. Add issue templates if you want structured bug reports.
32. Open each subreddit's rules page in a browser and compare with the notes in reddit.md. I could not read them directly.

## 6. Launch week

Times are suggestions. Be at the keyboard for four hours after each post.

| Day | Post | Notes |
|---|---|---|
| Monday | Publish the blog post. Send both newsletter emails. | Newsletters need lead time, so these go first. |
| Tuesday | Show HN, in the morning US Eastern time. | Link to the repo. Post your comment right after. Do not ask anyone to upvote or comment; the Show HN rules forbid it. |
| Wednesday | r/reactnative | Standalone post or Show Your Work Thread, depending on the sidebar. |
| Thursday | Submit listings that qualify today: awesome-testing, awesome-mac, mcpservers.org, mcp.so, AlternativeTo. Try the Glama listing. | One pull request per list. See listings.md. |
| Friday | r/selfhosted, as a comment in the New Project Megathread posted that day. | State AI involvement. |
| Saturday | r/iOSProgramming | Saturday covers the App Saturday rule if the moderators apply it to tools. |
| Sunday or the next showcase thread | r/androiddev, as a comment in the showcase thread. | Skip if no thread is open. |
| Following week | punkpeye/awesome-mcp-servers once Glama passes. awesome-react-native if there is adoption to show. awesome-claude-code issue form, filed by you. | |
| 2027-03-15 or later | awesome-selfhosted, written by you. | Four months after v0.1.0. |

## 7. What to watch and answer

- Hacker News thread: answer every question in the first hours, in your own words. Expect the Apple license question, "how is this different from Simlock or Tapflow" (answer only from docs/comparison.md, with no speed claims), "why Macs only", and "was this written by AI". If someone corrects a claim about another tool, thank them, check the source, and fix docs/comparison.md the same day.
- GitHub issues: install failures first. The most likely ones are idb companion install (Homebrew refusing it, which `devicepool doctor` explains), Xcode versions other than 26.6, and Macs with little memory.
- Anything that looks like a security report: point to SECURITY.md and move it out of the public thread.
- Stars, clones and referrers under Insights, Traffic. GitHub keeps 14 days, so write the numbers down on days 1, 3, 7 and 14.
- npm downloads, if published.
- Mentions of physical phones: the answer is "not supported yet, on the roadmap". Do not give a date.
- Questions about Expo: Devicepool is not affiliated with Expo. Compare only with what docs/comparison.md says.
- Benchmarks people post from their own Macs: ask for the `pnpm bench:stream` output and the hardware, and add them to docs/numbers.md only if you can reproduce them.
- At the end of the week, write down what broke for new users and put it in ROADMAP.md.
