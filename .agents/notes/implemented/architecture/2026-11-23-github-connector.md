# Agent Note: GitHub uses a local token connector

Status: implemented

## Problem

Barn needed a GitHub connector that lets the Agent work with repositories, issues, and pull requests without introducing a hosted OAuth control plane into a local-first desktop product. The connector also needed a real execution path rather than a catalog-only placeholder.

## Decision

GitHub is a built-in connector backed by the GitHub REST API at `https://api.github.com`. A connection stores a fine-grained personal access token in the operating-system credential store; the token is never exposed to the model or returned by list APIs.

The repository capability set is intentionally bounded but complete enough for inventory work: search repositories, list the connected account's owned repositories including private and fork repositories, read one repository with its language breakdown, search issues and pull requests, list and read repository issues, list and read pull requests, create an issue, and comment on an issue or pull request. Repository search and list operations accept `page` and `perPage`; `includeLanguages` adds exact per-repository language byte/percentage breakdowns. Reads use the existing external-read policy. Issue creation and comments use the existing external-write approval queue.

The Plugins page shows GitHub in the integrations category with its official brand mark. Its configuration form explains the token requirement and links to GitHub's fine-grained token creation page. The adapter uses GitHub API version `2022-11-28`, validates response shapes, normalizes results to bounded summaries, and maps authentication, access, rate-limit, and HTTP failures to safe messages. Repository summaries include visibility, fork/archive state, language, stars, watchers, forks, open issues, topics, license, and timestamps. Fork language gaps are filled from `/repos/{owner}/{repo}/languages` when language enrichment is requested.

## Alternatives considered

**Hosted OAuth through Comma or another control plane.** Rejected because Barn's core experience must remain local-first and must not require a hosted account service to connect a personal GitHub account.

**Embed a GitHub OAuth client secret in the desktop app.** Rejected because a distributed client secret is not secret and would create an unsafe authorization model.

**Use GitHub's remote MCP server.** Deferred because it adds a second authorization/session mechanism before the local connector surface is proven. The REST adapter gives a smaller, auditable first slice.

**Expose only repository search.** Rejected because issue and pull-request reads are the common office workflow and the existing connector approval system already supports safe external writes.

## Consequences

- Users create a fine-grained token with repository metadata, issues, and pull-request access.
- The Agent can discover and use GitHub through the generic `connector_list` and `connector_call` tools.
- Issue creation and comments cannot execute without user approval.
- GitHub Enterprise endpoints, OAuth device flow, code search, and repository file editing remain future work.
