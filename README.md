# ChatGPT Supervisor Status for Firefox

This repository contains the Firefox extension source and **Mozilla-signed self-distributed releases**.

- Add-on ID: chatgpt-supervisor-status@lupus.local
- Origin: https://chatgpt.com/
- Local backend: http://127.0.0.1:19431/ (loopback only)
- Distribution: Mozilla Add-ons **unlisted**, not AMO public listing
- Browser update URL: https://raw.githubusercontent.com/Pawel-BoOssko/chatgpt-supervisor-firefox-releases/main/updates.json
- Signed packages: releases/ (published by GitHub Actions)

## Imeno and Neo4j integration (v0.4.0)

- The ChatGPT sidebar uses Imeno for custom displayed titles; it does not rename the native conversation.
- important=1 is shown with a thin gold line and a filled star. Toggle (null/0->1 or 1->0) is only a user action; the central Nadzor importer can initialize null->1 but cannot override a manual 0.
- Working-folder activity data is displayed only for important=1 and comes from the central 5-minute Imeno scanner, not a second browser-owned scanner.
- Browser observations (UUID, native title, candidate MCP_NICK declared in assistant messages) are sent through the local Python bridge. CandidateMCPNick is not a verified identity.
- Profile edits and reads are forwarded by the Python bridge to the central Imeno API with optimistic concurrency.
- Temporary technical decision: browser observations currently use a parameterized local Neo4j transaction because the central API lacks an observation endpoint. See the TODO in graph_adapter.py (outside this repository).
- ChatGPT skill to establish MCP_NICK: private plugin at https://chatgpt.com/plugins/plugins_6af835006ae481919ed2b29d65c07e0f.
- The Windows bridge lives at D:\projects\firefox-chatgpt-supervisor-status\bridge\status_bridge.py. Backend files are deployed separately from the Firefox add-on.

## Update pipeline

Changes to the six extension files on SATANAMD are detected by the existing 10-minute Autosync. It pushes a commit to branch autosync/SATANAMD-firefox-status without modifying the local checkout. GitHub Actions increments an auto-build version (0.4.N), sends the package to Mozilla for unlisted signing, verifies the signature, and then publishes the signed XPI plus SHA256 update manifest to main. Firefox checks the HTTPS update URL and downloads a signed update automatically.

The AMO API JWT credentials must be configured as repository Actions secrets AMO_API_KEY and AMO_API_SECRET. Never add them to source code, commit history, or update manifests. Repo contains no local production SQLite data or user credentials.

Manual initial installation: use a signed XPI from releases/ or via the Firefox Add-ons Manager. An unsigned XPI works only for temporary developer installation and will disappear on browser restart.

## Sidebar search and bulk actions (v0.5.1)

- A live search field at the top of the ChatGPT sidebar filters only the currently rendered sidebar conversations, matching native title and imeno (case/accent insensitive). Archived records retained in Neo4j are not injected into the active sidebar.
- Selection is keyed by conversation UUID and persists across filter changes and sidebar DOM rerenders. Buttons select visible, deselect visible, or clear the complete selection.
- Bulk important=1/0 uses central Imeno API through the localhost bridge with per-chat optimistic concurrency and error reporting.
- Bulk open uses Firefox browser.tabs.create through the extension background script, with a maximum of 40 unique validated UUIDs per action.
- Bulk archive uses the native ChatGPT sidebar menu, with explicit confirmation. It reports attempted menu clicks, not backend-confirmed archival. Unavailable menu options are reported as failures.
- Source verification: Mozilla web-ext lint 0 errors/0 warnings, JavaScript syntax checks, Neo4j mock tests, and jsdom DOM test for filtering and persistent selection.
- The signing workflow is triggered on main and autosync branch changes. Without AMO_API_KEY and AMO_API_SECRET GitHub Actions reports success but skips Mozilla signing and XPI publication. A successful workflow alone is not proof of a signed release.


<!-- IMENO-POLECENIE-PAWLA-MCP-2026-11-16 -->
Instrukcja dla programistów dotycząca przyszłej migracji MCP/IMENO: [POLECENIE_PAWLA_IMENO_MCP.md](POLECENIE_PAWLA_IMENO_MCP.md). Dotyczy wyłącznie prac po uzgodnieniu z Pawłem; bez zmian obecnego działania.
