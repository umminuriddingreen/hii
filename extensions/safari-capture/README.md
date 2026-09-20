# HII Safari Capture

This macOS Safari Web Extension packages the same `page-index.js` and capture
payload contract as the Chromium connector. The Safari native-message handler
passes local-only captures to `hii info ingest-web`; it never sends page text
to the public site. Indexing still requires the user to enable it in Options
and grant website access. Private windows, login/payment pages, and editable
contents are excluded by the shared script.

Open `HII Safari Capture/HII Safari Capture.xcodeproj` in Xcode, select a
signing team for both targets, build the macOS companion app, and enable its
extension in Safari Settings. The installed HII CLI must be on the handler's
known PATH. Without an Apple signing identity the project can be compiled with
`CODE_SIGNING_ALLOWED=NO`, but Safari cannot enable it as a production
extension. Cloud snapshot upload is not connected in this Safari handler yet;
the local HII information index receives its captures.

The extension resources are copied from `extensions/chrome-link-capture` at
project generation time. Changes to the shared page-index script must also be
copied into this project's `Resources` before building.
