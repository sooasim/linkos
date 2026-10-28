"use client";
// LINKOS role-based console — shell + state + demo interactions.
// Faithful React port of prototype/assets/dashboard-suite.js (ROLES render, action switch, modal/toast,
// focus trap, CSV export). All state changes are in-browser demo only — no auth / DB / payment / AI.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { Pill, SuiteProvider, type SuiteCtxValue } from "./ctx";
import { DEFAULT_CHAPTER, DEFAULT_TENANT, ROLES, initialModel, routeFor, specRouteFor, type Member, type Role } from "./config";
import { MemberView } from "./views/member";
import { ChapterView } from "./views/chapter";
import { TenantView } from "./views/tenant";
import { PlatformView } from "./views/platform";

type ModalState = { title: string; body: ReactNode; footer?: ReactNode } | null;

const GENERIC: Record<string, [string, string, string]> = {
  newInvite: ["회원 초대", "초대할 이메일", "가입 신청 URL 발급/1회성 토큰"],
  newVisitor: ["방문자 초대", "방문자 이메일", "방문자가 직접 개인정보 항목을 입력해야 합니다"],
  addChapter: ["챕터 개설", "새 챕터 명칭", "운영기관별 slug·최대 개설 수 검사"],
  newEvent: ["모임 일정 개설", "모임 제목", "시간대와 반복 일정 예외 처리"],
  newMeeting: ["1:1 미팅 기록", "미팅 의제", "상대 승인/공유 요약 별도 동의"],
  newTicket: ["지원 티켓 생성", "업무 요약", "테넌트 비공개 내용 자동 첨부 금지"],
};

const CONTRACT: Record<string, string> = {
  preview: "공개 프로필 미리보기",
  editProfile: "기업 프로필 수정",
  checkIn: "모임 체크인 관리",
  changePlan: "요금 변경 검토",
  paymentMethod: "결제수단 위탁 관리",
  policyChange: "운영 정책 변경 승인",
  brandPreview: "전용 브랜드 배포 검토",
  tenantRequest: "기관 계약 승인 심사",
  tenantMeta: "계약 메타 정보",
  breakGlass: "긴급 접근 2인 승인",
  runbook: "운영 장애 대응 매뉴얼",
  releaseCheck: "릴리즈 게이트 검토",
};

function val(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return el ? el.value : "";
}

export function Suite({ role, page, tenant = DEFAULT_TENANT, chapter = DEFAULT_CHAPTER }: { role: Role; page: string; tenant?: string; chapter?: string }) {
  const router = useRouter();
  const [model, setModel] = useState(initialModel);
  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  const r = ROLES[role];
  const pending = model.members.filter((m) => m.status === "대기").length;
  const currentTitle = (r.nav.find((n) => n.key === page) ?? r.nav[0])?.title ?? "";

  function announce(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4100);
  }
  function go(next: string) {
    setSidebarOpen(false);
    if (!r.nav.some((n) => n.key === next)) return;
    router.push(routeFor(role, next, tenant, chapter));
  }
  function switchRole(nextRole: Role) {
    setSidebarOpen(false);
    router.push(routeFor(nextRole, "home", tenant, chapter));
    announce(`${ROLES[nextRole].name} 시안으로 전환했습니다. (실제 인증 권한 전환 아님)`);
  }
  function showModal(title: string, body: ReactNode, footer?: ReactNode) {
    triggerRef.current = (document.activeElement as HTMLElement) ?? null;
    setModal({ title, body, footer });
  }
  function closeModal() {
    setModal(null);
    triggerRef.current?.focus?.();
  }

  const fbtn = (label: string, key: string, variant = "") => (
    <button type="button" className={`btn ${variant}`.trim()} onClick={() => action(key)}>
      {label}
    </button>
  );

  function action(key: string) {
    const parts0 = key.split(":");
    const a = parts0[0] ?? "";
    const id = parts0[1] ?? "";
    switch (a) {
      case "closeModal":
        closeModal();
        break;
      case "info":
        showModal(
          "시안 사용 및 제한 사항",
          <>
            <p>
              이 화면은 관리자·회원 UI/UX를 검토하는 <strong>프런트엔드 정적 시안</strong>입니다. 우측 상단 역할 선택을 사용하면 4개 대시보드가 바뀝니다.
            </p>
            <p>가상의 승인, 출석 응답, 검색, 동의 설정, 양사 소개 승인 과정을 클릭할 수 있지만 실제 계정, 데이터베이스, 결제, SMS, AI API와 연결되지 않습니다.</p>
            <p>본 ZIP의 uiux/ 문서에 각 화면의 필드·API·권한·검수 조건을 적었습니다.</p>
          </>,
        );
        break;
      case "newIntro":
        showModal(
          "소개 요청 작성 · 시연",
          <>
            <div className="field">
              <label htmlFor="introType">소개 유형</label>
              <select id="introType" defaultValue="기업 협업">
                <option>기업 협업</option>
                <option>고객 소개</option>
                <option>공동 프로젝트</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="introSummary">수요 요약</label>
              <textarea id="introSummary" placeholder="업종·제품·협업 목표만 입력하세요. 동의되지 않은 개인 연락처나 기밀은 제외합니다." />
            </div>
            <p>서버 구현 시 적법한 정보 공개 동의·중복 방지·양측 독립 승인을 검증해야 합니다.</p>
          </>,
          fbtn("데모 요청서 확인", "sendIntro", "primary"),
        );
        break;
      case "sendIntro": {
        if (!val("introSummary").trim()) {
          document.getElementById("introSummary")?.focus();
          announce("수요 요약을 입력해 주세요.");
          return;
        }
        closeModal();
        announce("시안에서 소개 요청서 형식을 확인했습니다. 실제 요청은 저장·발송되지 않았습니다.");
        break;
      }
      case "approveA":
        setModel((m) => ({ ...m, introA: true }));
        announce("가상 A기업 승인 상태로 바꿨습니다. 실제 서비스는 독립 로그인에서 승인합니다.");
        break;
      case "approveB":
        setModel((m) => ({ ...m, introB: true }));
        announce("가상 B기업 승인 상태로 바꿨습니다. 실제 서비스는 독립 로그인에서 승인합니다.");
        break;
      case "resetIntro":
        setModel((m) => ({ ...m, introA: false, introB: false }));
        announce("소개 데모 상태를 초기화했습니다.");
        break;
      case "rsvp":
        setModel((m) => ({ ...m, meetingRsvp: !m.meetingRsvp }));
        announce("시연 응답만 반영했습니다. 실제 모임에 전송되지 않습니다.");
        break;
      case "approveMember":
      case "rejectMember": {
        const m = model.members.find((x) => x.id === Number(id));
        if (!m) return;
        const isApprove = a === "approveMember";
        showModal(
          isApprove ? "회원 승인 시연" : "회원 거절 시연",
          <>
            <p>
              <strong>{m.name}</strong> 신청자의 가입 상태를 <strong>{isApprove ? "승인" : "거절"}</strong> 처리하는 UI입니다.
            </p>
            <div className="field">
              <label htmlFor="approveReason">검토 사유 (필수)</label>
              <textarea id="approveReason" placeholder="업종 중복·권한·신청 정보 검토 내용을 남기세요." />
            </div>
            <p>실제 구현에서는 승인자 자격, 이미 변경된 상태, 업종 정책 및 감사 로그를 서버에서 확인해야 합니다.</p>
          </>,
          fbtn("시연 처리", `confirmMember:${id}:${isApprove ? "승인" : "거절"}`, "primary"),
        );
        break;
      }
      case "confirmMember": {
        const parts = key.split(":");
        if (!val("approveReason").trim()) {
          announce("검토 사유를 작성해 주세요.");
          document.getElementById("approveReason")?.focus();
          return;
        }
        const mid = Number(parts[1]);
        const status = parts[2] ?? "";
        setModel((m) => ({ ...m, members: m.members.map((x): Member => (x.id === mid ? { ...x, status } : x)) }));
        closeModal();
        announce("시연 상태를 변경했습니다. 실제 가입정보는 바뀌지 않았습니다.");
        break;
      }
      case "finishFollowup":
        setModel((m) => ({ ...m, followupDone: !m.followupDone }));
        announce("후속 확인 시연 상태를 변경했습니다.");
        break;
      case "clearSearch":
        setModel((m) => ({ ...m, search: "" }));
        break;
      case "export": {
        const data = ["항목,예시값,구분", "이번달 소개,19,가상데이터", "양측승인,11,가상데이터", "유효기회,7,가상데이터"].join("\n");
        const file = new Blob(["﻿" + data], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = url;
        link.download = "LINKOS_DEMO_AGGREGATE_ONLY.csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        announce("가상 집계 데이터만 CSV로 내려받았습니다. 실사용자 정보는 포함되지 않습니다.");
        break;
      }
      case "privacyRequest":
      case "deleteAccount":
        showModal(
          a === "privacyRequest" ? "내 정보 열람·반출 신청" : "계정 삭제 요청 안내",
          <>
            <p>본 화면은 신청 흐름의 시안이며 접수·저장·삭제가 수행되지 않습니다.</p>
            <div className="field">
              <label htmlFor="requestReason">신청 유형/사유</label>
              <textarea id="requestReason" placeholder="개인정보 권리 요청 내용을 입력해 주세요." />
            </div>
            <p>운영 서비스는 본인 확인과 법정 보유 의무를 검토하여 처리합니다.</p>
          </>,
          fbtn("요청 형식 점검", "testRequest", "primary"),
        );
        break;
      case "testRequest":
        closeModal();
        announce("요청 화면 동작만 확인했습니다. 실제 티켓은 생성되지 않았습니다.");
        break;
      case "period":
        showModal(
          "조회 기간 선택 (시연)",
          <>
            <div className="field">
              <label htmlFor="periodSel">대시보드 기간</label>
              <select id="periodSel" defaultValue="30">
                <option value="7">최근 7일</option>
                <option value="30">최근 30일</option>
                <option value="90">최근 90일</option>
              </select>
            </div>
            <p>데모 수치는 고정 합성 예시이며 기간에 따라 집계되지 않습니다.</p>
          </>,
          fbtn("적용 안내", "periodApply", "primary"),
        );
        break;
      case "periodApply":
        setModel((m) => ({ ...m, period: val("periodSel") || m.period }));
        closeModal();
        announce("기간 선택 UI만 확인했습니다. 실데이터 집계는 구현 전입니다.");
        break;
      case "newInvite":
      case "newVisitor":
      case "addChapter":
      case "newEvent":
      case "newMeeting":
      case "newTicket": {
        const cfg = GENERIC[a]!;
        showModal(
          `${cfg[0]} · 시연`,
          <>
            <div className="field">
              <label htmlFor="genericTitle">{cfg[1]}</label>
              <input id="genericTitle" placeholder={cfg[1]} />
            </div>
            <div className="field">
              <label htmlFor="genericNote">상세 설명 (선택)</label>
              <textarea id="genericNote" placeholder="업무 목적과 필요한 정보만 입력하세요." />
            </div>
            <p>{cfg[2]}. 이 데모는 서버 작업을 실행하지 않습니다.</p>
          </>,
          fbtn("입력 검증 시연", "genericSubmit", "primary"),
        );
        break;
      }
      case "genericSubmit": {
        if (!val("genericTitle").trim()) {
          document.getElementById("genericTitle")?.focus();
          announce("필수 항목을 입력해 주세요.");
          return;
        }
        closeModal();
        announce("데모 입력값을 검증했습니다. 실제 초대·개설·예약·티켓은 생성되지 않았습니다.");
        break;
      }
      case "introDetail":
        showModal(
          "소개 상세 · 접수 상태",
          <>
            <p>소개 상세의 연락처는 양측 소개 수락과 개인정보 공개 근거가 확보되기 전에는 API에서도 제외해야 합니다.</p>
            <div className="line">
              <span>연락처 표시</span>
              <Pill tone="amber">상호승인 전 차단</Pill>
            </div>
          </>,
        );
        break;
      case "memberDetail":
        showModal("회원 정보 · 확인", <p>가상 회원의 업종과 가입 상태만 표시합니다. 주민번호, 개인 휴대폰, 외부 기업의 영업비밀은 포함되지 않습니다.</p>);
        break;
      case "visitorFollowup":
        showModal("방문자 후속관리", <p>참여 확인 및 동의 기반 가입 제안만 수행합니다. 방문자의 RSVP를 회원가입 또는 광고동의로 자동 전환하지 않습니다.</p>);
        break;
      case "preview":
      case "editProfile":
      case "checkIn":
      case "changePlan":
      case "paymentMethod":
      case "policyChange":
      case "brandPreview":
      case "tenantRequest":
      case "tenantMeta":
      case "breakGlass":
      case "runbook":
      case "releaseCheck":
        showModal(
          `${CONTRACT[a]} · 개발 화면 계약`,
          <>
            <p>
              이 버튼은 화면 전환/확인 모달까지만 구현한 시연입니다. 실제 서버 연동을 전제로 하는 중요한 기능으로, 구현 시 <strong>권한 확인 → 서버 검증 → 감사로그 기록 → 결과 재조회</strong> 순서로 처리해야 합니다.
            </p>
            <p>
              세부 API·DB·실패상태는 ZIP의 <code>uiux/</code> 및 <code>docs/</code> 명세를 따릅니다.
            </p>
          </>,
        );
        break;
      case "notifications":
        showModal(
          "새 알림 예시",
          <>
            <p>가상 알림 3건: 소개 요청 1건, 다음 모임 안내 1건, 인증 만료 알림 1건.</p>
            <p>알림 발송은 필수 운영 정보와 선택 마케팅 정보를 명확히 구분해야 합니다.</p>
          </>,
        );
        break;
      default:
        if (r.nav.some((n) => n.key === a)) go(a);
        else announce("정의되지 않은 시연 동작입니다.");
    }
  }

  // modal lifecycle: body scroll lock, initial focus, Escape + Tab focus trap
  useEffect(() => {
    if (!modal) {
      document.body.style.overflow = "";
      return;
    }
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeModal();
        return;
      }
      if (e.key === "Tab" && modalRef.current) {
        const nodes = Array.from(
          modalRef.current.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]"),
        );
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  const ctx: SuiteCtxValue = {
    model,
    role,
    tenant,
    chapter,
    go,
    action,
    setSearch: (v) => setModel((m) => ({ ...m, search: v })),
    setConsent: (cid, checked) => {
      setModel((m) => ({ ...m, consents: { ...m.consents, [cid]: checked } }));
      announce("선택 동의 시연 값만 바뀌었습니다. 실제 동의 서버 기록은 생성되지 않습니다.");
    },
  };

  const views: Record<Role, ReactNode> = {
    member: <MemberView page={page} />,
    chapter: <ChapterView page={page} />,
    tenant: <TenantView page={page} />,
    platform: <PlatformView page={page} />,
  };

  return (
    <SuiteProvider value={ctx}>
      <a className="skip-link" href="#screen">
        본문 바로가기
      </a>
      <div className="shell">
        <aside className={`side ${sidebarOpen ? "open" : ""}`} id="sidebar" aria-label="시연 역할 별 메뉴">
          <div className="brand">
            <span className="brand-mark">↗</span>
            <div>
              <div className="brand-word">
                linkos<span style={{ color: "#56dac3" }}>.</span>
              </div>
              <div className="brand-sub">BUSINESS OPERATING SYSTEM</div>
            </div>
          </div>
          <div className="workspace">
            <div className="workspace-title">ACTIVE WORKSPACE</div>
            <div className="workspace-box">
              <div className="workspace-name">
                <strong>{r.name}</strong>
                <span>{r.who}</span>
              </div>
              <span aria-hidden="true">⌄</span>
            </div>
          </div>
          <nav className="side-nav" aria-label="현재 역할 메뉴">
            <div className="nav-caption">{r.caption}</div>
            {r.nav.map((item) => (
              <button
                type="button"
                key={item.key}
                className={`nav-item ${page === item.key ? "active" : ""}`}
                onClick={() => go(item.key)}
                aria-current={page === item.key ? "page" : undefined}
              >
                <Icon name={item.icon} size={18} className="ico" />
                <span>{item.title}</span>
                {item.key === "members" && role === "chapter" ? <span className="tag">{pending}</span> : null}
              </button>
            ))}
            <div className="nav-caption" style={{ marginTop: 15 }}>
              PREVIEW TOOLS
            </div>
            <button type="button" className="nav-item" onClick={() => action("info")}>
              <Icon name="file" size={18} className="ico" />
              <span>시안 사용 안내</span>
            </button>
          </nav>
          <div className="side-foot">
            <span className="status-dot" /> <strong>Static Demo / Offline</strong>
            <br />
            실제 고객 데이터 연결 없음
            <br />
            BNI 공식 제휴 제품 아님
          </div>
        </aside>
        <div className={`side-overlay ${sidebarOpen ? "active" : ""}`} aria-hidden="true" onClick={() => setSidebarOpen(false)} />
        <div className="main">
          <header className="topbar">
            <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
              <button className="icon-button mobile-menu" aria-label="메뉴 열기" onClick={() => setSidebarOpen((o) => !o)}>
                <Icon name="menu" size={18} />
              </button>
              <div className="crumb">
                플랫폼 <span>›</span> {r.name} <span>›</span> <strong>{currentTitle}</strong>
              </div>
            </div>
            <div className="top-right">
              <label htmlFor="roleSelect" className="tiny muted" style={{ fontWeight: 700 }}>
                역할별 화면
              </label>
              <select id="roleSelect" className="select" aria-label="시연용 역할 선택" value={role} onChange={(e) => switchRole(e.target.value as Role)}>
                <option value="member">일반 회원</option>
                <option value="chapter">챕터 운영자</option>
                <option value="tenant">기관 관리자</option>
                <option value="platform">플랫폼 관리자</option>
              </select>
              <button className="icon-button" aria-label="알림 예시" onClick={() => action("notifications")}>
                <Icon name="bell" size={18} />
              </button>
              <div className="identity">
                <div className="avatar">L</div>
                <div>
                  <div className="identity-name">{r.account}</div>
                  <div className="identity-desc">{r.name}</div>
                </div>
              </div>
            </div>
          </header>
          <main className="content" id="screen" aria-live="polite">
            <div className="demo-note">
              <Icon name="bolt" size={15} />{" "}
              <span>
                <strong>UI/UX 정적 데모:</strong> 모든 기업·회원·숫자·계약은 가상 데이터입니다. 화면 상태 변화는 현재 브라우저 메모리 시연이며 실제 로그인, 저장, 승인, 전송, 결제 또는 AI 처리가 아닙니다.{" "}
              {role === "platform" ? "플랫폼 운영자는 고객 개인정보·대화 본문을 기본 열람하지 않습니다." : ""}
              </span>
            </div>
            {views[role]}
            <footer className="footer-help">
              LINKOS UI/UX specification preview v2.0 · 2026.10.24 · 독립형 비즈니스 커뮤니티 SaaS · BNI 공식 제품 아님 · 사양 경로 {specRouteFor(role, page)}
            </footer>
          </main>
        </div>
      </div>
      {modal ? (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" ref={modalRef}>
            <div className="modal-head">
              <h2 id="modalTitle">{modal.title}</h2>
              <button type="button" className="icon-button" aria-label="닫기" onClick={closeModal} ref={closeBtnRef}>
                <Icon name="close" />
              </button>
            </div>
            {modal.body}
            <div className="modal-foot">
              <button type="button" className="btn" onClick={closeModal}>
                닫기
              </button>
              {modal.footer}
            </div>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
    </SuiteProvider>
  );
}
