import Foundation
import SwiftUI

@MainActor
final class ClipModel: ObservableObject {
    enum Phase: Equatable {
        case waiting            // no invocation URL yet
        case loading
        case card               // the 3-second card
        case reply
        case sending
        case done(claimable: Bool)
        case failed(String)
    }

    @Published var phase: Phase = .waiting
    @Published var landing: GuestLanding?
    @Published var form = ReplyBody.Card(fullName: "", company: nil, jobTitle: nil, email: nil, phone: nil)
    @Published var consent = false
    @Published var message = ""
    @Published var error: String?

    private var api = LinkosAPI(origin: LinkosAPI.origin(for: nil))
    private var tokenOrCode: String?

    /// App Group shared with the full app so it can claim the guest card after install (F-003, Claim은 교환 뒤).
    static let appGroup = "group.app.linkos.shared"
    static let pendingClaimKey = "linkos.pendingClaim"

    func open(url: URL) {
        guard let inv = Invocation(url: url) else {
            phase = .failed("LINKOS 교환 링크가 아니에요.")
            return
        }
        api = LinkosAPI(origin: LinkosAPI.origin(for: url))
        phase = .loading
        Task {
            do {
                let key: String
                switch inv {
                case .token(let t): key = t
                case .shortCode(let c): key = c
                case .nfcTag(let id): key = try await api.resolveTag(id)
                }
                tokenOrCode = key
                landing = try await api.landing(key)
                phase = .card
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    var canSend: Bool {
        consent && !form.fullName.trimmingCharacters(in: .whitespaces).isEmpty
    }

    func send() {
        guard let key = tokenOrCode, canSend else { return }
        phase = .sending
        error = nil
        var card = form
        card.fullName = card.fullName.trimmingCharacters(in: .whitespaces)
        func clean(_ s: String?) -> String? {
            guard let v = s?.trimmingCharacters(in: .whitespaces), !v.isEmpty else { return nil }
            return v
        }
        card.company = clean(card.company)
        card.jobTitle = clean(card.jobTitle)
        card.email = clean(card.email)
        card.phone = clean(card.phone)
        var shared = ["fullName"]
        if card.company != nil { shared.append("company") }
        if card.jobTitle != nil { shared.append("jobTitle") }
        if card.email != nil { shared.append("email") }
        if card.phone != nil { shared.append("phone") }
        let body = ReplyBody(card: card, sharedFields: shared, message: clean(message))
        Task {
            do {
                let r = try await api.reply(key, body: body)
                if let claim = r.claimToken {
                    UserDefaults(suiteName: Self.appGroup)?.set(claim, forKey: Self.pendingClaimKey)
                }
                phase = .done(claimable: r.claimToken != nil)
            } catch {
                self.error = error.localizedDescription
                phase = .reply
            }
        }
    }
}
