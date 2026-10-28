"use client";
// U-C01~06 · 챕터 운영자 대시보드 — ported from prototype chapter views. FR-002/005/007/008/009/011/013/014.
import type { ReactNode } from "react";
import { Activity, Bar, Btn, GoBtn, Help, Kpi, PageHead, Pill, Sec, Spark, Table, useSuite } from "../ctx";

export function ChapterView({ page }: { page: string }) {
  const { model } = useSuite();
  const pending = model.members.filter((m) => m.status === "대기").length;

  if (page === "members") {
    const rows: ReactNode[][] = model.members.map((x) => [
      x.name,
      x.industry,
      x.date,
      <Pill key="s" tone={x.status === "대기" ? "amber" : "green"}>
        {x.status}
      </Pill>,
      x.status === "대기" ? (
        <span key="a">
          <Btn label="승인" act={`approveMember:${x.id}`} variant="primary" /> <Btn label="거절" act={`rejectMember:${x.id}`} />
        </span>
      ) : (
        <Btn key="a" label="상세" act={`memberDetail:${x.id}`} />
      ),
    ]);
    return (
      <>
        <PageHead title="회원 · 승인 심사" sub="가입 승인과 역할 변경은 제한된 관리자 권한으로 처리합니다." actions={<Btn label="회원 초대" act="newInvite" variant="primary" icon="plus" />} />
        <div className="grid3">
          <Kpi label="활성 회원" value="38" foot="기존 합성 회원 데이터" icon="people" />
          <Kpi label="신청·심사" value={pending} foot="현재 브라우저 시연 상태" icon="clock" tone="gold" />
          <Kpi label="활성 업종" value="26" foot="업종 독점은 정책에 따라" icon="layers" tone="blue" />
        </div>
        <div className="card">
          <Sec title="회원 심사 · 명단" more={<Pill tone="blue">심사 담당자 전용</Pill>} />
          <Table heads={["회원", "분류 업종", "신청/승인일", "상태", "작업"]} rows={rows} />
          <Help>승인 전에는 분류 중복, 소개·광고 동의 분리, 회원 진위 확인과 정책 충돌 여부를 검토합니다. 저장은 데모 브라우저 메모리에만 반영됩니다.</Help>
        </div>
      </>
    );
  }

  if (page === "meetings") {
    const days = ["일", "월", "화", "수", "목", "금", "토"];
    return (
      <>
        <PageHead title="모임 · 출석 운영" sub="정기모임을 생성하고 참석자·방문자·결석정정을 관리합니다." actions={<Btn label="모임 추가 시연" act="newEvent" variant="primary" icon="plus" />} />
        <section className="twobalanced">
          <div className="card">
            <Sec title="10월 2026 · 모임 달력" />
            <div className="mini-calendar">
              {days.map((x) => (
                <span key={x} style={{ background: "#f4f7fa", fontWeight: 850 }}>
                  {x}
                </span>
              ))}
              {Array.from({ length: 35 }, (_, i) => {
                const d = i - 3;
                const cls = d === 28 ? "selected" : d === 7 || d === 14 || d === 21 ? "has-event" : "";
                return (
                  <span key={i} className={cls}>
                    {d > 0 && d <= 31 ? d : ""}
                  </span>
                );
              })}
            </div>
            <div className="tiny muted" style={{ marginTop: 13 }}>
              매주 수요일 모임 · Asia/Seoul
            </div>
          </div>
          <div className="card">
            <Sec title="다음 모임 준비" />
            <div className="line">
              <span>일정</span>
              <strong>10.28 수 07:00</strong>
            </div>
            <div className="line">
              <span>장소</span>
              <strong>가상 비즈센터 3층</strong>
            </div>
            <div className="line">
              <span>참석 확정</span>
              <strong>29명</strong>
            </div>
            <div className="line">
              <span>방문자</span>
              <strong>3명</strong>
            </div>
            <div className="line">
              <span>발표 자료 미제출</span>
              <Pill tone="amber">4명</Pill>
            </div>
            <Btn label="체크인 화면 보기" act="checkIn" variant="primary" />
          </div>
        </section>
        <Help>출석 정정에는 사유·처리자·수정 시간이 남아야 하며 이미 종료한 모임은 기록을 직접 덮어쓰면 안 됩니다.</Help>
      </>
    );
  }

  if (page === "referrals") {
    const rows: ReactNode[][] = [
      ["제조 품질 검사", "가상그린산업 ↔ 가상AI랩", <Pill key="s" tone="blue">미팅 완료</Pill>, "10.26", <Btn key="a" label={model.followupDone ? "검토 완료" : "결과 확인"} act="finishFollowup" variant={model.followupDone ? "" : "primary"} />],
      ["수출 상담", "가상무역파트너 ↔ 가상그린산업", <Pill key="s" tone="green">상호 승인</Pill>, "10.29", <Btn key="a" label="상세 시연" act="introDetail" />],
      ["브랜드 컨설팅", "가상브랜드스튜디오 ↔ 가상AI랩", <Pill key="s" tone="amber">승인 대기</Pill>, "11.02", <Btn key="a" label="승인 안내" act="introDetail" />],
    ];
    return (
      <>
        <PageHead title="소개 · 후속관리 데스크" sub="대기 소개부터 미팅 확인, 유효 사업기회 전환까지 추적합니다." actions={<Btn label="기록 등록" act="newIntro" variant="primary" icon="plus" />} />
        <section className="grid4">
          <Kpi label="소개 제안" value="19" foot="회원 등록 · 가상값" icon="link" />
          <Kpi label="양측 승인" value="11" foot="연락 공개 단계" icon="check" tone="blue" />
          <Kpi label="미팅 확정" value="9" foot="상대 연결 이후" icon="calendar" tone="gold" />
          <Kpi label="유효 사업기회" value="7" foot="MQO 검증" icon="trend" />
        </section>
        <div className="card">
          <Sec title="후속 처리 목록" />
          <Table heads={["사업기회", "연결 당사자", "단계", "기한", "처리"]} rows={rows} />
        </div>
      </>
    );
  }

  if (page === "visitors") {
    const rows: ReactNode[][] = [
      ["가상 게스트 A", "김회원 소개", "10.28", <Pill key="s" tone="green">방문확정</Pill>, <Btn key="a" label="후속 시연" act="visitorFollowup" />],
      ["가상 게스트 B", "온라인 신청", "10.28", <Pill key="s" tone="amber">등록대기</Pill>, <Btn key="a" label="상세" act="visitorFollowup" />],
      ["가상 게스트 C", "가상기업 초대", "10.28", <Pill key="s" tone="blue">{model.visitorStatus === "미발송" ? "초대미발송" : "초대 시연 완료"}</Pill>, <Btn key="a" label="초대 안내" act="newVisitor" />],
    ];
    return (
      <>
        <PageHead title="방문자 · 게스트 운영" sub="방문 신청은 회원 가입이나 광고 수신 동의를 자동으로 생성하지 않습니다." actions={<Btn label="방문자 초대" act="newVisitor" variant="primary" icon="plus" />} />
        <div className="grid3">
          <Kpi label="다음 방문 예정" value="3명" foot="10월 28일 모임" icon="people" />
          <Kpi label="방문 신청서" value="2건" foot="직접 작성 대기" icon="file" tone="gold" />
          <Kpi label="가입 관심" value="1명" foot="자발적 가입 의사 확인" icon="trend" tone="blue" />
        </div>
        <div className="card">
          <Sec title="모임 방문자 현황" />
          <Table heads={["가상 방문자", "초대 출처", "예정 모임", "신청 상태", "업무"]} rows={rows} />
        </div>
      </>
    );
  }

  if (page === "reports") {
    return (
      <>
        <PageHead title="챕터 성과 분석" sub="자진신고·검증된 성과를 분리하고 개인정보 최소화 정책을 따릅니다." actions={<Btn label="CSV 시연 내보내기" act="export" variant="primary" icon="download" />} />
        <div className="grid4">
          <Kpi label="모임 횟수" value="4회" foot="10월 가상 기록" icon="calendar" />
          <Kpi label="출석률" value="87%" foot="출석 대상 / 실제" icon="check" tone="blue" />
          <Kpi label="유효 연결" value="7건" foot="MQO 정의 충족" icon="link" />
          <Kpi label="보고된 수주" value="2건" foot="자진신고 · 검증 미완료" icon="trend" tone="gold" />
        </div>
        <div className="two">
          <div className="card">
            <Sec title="활동 추이" />
            <Spark />
            <Bar label="출석 유지율" value={87} num="87%" />
            <Bar label="쌍방 승인율" value={58} num="58%" />
          </div>
          <div className="card">
            <Sec title="금액 증빙 수준" />
            <div className="stat-pair">
              <div className="number-box">
                <span className="tiny muted">자진신고 금액</span>
                <strong>₩2,000만</strong>
              </div>
              <div className="number-box">
                <span className="tiny muted">문서확인 금액</span>
                <strong>₩600만</strong>
              </div>
            </div>
            <p className="tiny muted">모두 합성 예시이며 플랫폼의 수익으로 집계할 수 없습니다.</p>
            <Help>5인 미만 소그룹 집계 시 개인 재식별을 방지하기 위해 항목을 숨기거나 합산해야 합니다.</Help>
          </div>
        </div>
      </>
    );
  }

  // page === "home"
  const scheduleRows: ReactNode[][] = [
    ["10.28 정기모임", "29 / 38명", "3명", <Pill key="s" tone="green">진행 준비</Pill>, <Btn key="a" label="출석 관리" act="meetings" />],
    ["11.04 교류 세미나", "18 / 38명", "2명", <Pill key="s" tone="amber">RSVP 진행</Pill>, <Btn key="a" label="상세" act="meetings" />],
  ];
  return (
    <>
      <PageHead
        title="챕터 운영 현황"
        sub="가상 서울비즈 챕터 · 회원·모임·소개·후속업무를 하나의 화면에서."
        actions={
          <>
            <Btn label="다음 모임 관리" act="meetings" variant="primary" icon="calendar" />
            <Btn label="초대 링크" act="newInvite" />
          </>
        }
      />
      <div className="grid4">
        <Kpi label="활성 회원" value="38명" foot="권한있는 챕터 인원" icon="people" />
        <Kpi label="승인 대기" value={`${pending}건`} foot="검토 담당자 확인 필요" icon="clock" tone="gold" />
        <Kpi label="이번 달 출석률" value="87%" foot="실제 참석/대상 회원" icon="check" tone="blue" />
        <Kpi label="유효 소개 기회" value="7건" foot="실제 연결·후속 기록" icon="link" />
      </div>
      <section className="two">
        <div className="card">
          <Sec title="운영자가 처리할 업무" more={<GoBtn to="members">회원 심사 →</GoBtn>} />
          <Activity title={`가입 대기 회원 ${pending}명`} sub="업종·기존 회원 충돌 확인 후 승인" when="오늘" icon="people" />
          <Activity title="10월 28일 정기모임 체크리스트" sub="방문자 명단·발표 순서·장소 최종 점검" when="D-4" icon="calendar" />
          <Activity title="지난 소개 후속 확인 3건" sub="미팅 여부와 사업기회 전환 검토" when="이번 주" icon="link" />
        </div>
        <div className="card">
          <Sec title="주요 활동 전환율" />
          <Bar label="소개 제안 → 상호 승인" value={58} num="11 / 19" />
          <Bar label="상호 승인 → 실제 미팅" value={82} num="9 / 11" />
          <Bar label="실제 미팅 → 유효 기회" value={78} num="7 / 9" />
          <Bar label="유효 기회 → 계약 자진신고" value={29} num="2 / 7" />
          <p className="tiny muted">자진신고 실적은 플랫폼 매출이나 검증된 거래금액을 뜻하지 않습니다.</p>
        </div>
      </section>
      <div className="card">
        <Sec title="다가오는 챕터 일정" more={<GoBtn to="meetings">일정 관리 →</GoBtn>} />
        <Table heads={["일정", "참석 예정", "방문자", "준비 상태", "동작"]} rows={scheduleRows} />
      </div>
    </>
  );
}
