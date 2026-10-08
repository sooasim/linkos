import Foundation

/// GET /api/v1/exchange/sessions/{tokenOrCode} — public-safe sender card (ACL-filtered server-side).
struct GuestLanding: Decodable {
    let sessionId: String
    let state: String
    let acceptsReply: Bool
    let isGroup: Bool
    let placeLabel: String?
    let expiresAt: String
    let sender: PublicCard
}

struct PublicCard: Decodable {
    struct Field: Decodable, Hashable {
        let type: String
        let label: String?
        let value: String
    }
    let name: String
    let company: String?
    let jobTitle: String?
    let headline: String?
    let bioShort: String?
    let keywords: [String]
    let fields: [Field]
    let offers: [String]
    let needs: [String]
}

/// POST /api/v1/exchange/sessions/{tokenOrCode}/reply body (OpenAPI replyExchange).
struct ReplyBody: Encodable {
    struct Card: Encodable {
        var fullName: String
        var company: String?
        var jobTitle: String?
        var email: String?
        var phone: String?
    }
    struct Consent: Encodable {
        let exchange = true
    }
    let card: Card
    /// only the fields the guest explicitly sends (F-058)
    let sharedFields: [String]
    let consent = Consent()
    let provenance: [String: String] = [:]
    let message: String?
}

struct ReplyResult: Decodable {
    let exchanged: Bool
    let claimToken: String?
    let senderName: String?
}

struct APIErrorBody: Decodable {
    let code: String
    let message: String?
}

/// Parses an invocation URL into the token or short code the public API accepts.
enum Invocation: Equatable {
    case token(String)
    case shortCode(String)
    case nfcTag(String)

    init?(url: URL) {
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2 else { return nil }
        let value = parts[1]
        let tokenChars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        switch parts[0] {
        case "x" where (22...128).contains(value.count) && value.unicodeScalars.allSatisfy(tokenChars.contains):
            self = .token(value)
        case "c" where value.count == 4 && value.allSatisfy({ $0.isASCII && $0.isNumber }):  // 4-digit exchange code (F-045)
            self = .shortCode(value)
        case "n" where (22...128).contains(value.count) && value.unicodeScalars.allSatisfy(tokenChars.contains):
            self = .nfcTag(value)
        default:
            return nil
        }
    }
}
