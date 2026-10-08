import StoreKit
import SwiftUI

// Editorial Ink & Paper
extension Color {
    static let ink = Color(red: 0x0E / 255, green: 0x0E / 255, blue: 0x10 / 255)
    static let paper = Color(red: 0xF4 / 255, green: 0xF1 / 255, blue: 0xEA / 255)
    static let signal = Color(red: 0xC8 / 255, green: 0xF0 / 255, blue: 0x3C / 255)
    static let ember = Color(red: 0xFF / 255, green: 0x5A / 255, blue: 0x1F / 255)
    static let mute = Color(red: 0xA7 / 255, green: 0xA3 / 255, blue: 0x9A / 255)
}

struct ContentView: View {
    @EnvironmentObject var model: ClipModel

    var body: some View {
        ZStack {
            Color.ink.ignoresSafeArea()
            switch model.phase {
            case .waiting, .loading:
                ProgressView().tint(.signal).accessibilityLabel("명함을 여는 중")
            case .failed(let msg):
                VStack(alignment: .leading, spacing: 12) {
                    Text("열 수 없어요").font(.system(size: 40, design: .serif).italic()).foregroundStyle(Color.paper)
                    Text(msg).foregroundStyle(Color.mute)
                }
                .padding(24)
            case .card:
                CardScreen()
            case .reply, .sending:
                ReplyScreen()
            case .done(let claimable):
                DoneScreen(claimable: claimable)
            }
        }
    }
}

/// The "3-second card": the sender's Living Card, readable at a glance, one primary action in thumb reach.
struct CardScreen: View {
    @EnvironmentObject var model: ClipModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let l = model.landing {
                Text(((l.placeLabel.map { "\($0)에서 · " }) ?? "") + "명함이 도착했어요")
                    .font(.caption.weight(.semibold)).textCase(.uppercase).foregroundStyle(Color.mute)
                SenderCard(card: l.sender).padding(.top, 14)
                Spacer()
                if l.acceptsReply {
                    Button { model.phase = .reply } label: {
                        Text("내 명함도 보내기").font(.headline).frame(maxWidth: .infinity, minHeight: 54)
                    }
                    .buttonStyle(.borderedProminent).tint(.signal).foregroundStyle(Color.ink)
                    .clipShape(Capsule())
                    Text("가입 없이 교환 · 언제든 삭제 요청 가능").font(.footnote).foregroundStyle(Color.mute)
                        .frame(maxWidth: .infinity).padding(.top, 8)
                } else {
                    Text("이 링크로는 이미 교환이 완료되었어요.").foregroundStyle(Color.mute)
                }
            }
        }
        .padding(20)
    }
}

struct SenderCard: View {
    let card: PublicCard

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text((card.company ?? "").uppercased()).font(.caption.weight(.semibold)).foregroundStyle(Color.ink)
            Text(card.name).font(.system(size: 40, design: .serif).italic()).foregroundStyle(Color.ink).padding(.top, 12)
            if let t = card.jobTitle { Text(t).foregroundStyle(Color.ink) }
            if let h = card.headline { Text(h).font(.subheadline).foregroundStyle(Color.ink.opacity(0.75)).padding(.top, 6) }
            ForEach(card.fields, id: \.self) { f in
                Text(f.value).font(.subheadline).foregroundStyle(Color.ink.opacity(0.8)).textSelection(.enabled)
            }
            Capsule().fill(Color.signal).frame(width: 48, height: 4).padding(.top, 12)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.paper, in: RoundedRectangle(cornerRadius: 28))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(card.name) 명함")
    }
}

struct ReplyScreen: View {
    @EnvironmentObject var model: ClipModel

    private func binding(_ kp: WritableKeyPath<ReplyBody.Card, String?>) -> Binding<String> {
        Binding(get: { model.form[keyPath: kp] ?? "" }, set: { model.form[keyPath: kp] = $0 })
    }

    var body: some View {
        let first = model.landing?.sender.name ?? "상대"
        Form {
            Section {
                TextField("이름 (필수)", text: $model.form.fullName).textContentType(.name)
                TextField("회사", text: binding(\.company)).textContentType(.organizationName)
                TextField("직책", text: binding(\.jobTitle)).textContentType(.jobTitle)
                TextField("이메일", text: binding(\.email)).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                TextField("전화", text: binding(\.phone)).textContentType(.telephoneNumber).keyboardType(.phonePad)
            } header: {
                Text("\(first)님께 보낼 내용 · 입력한 항목만 전달돼요")
            }
            Section {
                TextField("한 줄 메시지 (선택)", text: $model.message)
            }
            Section {
                Toggle("입력한 항목을 \(first)님에게 보내는 데 동의합니다.", isOn: $model.consent)
            }
            if let e = model.error {
                Text(e).foregroundStyle(Color.ember).accessibilityAddTraits(.isStaticText)
            }
            Section {
                Button(model.phase == .sending ? "보내는 중…" : "\(first)님께 보내기") { model.send() }
                    .disabled(!model.canSend || model.phase == .sending)
            }
        }
        .scrollContentBackground(.hidden)
    }
}

struct DoneScreen: View {
    let claimable: Bool
    @EnvironmentObject var model: ClipModel
    @State private var showOverlay = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 72)).foregroundStyle(Color.signal).accessibilityHidden(true)
            Text("교환 완료").font(.system(size: 48, design: .serif).italic()).foregroundStyle(Color.paper)
            Text("\(model.landing?.sender.name ?? "상대")님에게 내 명함이 전달됐어요.").foregroundStyle(Color.mute)
            if claimable {
                Text("LINKOS 앱을 설치하면 방금 만든 카드를 소유하고, \(model.landing?.sender.name ?? "상대")님 명함도 내 인맥에 저장돼요. (선택)")
                    .font(.footnote).foregroundStyle(Color.mute).multilineTextAlignment(.center)
                Button("LINKOS 앱 받기") { showOverlay = true }
                    .buttonStyle(.borderedProminent).tint(.signal).foregroundStyle(Color.ink)
            }
        }
        .padding(24)
        // offer the full app only after the exchange (Claim은 교환 뒤)
        .appStoreOverlay(isPresented: $showOverlay) { SKOverlay.AppClipConfiguration(position: .bottom) }
    }
}
