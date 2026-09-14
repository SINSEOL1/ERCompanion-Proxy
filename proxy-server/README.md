# Eternal Return Open API Temporary Proxy v3.0.0

기존 ERCompanion 전용 Identity Proxy 대신, Eternal Return 공식 Open API의 **버전 경로 전체**를 중계하는 Vercel 프록시입니다.

실제 ER API 키는 Vercel 환경변수 `ER_OPEN_API_KEY`에만 보관합니다.  
지인에게는 `PROXY_ACCESS_TOKEN`만 전달하면 됩니다.

## 구조

```text
지인 프로그램
  -> Authorization: Bearer <PROXY_ACCESS_TOKEN>
  -> https://YOUR-PROJECT.vercel.app/er/v1/...
  -> Vercel이 ER_OPEN_API_KEY를 x-api-key로 추가
  -> https://open-api.bser.io/v1/...
```

대상 호스트는 코드에서 `https://open-api.bser.io`로 고정되어 있으므로 임의 사이트를 중계하는 오픈 프록시로 사용할 수 없습니다.

## Vercel 환경변수

필수:

```text
ER_OPEN_API_KEY=실제_이터널리턴_API키
PROXY_ACCESS_TOKEN=지인에게_줄_긴_랜덤토큰
```

권장:

```text
PROXY_EXPIRES_AT=2026-09-21T23:59:59+09:00
PROXY_RATE_LIMIT_PER_MINUTE=30
PROXY_ALLOWED_ORIGIN=*
PROXY_UPSTREAM_TIMEOUT_MS=8000
```

환경변수 변경 후에는 Redeploy 하세요.

## 호출 형식

공식 API가:

```text
https://open-api.bser.io/v2/data/hash
```

라면 프록시는:

```text
https://YOUR-PROJECT.vercel.app/er/v2/data/hash
```

입니다.

요청 헤더:

```text
Authorization: Bearer <PROXY_ACCESS_TOKEN>
```

실제 `x-api-key`는 클라이언트에서 보내지 않습니다.

### JavaScript

```js
const response = await fetch(
  'https://YOUR-PROJECT.vercel.app/er/v2/data/hash',
  {
    headers: {
      Authorization: 'Bearer YOUR_TEMP_TOKEN'
    }
  }
);

console.log(await response.json());
```

### Python

```python
import requests

url = "https://YOUR-PROJECT.vercel.app/er/v1/user/nickname"
params = {"query": "닉네임"}
headers = {"Authorization": "Bearer YOUR_TEMP_TOKEN"}

r = requests.get(url, params=params, headers=headers)
print(r.status_code, r.json())
```

### curl

```bash
curl "https://YOUR-PROJECT.vercel.app/er/v2/data/hash" \
  -H "Authorization: Bearer YOUR_TEMP_TOKEN"
```

## 사용할 수 있는 범위

프록시는 `v1/...`, `v2/...`처럼 **숫자 버전으로 시작하는 ER 공식 API 경로를 그대로 전달**합니다.

따라서 공식 API에 존재하는 다음 계열을 별도 코드 추가 없이 사용할 수 있습니다.

- 사용자 조회 / 경기 / 랭크 / 통계
- 랭킹
- 경기 상세
- 게임 데이터 테이블 (`/v2/data/{metaType}`)
- 언어 데이터 (`/v1/l10n/{language}`)
- 무기 루트
- 이후 공식 API에 추가되는 다른 `vN/...` 경로

## 예시

```text
GET /er/v1/user/nickname?query=닉네임
GET /er/v1/games/123456789
GET /er/v2/data/hash
GET /er/v2/data/Character
GET /er/v2/data/ItemWeapon
GET /er/v2/data/ItemArmor
GET /er/v1/l10n/Korean
GET /er/v1/weaponRoutes/recommend
```

## 상태 확인

```text
GET https://YOUR-PROJECT.vercel.app/
```

실제 API 키나 임시 토큰은 반환하지 않습니다.

## 보안상 중요한 점

1. `ER_OPEN_API_KEY`를 GitHub 코드나 `.env.example`에 실제 값으로 커밋하지 마세요.
2. 지인에게는 `PROXY_ACCESS_TOKEN`만 전달하세요.
3. 대여 종료 시 `PROXY_ACCESS_TOKEN`을 변경하거나 `PROXY_EXPIRES_AT`을 지난 시각으로 바꾼 뒤 Redeploy 하면 됩니다.
4. 브라우저 프론트엔드 코드에 임시 토큰을 넣으면 그 토큰은 사용자에게 노출될 수 있습니다. 가능하면 서버/봇에서 호출하세요.
5. `PROXY_RATE_LIMIT_PER_MINUTE`는 Vercel 인스턴스 메모리 기준의 보조 제한입니다. 여러 서버리스 인스턴스에 걸친 완전한 전역 제한은 아닙니다.
6. 실제 ER Open API의 자체 Rate Limit은 그대로 적용됩니다.
