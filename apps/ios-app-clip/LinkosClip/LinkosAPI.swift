import Foundation

/// Minimal client for the public (no-login) exchange endpoints.
struct LinkosAPI {
    struct Failure: Error, LocalizedError {
        let status: Int
        let code: String
        let message: String
        var errorDescription: String? { message }
    }

    /// Info.plist `LinkosAPIOrigin` (e.g. https://linkos.app); the invocation URL's own origin is preferred.
    let origin: URL

    static func origin(for invocationURL: URL?) -> URL {
        if let u = invocationURL, let scheme = u.scheme, let host = u.host, scheme == "https" {
            var c = URLComponents()
            c.scheme = scheme
            c.host = host
            c.port = u.port
            if let o = c.url { return o }
        }
        let configured = Bundle.main.object(forInfoDictionaryKey: "LinkosAPIOrigin") as? String ?? "https://linkos.app"
        return URL(string: configured)!
    }

    private var session: URLSession {
        let cfg = URLSessionConfiguration.ephemeral // no cookies persisted in the clip
        cfg.timeoutIntervalForRequest = 15
        cfg.httpAdditionalHeaders = ["User-Agent": "LINKOS-AppClip/1.0", "Accept": "application/json"]
        return URLSession(configuration: cfg)
    }

    private func decode<T: Decodable>(_ data: Data, _ response: URLResponse) throws -> T {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let body = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            throw Failure(status: status, code: body?.code ?? "error", message: body?.message ?? "요청을 처리하지 못했습니다.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func path(_ tokenOrCode: String) -> String {
        tokenOrCode.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? tokenOrCode
    }

    func landing(_ tokenOrCode: String) async throws -> GuestLanding {
        let url = origin.appendingPathComponent("api/v1/exchange/sessions/\(path(tokenOrCode))")
        let (data, response) = try await session.data(from: url)
        return try decode(data, response)
    }

    func reply(_ tokenOrCode: String, body: ReplyBody) async throws -> ReplyResult {
        var req = URLRequest(url: origin.appendingPathComponent("api/v1/exchange/sessions/\(path(tokenOrCode))/reply"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: req)
        return try decode(data, response)
    }

    /// NFC tag: the server answers with a redirect to /x/{token}; URLSession follows it — read the final URL.
    func resolveTag(_ tagId: String) async throws -> String {
        let url = origin.appendingPathComponent("n/\(path(tagId))")
        let (_, response) = try await session.data(from: url)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard let final = response.url, case .token(let token)? = Invocation(url: final) else {
            throw Failure(status: status, code: status == 410 ? "nfc_tag_revoked" : "nfc_tag_invalid",
                          message: status == 410 ? "이 NFC 태그는 소유자가 비활성화했습니다." : "태그를 열 수 없어요.")
        }
        return token
    }
}
