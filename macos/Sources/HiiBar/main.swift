// SPDX-License-Identifier: LicenseRef-BSL-1.1

import AppKit

// `main.swift` top-level code already runs on the main thread; this tells the
// Swift 6 concurrency checker that, so the @MainActor delegate can be built here.
MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.accessory)
    application.run()
}
