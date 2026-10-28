"use client";
// U-T01~06 · 기관 관리자 대시보드 — ported from prototype tenant views. FR-004/014/015/019/103/107.
import type { ReactNode } from "react";
import { Activity, Bar, Btn, GoBtn, Help, Kpi, PageHead, Pill, Sec, Table } from "../ctx";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input value={value} readOnly />
    </div>
  );
}

export function TenantView({ page }: { page: string }) {
  if (page === "chapters") {
    const rows: ReactNode[][] = [
      ["서울비즈", "서울", "38명", "수 07:00", <Pill key="s" tone="green">운영 중</Pill>, "가상 운영자 A"],
      ["강남성장", "서울", "45명", "화 07:30", <Pill key="s" tone="green">운영 중</Pill>, "가상 운영자 B"],
      ["경기산업", "경기", "51명", "목 08:00", <Pill key="s" tone="green">운영 중</Pill>, "가상 운영자 C"],
      ["부산커넥트", "부산", "79명", "수 07:30", <Pill key="s" tone="green">운영 중</Pill>, "가상 운영자 D"],
      ["대전미래", "대전", "0명", "미정", <Pill key="s" tone="amber">개설 준비</Pill>, "지정 대기"],
    ];
    return (
      <>
        <PageHead title="챕터 운영 현황" sub="운영기관 내 여러 챕터를 관리합니다. 개인 메모는 집계 권한으로도 조회할 수 없습니다." actions={<Btn label="새 챕터 개설" act="addChapter" variant="primary" icon="plus" />} />
        <div className="card">
          <Sec title="챕터 현황" />
          <Table heads={["챕터명", "지역", "회원수", "모임 주기", "운영상태", "담당"]} rows={rows} />
        </div>
      </>
    );
  }

  if (page === "billing") {
    const rows: ReactNode[][] = [
      ["2026.10", "₩790,000", <Pill key="s" tone="blue">가상 예시</Pill>],
      ["2026.09", "₩790,000", <Pill key="s" tone="blue">가상 예시</Pill>],
      ["2026.08", "₩790,000", <Pill key="s" tone="blue">가상 예시</Pill>],
    ];
    return (
      <>
        <PageHead title="구독 · 청구 관리" sub="계약된 플랫폼 사용료와 회원의 외부 거래금액을 분리합니다." actions={<Btn label="요금 변경 요청" act="changePlan" variant="primary" />} />
        <div className="twobalanced">
          <div className="card">
            <Sec title="현재 구독" more={<Pill tone="amber">시안 결제 · 미연동</Pill>} />
            <div className="eyebrow">NETWORK PRO</div>
            <div className="kpi-value">
              ₩790,000 <span className="tiny muted">/월 · VAT 별도</span>
            </div>
            <p className="tiny muted">최대 5개 챕터 지원 · 차회 청구일 2026.11.24</p>
            <Bar label="챕터 이용량" value={100} num="5 / 5" />
            <Bar label="회원 수 가이드" value={43} num="213 / 500" />
            <Btn label="결제수단 관리 시연" act="paymentMethod" />
          </div>
          <div className="card">
            <Sec title="청구 내역" />
            <Table heads={["기간", "금액", "상태"]} rows={rows} />
            <Help>실제 서비스에서는 PG의 결제 페이지로 이동해 카드정보를 위탁 처리하고 서버에는 카드번호를 저장하지 않습니다.</Help>
          </div>
        </div>
      </>
    );
  }

  if (page === "policies") {
    const rules: [string, string][] = [
      ["챕터별 업종 1명 독점", "선택 정책 · 승인 충돌 검사"],
      ["외부 챕터 간 탐색", "기관간 별도 협약 및 기업별 동의"],
      ["운영자 MFA 필수", "보안 역할은 반드시 강제"],
      ["회원별 실적 순위", "추가 동의 전 비활성"],
    ];
    return (
      <>
        <PageHead title="운영 정책 · 권한" sub="챕터 공통 정책, 업종 독점 여부, 운영진 위임 권한을 관리합니다." actions={<Btn label="정책 변경 검토" act="policyChange" variant="primary" icon="shield" />} />
        <div className="twobalanced">
          <div className="card">
            <Sec title="운영 정책 설정" />
            {rules.map(([a, b], i) => (
              <div className="toggle-row" key={a}>
                <span>
                  <strong>{a}</strong>
                  <small>{b}</small>
                </span>
                <Pill tone={i === 2 ? "green" : "amber"}>{i === 2 ? "필수" : i === 3 ? "비활성" : "검토 후 적용"}</Pill>
              </div>
            ))}
          </div>
          <div className="card">
            <Sec title="권한 위임 원칙" />
            <Activity title="운영기관 관리자" sub="챕터·요금·공통 정책 관리" when="상한" icon="shield" />
            <Activity title="챕터 운영자" sub="지정 챕터의 출석·회원 승인" when="챕터" icon="people" />
            <Activity title="기업 담당자" sub="자사 정보·소개 승인만 가능" when="자사" icon="building" />
            <Help>기관 관리자라도 타기업 개인 연락처, 회원 개인 1:1 메모, 승인 전 소개 연락처는 임의로 조회할 수 없습니다.</Help>
          </div>
        </div>
      </>
    );
  }

  if (page === "branding") {
    return (
      <>
        <PageHead title="화이트라벨 · 브랜드 설정" sub="전용 로고, 컬러, 도메인은 권리 승인과 DNS 검증 후 활성화합니다." actions={<Btn label="브랜드 적용 시연" act="brandPreview" variant="primary" />} />
        <div className="twobalanced">
          <div className="card">
            <Sec title="운영기관 브랜드" />
            <Field label="조직 공개명" value="가상 한국사업가연합" />
            <Field label="커뮤니티 기본 도메인" value="demo.linkos.example.invalid" />
            <Field label="기본 액센트 색상" value="#087F77" />
            <Pill tone="amber">도메인·브랜드 소유 확인 필요</Pill>
          </div>
          <div className="card">
            <Sec title="적용 범위 미리보기" />
            <div style={{ padding: 25, borderRadius: 13, background: "#163249", color: "white" }}>
              <div style={{ fontSize: 22, fontWeight: 900 }}>▰ 가상 한국사업가연합</div>
              <p style={{ fontSize: 12, color: "#c5dcdd" }}>커뮤니티 대시보드 · 브랜드 예시</p>
              <div style={{ borderRadius: 9, padding: 12, background: "#087f77", width: "max-content", fontSize: 12 }}>챕터 가입 신청</div>
            </div>
            <Help>BNI 로고 및 공식 명칭은 정당한 사용권과 계약 범위가 확인되지 않으면 등록·배포하지 않습니다.</Help>
          </div>
        </div>
      </>
    );
  }

  if (page === "insights") {
    return (
      <>
        <PageHead title="기관 통합 성과" sub="챕터별 집계만 비교하며 개인별 관계·연락처는 노출하지 않습니다." actions={<Btn label="집계 데이터 내보내기" act="export" variant="primary" icon="download" />} />
        <div className="grid4">
          <Kpi label="챕터 활성화율" value="80%" foot="4 / 5개 운영중" icon="layers" />
          <Kpi label="회원 활동률" value="74%" foot="가상 집계" icon="people" tone="blue" />
          <Kpi label="이번 달 MQO" value="42건" foot="중복 제거 후 합계" icon="link" />
          <Kpi label="이탈 위험 챕터" value="1개" foot="정해진 정책·단순 신호" icon="warning" tone="gold" />
        </div>
        <div className="twobalanced">
          <div className="card">
            <Sec title="챕터별 출석률" />
            <Bar label="서울비즈" value={87} num="87%" />
            <Bar label="강남성장" value={82} num="82%" />
            <Bar label="경기산업" value={78} num="78%" />
            <Bar label="부산커넥트" value={89} num="89%" />
          </div>
          <div className="card">
            <Sec title="활성화 추천" />
            <Activity title="대전미래 오픈 지원" sub="운영자 지정과 첫 모임 개설 지원" when="우선" icon="layers" />
            <Activity title="경기산업 출석 이탈 신호" sub="지난 4주 평균 추세 비교" when="관찰" icon="chart" />
            <Activity title="재가입 추천 대상" sub="동의된 모임 공지만 송신" when="준법" icon="shield" />
          </div>
        </div>
      </>
    );
  }

  // page === "home"
  const summaryRows: ReactNode[][] = [
    ["서울비즈", "38", "87%", <Pill key="s" tone="green">운영 중</Pill>],
    ["강남성장", "45", "82%", <Pill key="s" tone="green">운영 중</Pill>],
    ["경기산업", "51", "78%", <Pill key="s" tone="green">운영 중</Pill>],
    ["부산커넥트", "79", "89%", <Pill key="s" tone="green">운영 중</Pill>],
    ["대전미래", "0", "-", <Pill key="s" tone="amber">개설 준비</Pill>],
  ];
  return (
    <>
      <PageHead title="기관 관리 대시보드" sub="가상 한국사업가연합 · 운영기관 단위 활성화, 청구, 회원 성과." actions={<Btn label="챕터 추가" act="addChapter" variant="primary" icon="plus" />} />
      <div className="grid4">
        <Kpi label="운영 챕터" value="5개" foot="활성 4개 · 준비 중 1개" icon="layers" />
        <Kpi label="활성 회원" value="213명" foot="가상 집계 · 식별정보 없음" icon="people" tone="blue" />
        <Kpi label="월 구독료" value="₩790,000" foot="예시 요금 / 부가세 별도" icon="credit" tone="gold" />
        <Kpi label="유효 연결" value="42건" foot="월간 MQO · 집계" icon="link" />
      </div>
      <div className="two">
        <div className="card">
          <Sec title="챕터별 운영 요약" more={<GoBtn to="chapters">전체 챕터 →</GoBtn>} />
          <Table heads={["챕터", "회원", "출석률", "상태"]} rows={summaryRows} />
        </div>
        <div className="card">
          <Sec title="계약 · 결제 요약" />
          <div className="line">
            <span>이용중 상품</span>
            <strong>Network Pro</strong>
          </div>
          <div className="line">
            <span>다음 결제</span>
            <strong>2026.11.24</strong>
          </div>
          <div className="line">
            <span>자동 결제</span>
            <Pill tone="amber">가상 계약·미연동</Pill>
          </div>
          <div className="line">
            <span>이번 달 사용현황</span>
            <strong>5개 챕터 / 213명</strong>
          </div>
          <Btn label="청구 상세 보기" act="billing" variant="primary" />
        </div>
      </div>
    </>
  );
}
