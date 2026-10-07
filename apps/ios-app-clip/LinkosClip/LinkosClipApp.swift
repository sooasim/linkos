// F-042 iOS App Clip — 초경량 수신 플로우.
// Invoked from a LINKOS link (Safari/Messages Smart App Banner, App Clip Code, NFC tag, QR):
//   https://<domain>/x/{token}   one-time exchange link
//   https://<domain>/c/{code}    6-char short code
//   https://<domain>/n/{tagId}   NFC accessory tag (server mints a fresh one-time link and redirects to /x/{token})
// Shows the sender's card immediately (the "3-second card"), then a short manual reply form → public reply API.
// No login, no full-app install wall (교환이 가입보다 먼저). The full app is offered only after the exchange.
import SwiftUI

@main
struct LinkosClipApp: App {
    @StateObject private var model = ClipModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                // App Clip invocation URL arrives as a browsing-web user activity
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { model.open(url: url) }
                }
                // local testing (_XCAppClipURL env var) / custom scheme
                .onOpenURL { url in model.open(url: url) }
        }
    }
}
