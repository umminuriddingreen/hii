# HII Companion for Chrome

HII Companion is a local-first Manifest V3 capture surface. It saves the current
HTTP(S) page, or text explicitly selected through the context menu, to the local
HII information store. Its Setup page can also import separately approved
bookmarks, history, open-tab metadata, and visible page text. Every library
permission is optional, off by default, revocable, and read only during a manual
import. The extension does not index browsing in the background and does not
receive HII account credentials.

## Development install

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select this `extensions/chrome-link-capture` directory and copy the extension ID.
3. From the HII repository, run:

   ```sh
   node scripts/hii-chrome-native-host-install.mjs --browser chrome --extension-id EXTENSION_ID
   ```

4. Restart Chrome, open the extension's Setup page, and choose **Check connection**.
5. Save a page or select text and use **Save selection to HII**. Verify a unique phrase with `hii info find "unique phrase" --json`.

## Optional local browser library

Open **Setup**, enable only the sources you want, then choose **Import enabled
sources to local HII**. Records are sent to the native host in batches of 20 and
use deterministic capture IDs, so repeating an unchanged import is idempotent.
The report shows source counts, unchanged records, failures, and exclusions.

Hard exclusions are part of the implementation, not preferences: Chrome does
not provide a saved-password API to extensions, and HII never requests cookies
or reads session tokens, form values, incognito tabs, browser-internal pages, or
sign-in/payment pages. Page extraction removes forms and editable controls.
Imported library data is local-only and is never bulk-shared to an HII account.
The popup's one-page account handoff remains a separate explicit action.

The extension sends a bounded `hii.web.capture` message to the pinned native
host. The host calls the canonical `hii info ingest-web` path. The optional,
default-off account handoff is a separate native-message flag; the extension
never reads or stores the device token. When selected, the native host encrypts
the capture for private snapshot sync and adds a bounded source link to the first
writable HII account workspace.
