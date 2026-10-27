# LearnHarness browser port

This branch targets **https://learn.nix.zone**, with public registration and a private learning space for each account. The original desktop documentation is retained below. Current deployment and verification status are tracked in [the port ledger](reports/port-ledger.md).

The port retains the original React interface, teaching and practice agents, prompts, knowledge graph, settings, provider integrations, usage accounting, research, visuals and demos. It uses a curated Next.js standalone runtime. The original website is captured under `public/about-site` for `/about/`, with its screenshots, fonts, diagrams, attribution and a note explaining browser storage. Its manifest records source and served asset hashes.

Each learner runs in a separate unprivileged ARM64 container. Learning records and provider keys live on the VPS in that account's private quota directory. The gateway strips its login cookie and incoming tenant identifiers before proxying. Generated demos retain their opaque iframe sandbox, and system Chromium verifies demos in the private container. Public HTTPS access supports providers and research; sibling containers, host services, private networks and cloud metadata are blocked.

The current VPS allocation supports twelve registered accounts and eight active runtimes. Each account has 96 MiB of persistent storage; each runtime has a 1 GiB memory ceiling. A dedicated 1.5 GiB filesystem reserves tenant storage separately from host headroom. Runtimes suspend after thirty minutes without open requests, only after checking for active turns, jobs, extraction and compaction. Records survive restart.

General settings links to **Learner files** for private notes, PDF and image uploads. Copy the displayed path into a session to let the existing agent tools read the exact file. Uploading alone does not send it to a provider. Limits are 8 MiB per file and 16 MiB per request. Remote ChatGPT sign-in can accept the final loopback redirect URL through the original state, PKCE and nonce verifier; Copilot and Grok retain their device/prompt flows.

### Verification and hosting

The public deployment was verified on 2026-10-27 from commit `27f5c7f89347a4a027d77366fdc04a9187c070a9`. The application suite has 2,346 passing tests; deployment tests add 16. Real-container checks cover quotas, filesystem/network boundaries, Chromium and persistence. Ten public checks cover TLS, independent accounts, streaming, uploads, source availability and logout. Real provider inference and physical Safari/microphone behavior remain unverified. The ledger records each artifact and its limits.

Five authenticated requests from the VPS through Cloudflare measured a 45.5 ms median warm response header time. The home HTML referenced twelve JavaScript files totaling 608,836 bytes with gzip. These are network samples; browser field performance remains unmeasured. The port keeps the original web runtime. Current measurements do not justify replacing the application with WebAssembly.

To use an eligible ChatGPT subscription, open **Settings > Providers > ChatGPT > Connect**, then select ChatGPT models in the model selectors. This uses Sign in with ChatGPT instead of an OpenAI API key. OpenAI documents [plan usage for open-source apps](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt?site_locale=en) and [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms). Its [overview](https://developers.openai.com/siwc/token-sharing-open-source) gives separate guidance for offering plan usage through a remotely hosted service. A completed inference request is still needed to verify this deployment's access.

Run `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`, `node --test deploy/*.test.mjs`, `npm run typecheck` and `npm run lint`. The application suite and deployment tests cover different boundaries. `deploy/verify-isolation.mjs` checks real VPS containers, private records, filesystem/network isolation, quotas, Chromium and restart using disposable QA profiles. Offline checks do not establish live provider sign-in or teaching.

Build on ARM64 with `docker build -f deploy/Dockerfile -t learnharness:<release> .`. The Node base image is pinned; compiler and dependency scratch use BuildKit tmpfs. Keep reviewed releases under `/opt/learnharness/releases/<release>`. Run `deploy/setup-host.sh` as root with the release directory to prepare quota storage, the narrow provisioning helper and tenant network rules. Existing applications and Docker networks are preserved.

Install `/etc/learnharness/gateway.env`, root-owned at mode 0600:

```ini
LH_PUBLIC_ORIGIN=https://learn.nix.zone
LH_GATEWAY_STATE=/var/lib/learnharness-gateway
LH_TENANT_IMAGE=sha256:<verified-image-id>
LH_SOURCE_ARCHIVE=/opt/learnharness/current/source.tar.gz
LH_ABOUT_DIRECTORY=/opt/learnharness/current/public/about-site
LH_MAX_ACCOUNTS=12
LH_MAX_ACTIVE=8
```

Publish the exact committed source with `git archive --format=tar.gz --prefix=learnharness/ HEAD > source.tar.gz` in the release directory. The gateway exposes it at `/source` under AGPL-3.0. Start `learn-gateway.service`, install and validate `deploy/nginx.conf`, then add the hostname to the existing Cloudflare Tunnel and DNS using the `cf` CLI. The gateway listens on loopback port 3310 and Nginx on loopback port 8080. Tenant ports and the Docker socket must remain private.

There is no email password recovery. The owner can stop the gateway, run `deploy/manage-accounts.mjs reset-password <username>` with `LH_GATEWAY_STATE` set and the replacement password on stdin, then restart it. Do not put passwords in command arguments. Recovery revokes old sessions while retaining learning records and provider connections.

For rollback, retain the previous release and image, switch the `current` symlink and gateway image setting back, then restart the gateway. Already running tenants keep their image until quiescent; stopped tenants are recreated from the selected image with the same quota directory. Preserve tenant directories and the quota filesystem during rollback.

---

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/lh_banner_dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/lh_banner_light.png">
    <img src="docs/assets/lh_banner_light.png" alt="LearnHarness" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning.</strong></p>

<p align="center">
  <a href="https://learnharness.ai">Download</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/development.md">Documentation</a> ·
  <a href="https://github.com/amosblomqvist/learnharness/issues">Issues</a>
</p>

LearnHarness uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason. That picture is updated as you learn.

Instead of just giving you an explanation, it uses your answers and thinking to decide what you need next. Teaching builds understanding one reasoning step at a time. Practice makes it usable. A persistent knowledge graph carries it across sessions.

![LearnHarness teaching session](docs/assets/teaching-session.png)

## How it works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on. Your answers, confidence, and thinking show it where to start.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see the plan, and the lesson adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them. The aim is for the goal to feel obviously true, not merely familiar.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first. Problems and hints adapt to your reasoning.

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. This is how the agent gets a detailed picture rather than just a record of right and wrong answers. You can type or use dictation.

The agent can also research questions in the background, create visual explanations, and build interactive demonstrations.

## Knowledge that carries forward

What you are taught accumulates as propositions and reasoning chains: individual claims and the premises that lead to them. The graph shows this structure, with links back to the source sessions. You can also import notes.

Future teaching sessions can read the graph instead of starting from scratch. Practice sessions can draw their material from it. It stores the ideas and their connections, not ratings of your ability.

![LearnHarness knowledge graph](docs/assets/knowledge-graph.png)

## Download and get started

**[Download from learnharness.ai](https://learnharness.ai)** · [GitHub Releases](https://github.com/amosblomqvist/learnharness/releases)

- **macOS (Apple Silicon):** signed and notarized DMG. Drag the app to Applications.
- **Windows (x64):** run the installer. It is currently unsigned; Windows may show an “unknown publisher” or SmartScreen warning.
- **Linux (x64):** make the AppImage executable and open it, or install the Debian/Ubuntu `.deb`.

Add your provider API key and choose your models, then start a session with what you want to understand. LearnHarness supports 30+ provider options, including OpenAI, Anthropic, Google, DeepSeek, and OpenRouter. Optional dictation and web search use separate service keys.

All three platforms support in-app updates.

## Your keys, your data

- **Your keys and models.** No LearnHarness subscription or markup. You pay your providers for usage; a live cost meter shows model costs.
- **Local storage.** Your chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. Local storage does not mean offline processing.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## Development and support

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # deterministic, no LLM, no network
```

See the [development guide](docs/development.md), [architecture](docs/architecture.md), and [desktop release guide](docs/desktop-release.md).

Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/amosblomqvist/learnharness/issues).

## License

[AGPL-3.0](LICENSE)

The app is free and open forever. If we ever charge for anything, it will be for convenience — managed keys, hosting — never for features you can run locally.
