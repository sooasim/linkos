"use client";
// U-P01~06 · 플랫폼 관리자 콘솔 — ported from prototype platform views. FR-001/015/016/019, NFR-01/02/04/05/06/07.
import type { ReactNode } from "react";
import { Activity, Bar, Btn, Help, Kpi, PageHead, Pill, Sec, Table } from "../ctx";

export function PlatformView({ page }: { page: string }) {
  if (page === "tenants") {
    const rows: ReactNode[][] = [
      ["한국사업가연합", "Network Pro", "5", <Pill key="s" tone="green">활성</Pill>, <Btn key="a" label="계약정보" act="tenantMeta" />],
      ["서울창업네트워크", "Growth", "2", <Pill key="s" tone="green">활성</Pill>, <Btn key="a" label="계약정보" act="tenantMeta" />],
      ["경기산업포럼", "Starter", "1", <Pill key="s" tone="amber">청구대기</Pill>, <Btn key="a" label="계약정보" act="tenantMeta" />],
      ["가상 협회 A", "미정", "0", <Pill key="s" tone="amber">승인대기</Pill>, <Btn key="a" label="심사" act="tenantRequest" />],
    ];
    return (
      <>
        <PageHead title="운영기관 계약 관리" sub="기관 상태, 요금제, 지원 담당자 중심의 최소한의 계약 메타정보만 표시합니다." actions={<Btn label="기관 신규 요청 검토" act="tenantRequest" variant="primary" icon="plus" />} />
        <div className="card">
          <Sec title="기관 관리 목록" />
          <Table heads={["가상 운영기관", "요금제", "챕터", "상태", "처리"]} rows={rows} />
        </div>
      </>
    );
  }

  if (page === "support") {
    const rows: ReactNode[][] = [
      ["TKT-DEMO-104", "접근 오류", "기관 관리 화면 403", "긴급", <Pill key="s" tone="amber">담당 지정</Pill>],
      ["TKT-DEMO-103", "청구 문의", "청구 상태 동기화", "일반", <Pill key="s" tone="blue">진행 중</Pill>],
      ["TKT-DEMO-102", "신고 검토", "회사 프로필 공개 범위", "높음", <Pill key="s" tone="amber">보류 검토</Pill>],
    ];
    return (
      <>
        <PageHead title="지원 · 신고 티켓" sub="신고 접수, 담당자, 승인 범위, 해결 단계를 추적합니다." actions={<Btn label="새 지원 티켓 시연" act="newTicket" variant="primary" icon="plus" />} />
        <div className="grid3">
          <Kpi label="미해결" value="4" foot="지원 티켓 메타만" icon="message" />
          <Kpi label="긴급" value="1" foot="보안/개인정보 관련" icon="warning" tone="gold" />
          <Kpi label="SLA 관심" value="1" foot="응답 지연 임계" icon="clock" tone="blue" />
        </div>
        <div className="card">
          <Sec title="지원 대기열" />
          <Table heads={["티켓번호", "분류", "업무 메타 정보", "우선순위", "상태"]} rows={rows} />
        </div>
      </>
    );
  }

  if (page === "security") {
    const rows: ReactNode[][] = [
      ["10.24 10:22", "tenant.read.denied", "다른 tenant 접근", <Pill key="s" tone="red">차단</Pill>, "DEMO-A31"],
      ["10.24 09:58", "role.update", "운영 권한 변경", <Pill key="s" tone="green">기록</Pill>, "DEMO-A30"],
      ["10.24 09:11", "privacy.request.created", "본인 권리요청", <Pill key="s" tone="blue">접수</Pill>, "DEMO-A28"],
    ];
    return (
      <>
        <PageHead title="보안 · 감사 이벤트" sub="허가된 보안 메타데이터만 보여주며 본문·개인 연락처는 노출하지 않습니다." actions={<Btn label="긴급 접근 절차" act="breakGlass" variant="danger" icon="lock" />} />
        <div className="grid3">
          <Kpi label="거부된 권한 요청" value="12" foot="집계값 · 모의 로그" icon="shield" />
          <Kpi label="열린 고위험 알림" value="1" foot="보안 책임자 검토" icon="warning" tone="gold" />
          <Kpi label="운영자 MFA" value="적용 목표" foot="실제 인증상태 연동 필요" icon="lock" tone="blue" />
        </div>
        <div className="card">
          <Sec title="최근 감사 이벤트 · 합성 사례" />
          <Table heads={["시간", "이벤트 코드", "대상 범위", "결과", "추적 ID"]} rows={rows} />
          <Help>실제 화면에는 숨겨진 개인정보 원문을 복원할 수 있는 필드와 원본 요청 body를 절대 저장·출력하지 않습니다.</Help>
        </div>
      </>
    );
  }

  if (page === "health") {
    const deps = ["웹 프론트엔드 → 인증 게이트", "BFF/API → PostgreSQL", "Outbox/Queue → 알림 전송", "AI 워커 → 외부 LLM (선택)"];
    return (
      <>
        <PageHead title="서비스 상태 · 운영 지표" sub="배포 후 연결할 모니터링 대시보드의 정적 레이아웃입니다." actions={<Btn label="점검 Runbook" act="runbook" variant="primary" icon="file" />} />
        <div className="grid4">
          <Kpi label="API 지연 SLO" value="p95 500ms" foot="목표값 · 측정결과 아님" icon="clock" />
          <Kpi label="초기 가용성" value="99.5%" foot="목표 가동률 · 가상" icon="server" tone="blue" />
          <Kpi label="백업 RPO" value="≤24시간" foot="초기 제안 기준" icon="file" tone="gold" />
          <Kpi label="복구 RTO" value="≤8시간" foot="실제 복구 훈련 필요" icon="shield" />
        </div>
        <div className="twobalanced">
          <div className="card">
            <Sec title="의존성 맵" />
            {deps.map((x) => (
              <div className="line" key={x}>
                <strong>{x}</strong>
                <Pill tone="blue">연동 예정</Pill>
              </div>
            ))}
          </div>
          <div className="card">
            <Sec title="장애 대응 단계" />
            <Activity title="1. 감지·분류" sub="프로메테우스 등 감시 통합" when="5분" icon="warning" />
            <Activity title="2. 고객 영향 축소" sub="AI 기능 장애시 운영 기능 유지" when="대응" icon="shield" />
            <Activity title="3. 복구·사후 보고" sub="로그, 데이터 정합성·재발방지" when="기록" icon="file" />
          </div>
        </div>
      </>
    );
  }

  if (page === "releases") {
    const rows: ReactNode[][] = [
      ["G1", "컴포넌트·레이아웃 UI 수용", "검토 중", <Pill key="s" tone="amber">디자인 리뷰</Pill>],
      ["G2", "권한·RLS/IDOR 자동 테스트", "계획", <Pill key="s" tone="blue">필수</Pill>],
      ["G3", "접근성·모바일 키보드", "계획", <Pill key="s" tone="blue">필수</Pill>],
      ["G4", "보안·개인정보/감사 로그", "계획", <Pill key="s" tone="blue">필수</Pill>],
      ["G5", "백업 복구·롤백 리허설", "계획", <Pill key="s" tone="blue">필수</Pill>],
    ];
    return (
      <>
        <PageHead title="배포 · 변경 승인" sub="배포 체크리스트와 롤백 절차는 확인 가능한 근거로 관리합니다." actions={<Btn label="릴리즈 점검" act="releaseCheck" variant="primary" icon="check" />} />
        <div className="card">
          <Sec title="릴리즈 게이트" />
          <Table heads={["단계", "필수 검증", "상태", "비고"]} rows={rows} />
          <Help>UI 시연이나 PDF 문서 완성만으로 실제 서비스의 보안·성능·인수 테스트 완료를 의미하지 않습니다.</Help>
        </div>
      </>
    );
  }

  // page === "home"
  return (
    <>
      <PageHead title="플랫폼 운영 개요" sub="테넌트 계약·품질·보안을 감독하되 회원 비공개 업무 내용은 기본 열람하지 않습니다." actions={<Btn label="지원 티켓" act="support" variant="primary" icon="message" />} />
      <div className="grid4">
        <Kpi label="운영기관" value="27개" foot="실제 계약 수 아님 · 가상값" icon="building" />
        <Kpi label="활성 챕터" value="109개" foot="기관별 합산" icon="layers" tone="blue" />
        <Kpi label="처리 대기 티켓" value="4건" foot="권한 격리·업무 범위" icon="message" tone="gold" />
        <Kpi label="서비스 목표" value="99.5%" foot="제안 목표 · 실제 가동률 아님" icon="server" />
      </div>
      <div className="two">
        <div className="card">
          <Sec title="서비스 운영 상태" more={<Pill tone="blue">시뮬레이션 화면</Pill>} />
          <Activity title="인증 서비스" sub="모의 상태 정상 · 실제 상태 조회 아님" when="정상" icon="shield" />
          <Activity title="API / 앱 서버" sub="모의 상태 정상 · 모니터링 연동 필요" when="정상" icon="server" />
          <Activity title="AI 추천 워커" sub="선택 서비스 · 장애 시 핵심 운영 기능 유지" when="선택" icon="spark" />
          <Activity title="청구 웹훅" sub="모의 처리 대기 0건" when="0건" icon="credit" />
        </div>
        <div className="card">
          <Sec title="플랫폼 보안 가드레일" />
          <Bar label="운영자 MFA 적용 목표" value={100} num="100%" />
          <Bar label="테넌트 격리 테스트 목표" value={100} num="100%" />
          <Bar label="배포 승인 체크리스트" value={75} num="3 / 4" />
          <Help>플랫폼 최고관리자도 임의의 고객사 연락처·대화·회사 계약서 내용을 열람할 수 없습니다. 긴급 접근은 2인 승인 + 만료 + 감사가 필수입니다.</Help>
        </div>
      </div>
    </>
  );
}
