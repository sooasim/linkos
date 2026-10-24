// P-182 헬스체크가 보고하는 빌드 식별자.
//
// 왜 필요한가: 배포 뒤 "머지한 내용이 실제로 떴는가"를 화면 눈대중으로 확인할 수 없는 변경(보안 수정 등)이 있다.
// 짧은 커밋 SHA 는 비밀이 아니고(배포 아티팩트 식별자) 롤백·장애 대응에서 가장 먼저 필요한 값이다.

export function buildInfo(): { version: string; revision: string | null } {
  const sha =
    process.env.APP_REVISION ?? // 배포 스크립트가 주입 (infra/deploy)
    process.env.GITHUB_SHA ??
    null;
  return { version: process.env.APP_VERSION ?? "1.0.0", revision: sha ? sha.slice(0, 7) : null };
}
