"use client";
// U-M01~06 · 일반 회원 대시보드 — ported from prototype member views. FR-003/006/007/010~014/017/101.
import { Activity, Btn, GoBtn, Help, Kpi, OrgCards, PageHead, Pill, Sec, Spark, useSuite } from "../ctx";
import { Icon } from "../icons";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input value={value} readOnly />
    </div>
  );
}

export function MemberView({ page }: { page: string }) {
  const { model, setSearch, setConsent, action } = useSuite();
  const both = model.introA && model.introB;

  if (page === "meetings") {
    return (
      <>
        <PageHead title="나의 모임과 1:1" sub="참여 예정 모임과 비즈니스 미팅을 관리합니다." actions={<Btn label="1:1 미팅 기록" act="newMeeting" variant="primary" icon="plus" />} />
        <div className="grid3">
          <Kpi label="참여 예정" value="2건" foot="향후 30일" icon="calendar" />
          <Kpi label="이번 달 출석" value="3/4" foot="출석 정정 시 감사 기록" icon="check" tone="blue" />
          <Kpi label="나의 1:1" value="4건" foot="상대 확인 완료 기준" icon="people" tone="gold" />
        </div>
        <div className="twobalanced">
          <div className="card">
            <Sec title="모임 참석 응답" />
            <div className="line">
              <div>
                <strong>10월 28일 정기모임</strong>
                <div className="tiny muted">서울 비즈니스 챕터 · 07:00~08:30</div>
              </div>
              <Pill tone={model.meetingRsvp ? "green" : "amber"}>{model.meetingRsvp ? "참석" : "미응답"}</Pill>
            </div>
            <p className="tiny muted">실제 참석 기록은 모임 운영자의 서버 확인 후 반영됩니다.</p>
            <Btn label={model.meetingRsvp ? "참석 응답 취소" : "참석 응답하기"} act="rsvp" variant="primary" />
          </div>
          <div className="card">
            <Sec title="다가오는 1:1" />
            <Activity title="가상AI랩과 사업 협의" sub="10월 30일 11:00 · 화상미팅" when="D-6" icon="people" />
            <Activity title="가상무역파트너 문의" sub="11월 2일 14:00 · 장소 미정" when="D-9" icon="calendar" />
          </div>
        </div>
        <Help>개인 메모는 기본 비공개입니다. 공유 요약은 별도로 작성하고 참여자 권한을 확인해야 합니다.</Help>
      </>
    );
  }

  if (page === "referrals") {
    return (
      <>
        <PageHead title="사업 소개 · 승인 현황" sub="소개 대상에게 연락 정보가 넘어가기 전 단계별 동의를 관리합니다." actions={<Btn label="새 소개 요청" act="newIntro" variant="primary" icon="plus" />} />
        <div className="grid3">
          <Kpi label="소개 요청 총계" value="19" foot="이번 달 · 가상값" icon="link" />
          <Kpi label="상호 승인" value="11" foot="양쪽 승인 완료" icon="check" tone="blue" />
          <Kpi label="검증된 기회" value="7" foot="미팅·후속 확인" icon="trend" tone="gold" />
        </div>
        <div className="twobalanced">
          <div className="card">
            <Sec title="소개 승인 절차" more={<Pill tone={both ? "green" : "amber"}>{both ? "쌍방 승인 완료" : "연락처 비공개"}</Pill>} />
            <p className="tiny muted">시연에서는 A와 B 승인 버튼을 각각 눌러 상태 변화를 볼 수 있습니다. 운영환경에서는 **별도 인증 계정**에서만 승인할 수 있습니다.</p>
            <div className="timeline">
              <span className="done" />
              <span className={model.introA ? "done" : ""} />
              <span className={model.introB ? "done" : ""} />
              <span className={both ? "done" : ""} />
            </div>
            <div className="line">
              <span>소개 요청 생성</span>
              <Pill tone="green">접수</Pill>
            </div>
            <div className="line">
              <span>A 기업 승인</span>
              <Pill tone={model.introA ? "green" : "amber"}>{model.introA ? "승인" : "대기"}</Pill>
            </div>
            <div className="line">
              <span>B 기업 승인</span>
              <Pill tone={model.introB ? "green" : "amber"}>{model.introB ? "승인" : "대기"}</Pill>
            </div>
            <div className="line">
              <span>승인 후 연락 공개</span>
              <Pill tone={both ? "green" : "red"}>{both ? "가상 연락 경로 열림" : "차단"}</Pill>
            </div>
            <div className="actions" style={{ marginTop: 16 }}>
              <Btn label="A 승인 시연" act="approveA" variant={model.introA ? "" : "primary"} />
              <Btn label="B 승인 시연" act="approveB" variant={model.introB ? "" : "primary"} />
              <Btn label="초기화" act="resetIntro" />
            </div>
          </div>
          <div className="card">
            <Sec title="가상 소개 상세" />
            <div className="number-box">
              <strong style={{ fontSize: 14 }}>제조 공정 자동화 파트너 연결</strong>
              <span className="muted tiny">가상AI랩 ↔ 가상그린산업 · NDA 확인 필요</span>
            </div>
            <div className="line">
              <span>수요 설명</span>
              <strong>생산라인 데이터 분석</strong>
            </div>
            <div className="line">
              <span>사업 검증</span>
              <strong>기업 자진신고</strong>
            </div>
            <div className="line">
              <span>공유 가능 연락처</span>
              <strong>{both ? "demo@company.invalid" : "🔒 잠김"}</strong>
            </div>
            <Help>승인 이전에는 가상 연락처조차 화면에 렌더링하지 않도록 구성했습니다. 승인 철회 시 API와 UI 모두 재차단해야 합니다.</Help>
          </div>
        </div>
      </>
    );
  }

  if (page === "directory") {
    return (
      <>
        <PageHead title="기업 탐색" sub="공개·동의된 회사 정보만 검색하며 연락처는 승인 후 공유됩니다." actions={<Btn label="내 기업 정보 수정" act="profile" variant="primary" icon="building" />} />
        <div className="card" style={{ marginBottom: 17 }}>
          <div className="actions mobile-stack" style={{ display: "flex" }}>
            <label htmlFor="directorySearch" className="tiny" style={{ fontWeight: 800 }}>
              검색어
            </label>
            <input id="directorySearch" className="search" placeholder="기업·서비스·업종 검색" value={model.search} onChange={(e) => setSearch(e.target.value)} />
            <button type="button" className="btn" onClick={() => action("clearSearch")}>
              초기화
            </button>
            <Pill tone="green">공개 범위 우선</Pill>
          </div>
        </div>
        <div id="org-results" className="grid3">
          <OrgCards />
        </div>
        <Help>검색 데이터는 전부 가상값입니다. 다른 챕터 또는 운영기관에 속한 비공개 정보는 서버에서 조회 결과 자체를 제외합니다.</Help>
      </>
    );
  }

  if (page === "profile") {
    return (
      <>
        <PageHead title="내 기업 프로필" sub="기업·서비스를 설명하고 공개 범위를 제어합니다." actions={<Btn label="프로필 미리보기" act="preview" />} />
        <div className="twobalanced">
          <div className="card">
            <Sec title="기업 기본 정보" />
            <div className="form-grid">
              <Field label="공개 기업명" value="가상마케팅" />
              <Field label="업종" value="마케팅 / 브랜딩" />
              <Field label="활동 지역" value="서울" />
              <Field label="기업 인증" value="검증 전 · 회원 자진신고" />
            </div>
            <div className="field">
              <label>주요 제공 서비스</label>
              <textarea value="기업 브랜딩, 디지털 광고, 홈페이지 제작, 콘텐츠 기획" readOnly />
            </div>
            <Btn label="편집 동작 보기" act="editProfile" variant="primary" />
          </div>
          <div className="card">
            <Sec title="정보 그룹별 공개 수준" />
            <div className="line">
              <strong>공개 기업명·업종</strong>
              <Pill tone="green">PUBLIC</Pill>
            </div>
            <div className="line">
              <strong>기업 상세 서비스</strong>
              <Pill tone="blue">CHAPTER</Pill>
            </div>
            <div className="line">
              <strong>담당자 이메일·휴대폰</strong>
              <Pill tone="amber">AFTER APPROVAL</Pill>
            </div>
            <div className="line">
              <strong>개인 메모·거래 금액</strong>
              <Pill tone="gray">PRIVATE</Pill>
            </div>
            <Help>기업 프로필 공개 범위는 필드 그룹별로 저장하고 검색 인덱스에도 동일한 범위를 적용해야 합니다.</Help>
          </div>
        </div>
      </>
    );
  }

  if (page === "privacy") {
    const toggles: [string, string, string][] = [
      ["introduction", "사업 소개 참여", "양측 승인을 거치는 소개 요청"],
      ["marketing", "광고성 이메일", "신규 요금제·행사 등 광고성 정보"],
      ["discovery", "외부 챕터 탐색 허용", "운영기관 간 허용한 기업 공개 정보"],
    ];
    return (
      <>
        <PageHead title="공개 · 동의 설정" sub="목적별 동의는 분리하고 철회 뒤에는 신규 이용을 즉시 중단합니다." />
        <div className="twobalanced">
          <div className="card">
            <Sec title="선택 동의" />
            {toggles.map(([id, title, sub]) => (
              <label className="toggle-row" key={id}>
                <span>
                  <strong>{title}</strong>
                  <small>{sub}</small>
                </span>
                <input type="checkbox" checked={!!model.consents[id]} onChange={(e) => setConsent(id, e.target.checked)} aria-label={title} />
              </label>
            ))}
            <Help>시안 내 스위치는 임시 상태입니다. 실제 서버는 목적별 동의·철회 이벤트와 문서 버전을 분리해 보관해야 합니다.</Help>
          </div>
          <div className="card">
            <Sec title="내 정보 권리 행사" />
            <Activity title="개인정보 열람" sub="내 계정 데이터 목록 및 처리 내역 요청" when="요청" icon="lock" />
            <Activity title="자료 정정 · 삭제 요청" sub="법정 보존·분쟁 기록은 예외 검토" when="요청" icon="file" />
            <Btn label="열람/반출 요청 시연" act="privacyRequest" variant="primary" />
            <Btn label="계정 삭제 요청 안내" act="deleteAccount" variant="danger" />
          </div>
        </div>
      </>
    );
  }

  // page === "home"
  return (
    <>
      <PageHead
        title="반갑습니다, 김회원님"
        sub="오늘 해야 할 일과 다음 사업 기회를 한눈에 확인하세요."
        actions={
          <>
            <Btn label="사업 소개 요청" act="newIntro" variant="primary" icon="plus" />
            <Btn label="이번 달 내역" act="period" />
          </>
        }
      />
      <section className="grid4">
        <Kpi label="다음 정기모임" value="10. 28" foot="수요일 · 오전 7:00" icon="calendar" />
        <Kpi label="승인 대기 소개" value={both ? "0" : "2"} foot="쌍방 동의 완료 후에만 연결" icon="link" tone="blue" />
        <Kpi label="이번 달 1:1" value="4회" foot="실제 참여 기록 기준" icon="people" tone="gold" />
        <Kpi label="유효 사업기회" value="3건" foot="합성 예시 데이터" icon="trend" />
      </section>
      <section className="two">
        <div className="card">
          <Sec title="나에게 필요한 다음 행동" more={<GoBtn to="referrals">전체 소개 →</GoBtn>} />
          <Activity title="새 기업 소개 요청을 확인하세요" sub="가상AI랩 / 서비스 공급 역량 확인 필요" when="오늘" icon="link" />
          <Activity title="정기모임 출석 여부를 알려주세요" sub="10월 28일 수요일 07:00 · 가상 비즈센터" when="D-4" icon="calendar" />
          <Activity title="지난 소개 결과를 기록하세요" sub="가상그린산업 · 다음 미팅 결과 미기록" when="어제" icon="file" />
        </div>
        <div className="card highlight">
          <div className="eyebrow" style={{ color: "#73ead9" }}>
            GROW YOUR BUSINESS
          </div>
          <h2>
            소개를 넘어,
            <br />
            실제 사업의 기회로.
          </h2>
          <p>내 수요와 공급을 정리하면 검토 가능한 파트너를 찾기 쉬워집니다. 소개는 항상 양측 동의를 따릅니다.</p>
          <Btn label="공개 기업 둘러보기" act="directory" icon="arrow" />
          <div className="hero-meta">
            <Icon name="shield" size={14} /> 연락처는 상호 승인 전 비공개
          </div>
        </div>
      </section>
      <section className="twobalanced">
        <div className="card">
          <Sec title="나의 활동 추세" more={<Pill>최근 6주 · 가상값</Pill>} />
          <Spark />
          <p className="tiny muted" style={{ margin: "10px 0 0" }}>
            최근 미팅·소개 참여 빈도, 개인의 실제 매출 아님
          </p>
        </div>
        <div className="card">
          <Sec title="예정된 모임" more={<GoBtn to="meetings">일정 보기 →</GoBtn>} />
          <div className="line">
            <div>
              <strong>10월 정기 챕터 미팅</strong>
              <div className="muted tiny">10.28 수요일 07:00 · 가상 비즈센터</div>
            </div>
            <Pill tone={model.meetingRsvp ? "green" : "amber"}>{model.meetingRsvp ? "참석 확정" : "응답 대기"}</Pill>
          </div>
          <div className="line">
            <div>
              <strong>1:1 사업 상담</strong>
              <div className="muted tiny">10.30 금요일 11:00 · 온라인</div>
            </div>
            <Pill tone="green">확정</Pill>
          </div>
        </div>
      </section>
    </>
  );
}
