# MCP registry and Claude Code plugin listing

Read on 2026-11-22 from modelcontextprotocol.io/registry (quickstart, remote servers, package types), the registry's `server.json` schema dated 2025-12-11, and code.claude.com/docs (create a marketplace, publish a plugin). The MCP Registry is marked as a preview, so recheck before publishing.

## Short answer

- Official MCP Registry: Devicepool cannot be listed today. It can be listed as an npm package entry once `devicepool` is on npm. It cannot be listed as a remote server at all, because there is no public endpoint.
- Claude Code, your own marketplace: this already works from the repo once the repo is public under `mariusud/devicepool`. Nothing to submit.
- Anthropic's plugin directory: can be submitted from a paid claude.ai plan. The local validator reports two missing items (an icon and a privacy policy URL), and I could not confirm that a plugin whose MCP server lives on the user's own network works for people on claude.ai.

## Official MCP Registry

### Why it does not fit as a remote server

The registry takes two kinds of entry. A `remotes` entry is a URL, and the docs say a remote server must be publicly accessible at that URL. Devicepool's MCP endpoint is `/mcp` on each user's own broker, usually on a private network, with a token that broker made. There is no public URL to list. The schema allows `{variables}` in a remote URL for multi-tenant hosts such as `https://{tenant}.example.com/mcp`, but the URL must still start with `http://` or `https://` and point at something public. A template that is only the user's own host does not meet that rule.

Listing a remote would become possible only if a public Devicepool endpoint existed. The project does not offer hosted Macs and does not plan to (docs/licensing.md), so do not plan on this.

### How it can fit: an npm package entry

A `packages` entry points at a package on the public npm registry. Its transport may be `streamable-http` with a local URL, which describes a package that serves MCP over HTTP once it runs. That is what `devicepool up` does: it serves `/mcp` on port 7420.

`server.json` in this folder is written that way. It validates as JSON and follows the 2025-12-11 schema as I read it. I did not run `mcp-publisher validate` on it. It is true only after these exist:

1. `devicepool` version 0.1.0 (or later, with both `version` fields changed to match) is published on the public npm registry. Today `packages/devicepool/package.json` has `"private": true`, depends on three `workspace:*` packages, and its `bin` is a `.ts` file. See checklist.md for what has to change before `npm publish` works.
2. That `package.json` carries `"mcpName": "io.github.mariusud/devicepool"`. The registry reads this from the published package to verify ownership. It must equal `name` in `server.json`.
3. The GitHub account `mariusud` is the one that logs in to publish, because the `io.github.mariusud/` namespace is tied to it.

Limits to be honest about in the listing:

- A registry client that installs this entry runs `devicepool up`, which turns the Mac into a device pool. It needs macOS, Xcode and idb. The schema has no field for operating system requirements, so the description has to carry it. The current 92-character description does not say macOS; the limit is 100 characters.
- The token in the `Authorization` header is made by the running broker (`devicepool connect`), so a client cannot fill it in before the first run.
- A user whose broker is on another Mac does not need the package at all. They add the URL of their own broker to their client, as docs/guides/agents.md describes. The registry entry does not cover that case.

### Steps, after npm publish

```bash
brew install mcp-publisher
cp launch/mcp-registry/server.json ./server.json   # the registry expects it at the repo root
mcp-publisher validate
mcp-publisher login github      # opens github.com/login/device; you enter the code yourself
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.mariusud/devicepool"
```

PulseMCP has paused its own submissions and says it will pick servers up from this registry. mcpservers.org's form has an optional field for the registry name.

## Glama

punkpeye/awesome-mcp-servers in practice requires a Glama listing first (see listings.md). Glama lists a server from its GitHub repo through the "Add Server" button at glama.ai/mcp/servers, builds it in Docker, and checks that it starts and answers introspection. The repo's `Dockerfile` builds the broker alone, and the broker serves `/mcp`. Whether Glama accepts an HTTP server that needs a bearer token for introspection is not confirmed. Try it; if the check fails, the awesome-mcp-servers entry waits.

## Claude Code plugin

### Your own marketplace (works now)

The repo already has `.claude-plugin/marketplace.json` listing `./plugins/devicepool`, and the plugin has `.claude-plugin/plugin.json` and `.mcp.json`. When the repo is public as `mariusud/devicepool`, users run either:

```bash
claude plugin marketplace add mariusud/devicepool
claude plugin install devicepool@devicepool
```

or, inside a session, on Claude Code v2.1.275 or later:

```
/plugin install devicepool --marketplace mariusud/devicepool
```

with `DEVICEPOOL_URL` and `DEVICEPOOL_TOKEN` set in the environment. The README and docs/guides/agents.md use the second form, so they need the version note or the two-command form for older clients.

I ran the validator on 2026-11-22:

- `claude plugin validate --strict .` fails on one warning: the marketplace has no `description`. Without `--strict` it passes. Fix: add a top-level `"description"` to `.claude-plugin/marketplace.json`.
- `claude plugin validate --strict ./plugins/devicepool` passes.
- The marketplace name is `devicepool`. A user cannot have two marketplaces with the same name, and the docs advise a name others are unlikely to pick. `devicepool` is fine as long as nobody else publishes one.
- `plugin.json` sets `version` to `0.1.0`. If you push plugin changes without raising it, `claude plugin update` tells users they are already up to date. Raise it on each release or remove the field so the commit SHA is used.

### Anthropic's directory (claude.ai/directory)

- Anthropic's official marketplace, `claude-plugins-official`, does not take submissions through the portal.
- The public directory does. You submit from the developer portal at claude.ai/directory/manage. It needs a paid claude.ai plan and a GitHub repository holding the plugin.
- The validator's directory checks reported two gaps for `plugins/devicepool`:
  - No icon. Add a square PNG, 512 to 2048 px a side and under 2 MB, at `plugins/devicepool/.claude-plugin/icon.png`. The validator says the icon is taken the first time the plugin is saved in the portal and later changes do not replace it, so get it right first. docs/assets/mark-tile.svg is the brand's tile; it has to be rendered to PNG.
  - No privacy policy URL. The check applies because the plugin connects to a remote MCP server. Set `privacyPolicyUrl` in `plugin.json`. No privacy policy page exists yet. A short page saying the plugin talks only to the Devicepool the user configures and that Devicepool sends no telemetry would be true to AGENTS.md.
- The plugin folder has no `README.md` of its own; the validator fell back to the repo's.
- The portal runs a safety scan and a policy review that the local command does not.
- Open question I could not settle: people who add a directory plugin on claude.ai or Cowork get it synced to their account. This plugin's only component is an MCP server at `${DEVICEPOOL_URL}/mcp`, read from the environment and normally on a private network. That works in Claude Code on a machine that can reach the broker. It probably does nothing on claude.ai. Check the component support table linked from the publishing docs (claude.com/docs/plugins/platform-support) before submitting, and say in the listing that it needs your own Devicepool on a Mac.

### What would have to exist first, in order

1. Public repo at `mariusud/devicepool`.
2. `description` in the marketplace file.
3. For the directory: icon PNG, privacy policy page and `privacyPolicyUrl`, a plugin README.
4. For the MCP Registry: the npm package with `mcpName`.
