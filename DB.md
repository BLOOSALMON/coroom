# DB.md — coroom Supabase 스키마

> coroom은 기존 `coban` Supabase 프로젝트(무료 플랜 활성 프로젝트 2개 한도로 인해 별도 프로젝트를 새로 만들지 않고 기존 프로젝트에 테이블만 추가함)에 `rooms`, `reservations` 테이블을 추가하는 방식으로 구현되었다. 프로젝트 내 다른 테이블(`profiles`, `projects`, `cards` 등)은 coban 서비스 소유이며 coroom과 무관하다.

## 접속 정보

| 항목 | 값 |
|---|---|
| Project ID | `nhhoffcpgbpmnzyqjjnm` |
| Project URL | `https://nhhoffcpgbpmnzyqjjnm.supabase.co` |
| Publishable key (신규, 권장) | `sb_publishable_ARq6dFA9PUnyHCy3PIDtHA_IhRVXYm-` |
| anon key (레거시 JWT, 호환용) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5oaG9mZmNwZ2JwbW56eXFqam5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4ODgzNzAsImV4cCI6MjA5OTQ2NDM3MH0.UnDSLI55hHaX7zc2BdyPK2T8nkuXxg3ITHFtAToDWOg` |

프론트엔드(Supabase JS client)에서는 위 URL + publishable key(또는 anon key)로 클라이언트를 초기화한다. 인증(로그인)은 MVP 범위 밖이므로 `anon` role 기준으로 아래 RLS 정책이 열려 있다.

## 테이블

### `public.rooms`

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | int (PK) | 회의실번호 (1~6) |
| name | text | 회의실명 |
| capacity | int | 수용인원 |
| floor | text | 층 |
| equipment | text | 보유장비 (콤마 구분 문자열) |
| notes | text | 비고 (nullable) |

시드 데이터 6건 삽입 완료 (1~6번 회의실, PRD.md 참고).

### `public.reservations`

| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid (PK, default `gen_random_uuid()`) | 예약 ID |
| room_id | int (FK → rooms.id) | 예약 회의실 |
| reserver_name | text | 예약자 |
| department | text | 부서 |
| title | text | 회의 제목 |
| reservation_date | date | 예약일자 |
| start_time | time | 시작시간 |
| end_time | time | 종료시간 |
| status | enum `reservation_status` (`'확정'` \| `'취소'`) | 예약 상태, default `'확정'` |
| created_at | timestamptz (default `now()`) | 생성 시각 |

제약조건: `check (end_time > start_time)`. `(room_id, reservation_date)`에 인덱스 존재.

시드 데이터 25건 삽입 완료 (기존 엑셀 예약현황 시트 기준).

**중요 — 중복 예약(더블부킹) 검증은 DB 제약이 아닌 애플리케이션 레벨에서 수행한다.**
당초 PRD는 DB 트리거/EXCLUDE 제약을 고려했으나, 마이그레이션 대상 실데이터에 이미 겹치는 확정 예약이 존재해(3번 회의실, 2026-07-13, 16:00–18:00 및 16:00–17:00 두 건 모두 `확정`) DB 레벨 EXCLUDE 제약을 걸 수 없었다. 따라서:
- 새 예약을 저장(insert)하기 전, 프론트엔드에서 동일 `room_id` + `reservation_date`의 `status = '확정'` 예약들과 시간이 겹치는지 먼저 SELECT로 조회해 검증한 뒤 insert할 것.
- 동시 클릭으로 인한 레이스 컨디션은 MVP에서는 완전히 차단하지 못함(향후 Postgres 함수/트리거로 보완 가능). 저장 실패 시 사용자에게 "이미 예약된 시간대"라고 안내하는 정도로 충분.

## RLS 정책

`rooms`, `reservations` 모두 RLS 활성화 상태이며, 인증 없이 `anon` role이 전체 CRUD(읽기/예약 생성/예약 상태 변경)를 할 수 있도록 열려 있다 (MVP는 로그인 기능이 없으므로).

- `rooms`: `select` 공개 허용 (관리자 화면 없음, 앱에서 수정 불필요)
- `reservations`: `select`, `insert`, `update` 공개 허용 (취소는 `status`를 `'취소'`로 update)
- `delete`는 허용하지 않음 (취소는 상태 변경으로 처리, 하드 삭제 없음)

## 참고

- 상태값은 한글 문자열(`'확정'`, `'취소'`) 그대로 사용— 프론트엔드 표시 텍스트와 DB 값이 동일하므로 별도 매핑 불필요.
- `equipment`는 정규화하지 않고 콤마 구분 텍스트로 저장(단순 표시용, 필터링 요구사항 없음).
