# ChatGPT Supervisor Status for Firefox

This repository contains the Firefox extension source and **Mozilla-signed self-distributed releases**.

- Add-on ID: chatgpt-supervisor-status@lupus.local
- Origin: https://chatgpt.com/
- Local backend: http://127.0.0.1:19431/ (loopback only)
- Distribution: Mozilla Add-ons **unlisted**, not AMO public listing
- Browser update URL: https://raw.githubusercontent.com/Pawel-BoOssko/chatgpt-supervisor-firefox-releases/main/updates.json
- Signed packages: releases/ (published by GitHub Actions)

## Update pipeline

Changes to the six extension files on SATANAMD are detected by the existing 10-minute Autosync. It pushes a commit to branch autosync/SATANAMD-firefox-status without modifying the local checkout. GitHub Actions increments an auto-build version (0.4.N), sends the package to Mozilla for unlisted signing, verifies the signature, and then publishes the signed XPI plus SHA256 update manifest to main. Firefox checks the HTTPS update URL and downloads a signed update automatically.

The AMO API JWT credentials must be configured as repository Actions secrets AMO_API_KEY and AMO_API_SECRET. Never add them to source code, commit history, or update manifests. Repo contains no local production SQLite data or user credentials.

Manual initial installation: use a signed XPI from releases/ or via the Firefox Add-ons Manager. An unsigned XPI works only for temporary developer installation and will disappear on browser restart.
