# HII Helium Sync

A local-first Manifest V3 extension for Helium and Chrome. It synchronizes bookmarks, recent browser history, optional open-tab metadata, and an extension-owned encrypted password vault through the local HII API.

## Install and pair

1. Start the local HII web runtime on `127.0.0.1:3000`.
2. Open `chrome://extensions` in Helium and Chrome, enable Developer mode, choose **Load unpacked**, and select this directory.
3. Open Options in both browsers. Use the same random sync key (20+ characters), label each browser, and save.
4. Click **Sync now** in each browser. HII stores records at `~/.hii/browser-sync/` under a SHA-256-derived filename.

## Password boundary

Chromium extension APIs do not expose browser-native saved passwords. To migrate Chrome passwords, export a Chrome-compatible CSV, import it on the Options page, verify the encrypted vault, and securely delete the plaintext CSV. Vault entries use PBKDF2-SHA256 (310,000 iterations) and AES-256-GCM before leaving the extension. The master password is never persisted; unlocked values use `chrome.storage.session` and disappear when the browser session ends.

This is an early local tool, not a security-audited replacement for Bitwarden, 1Password, or Proton Pass. Keep Chrome's native password manager or a dedicated audited manager as the recovery source until this extension has undergone independent review.

## Data semantics

- Bookmarks merge into a destination folder named `HII Sync`; existing bookmarks are not deleted.
- History restoration uses Chromium's History API, so imported visits receive the sync time rather than their original visit time.
- Tab URLs can be relayed but are not opened automatically.
- Records merge last-write-wins by timestamp. Deletion tombstones are supported by the relay contract but the 0.1 UI does not create them.
