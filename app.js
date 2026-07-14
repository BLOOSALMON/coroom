// ===== coroom app.js =====
// Supabase 연동 및 예약 현황 보드 / 예약 생성·취소 / 내 예약 조회 로직

// ---- Supabase 클라이언트 초기화 (DB.md 참고) ----
const SUPABASE_URL = "https://nhhoffcpgbpmnzyqjjnm.supabase.co";
const SUPABASE_KEY = "sb_publishable_ARq6dFA9PUnyHCy3PIDtHA_IhRVXYm-";
// 주의: CDN UMD 빌드가 전역 `window.supabase` 네임스페이스를 사용하므로,
// 클라이언트 인스턴스 변수명은 `db`로 지정해 이름 충돌을 피한다.
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- 보드 시간 범위 설정 ----
const DAY_START = "09:00";
const DAY_END = "19:00";
const SLOT_MINUTES = 30;

// ---- 전역 상태 ----
const state = {
  rooms: [],           // rooms 테이블 캐시
  roomsById: {},        // id -> room
  reservations: [],     // 선택된 날짜의 예약 (모든 상태)
  currentDate: todayISO(),
  currentView: "board",
  pendingSlot: null,    // 예약 생성 모달용 { roomId, roomName, date }
  pendingDetail: null,  // 상세 모달용 reservation
};

// ================= 유틸 함수 =================

function todayISO() {
  const d = new Date();
  return formatDateISO(d);
}

function formatDateISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function timeStrToMinutes(t) {
  // "HH:MM" or "HH:MM:SS"
  if (!t) return 0;
  const parts = t.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function minutesToTimeStr(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function buildBoundaryTimes() {
  const start = timeStrToMinutes(DAY_START);
  const end = timeStrToMinutes(DAY_END);
  const list = [];
  for (let t = start; t <= end; t += SLOT_MINUTES) list.push(t);
  return list; // 분 단위 배열
}

const BOUNDARIES = buildBoundaryTimes(); // e.g. [540, 570, ..., 1140]
const SLOT_COUNT = BOUNDARIES.length - 1;

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  return `${dateStr} (${weekday})`;
}

function showToast(message, isError) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("error", !!isError);
  toast.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function setStatusLine(el, message, type) {
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = "status-line" + (type ? ` ${type}` : "");
}

// ================= 데이터 로드 =================

async function loadRooms() {
  const { data, error } = await db
    .from("rooms")
    .select("*")
    .order("id", { ascending: true });
  if (error) {
    console.error(error);
    setStatusLine(document.getElementById("boardStatus"), "회의실 정보를 불러오지 못했습니다: " + error.message, "error");
    return;
  }
  state.rooms = data || [];
  state.roomsById = {};
  state.rooms.forEach((r) => { state.roomsById[r.id] = r; });
}

async function loadReservationsForDate(dateStr) {
  const { data, error } = await db
    .from("reservations")
    .select("*")
    .eq("reservation_date", dateStr);
  if (error) {
    console.error(error);
    throw error;
  }
  return data || [];
}

// ================= 보드 렌더링 =================

async function refreshBoard() {
  const boardStatus = document.getElementById("boardStatus");
  setStatusLine(boardStatus, "불러오는 중...", "");
  try {
    state.reservations = await loadReservationsForDate(state.currentDate);
    setStatusLine(boardStatus, "", "");
    renderBoard();
  } catch (err) {
    setStatusLine(boardStatus, "예약 현황을 불러오지 못했습니다: " + err.message, "error");
    renderBoard(); // 빈 상태로라도 그리드는 표시
  }
}

function buildBoardBoxes() {
  const dayStartMin = BOUNDARIES[0];
  const roomBoxes = {}; // roomId -> [{startIdx, endIdx, reservation}]
  const covered = {};   // roomId -> Set(slotIdx)
  state.rooms.forEach((r) => {
    roomBoxes[r.id] = [];
    covered[r.id] = new Set();
  });

  state.reservations
    .filter((r) => r.status === "확정")
    .forEach((res) => {
      if (!roomBoxes[res.room_id]) return; // 알 수 없는 room_id 방어
      const startMin = timeStrToMinutes(res.start_time);
      const endMin = timeStrToMinutes(res.end_time);
      let startIdx = Math.floor((startMin - dayStartMin) / SLOT_MINUTES);
      let endIdx = Math.ceil((endMin - dayStartMin) / SLOT_MINUTES);
      startIdx = clamp(startIdx, 0, SLOT_COUNT);
      endIdx = clamp(endIdx, 0, SLOT_COUNT);
      if (endIdx <= startIdx) return;
      roomBoxes[res.room_id].push({ startIdx, endIdx, reservation: res });
      for (let i = startIdx; i < endIdx; i++) covered[res.room_id].add(i);
    });

  return { roomBoxes, covered };
}

function renderBoard() {
  const grid = document.getElementById("boardGrid");
  grid.innerHTML = "";

  const cols = state.rooms.length;
  grid.style.gridTemplateColumns = `var(--time-col-width) repeat(${cols}, minmax(var(--room-col-width), 1fr))`;
  grid.style.gridTemplateRows = `auto repeat(${SLOT_COUNT}, var(--slot-height))`;

  // corner cell
  const corner = document.createElement("div");
  corner.className = "corner-cell grid-header-cell";
  corner.style.gridRow = "1";
  corner.style.gridColumn = "1";
  grid.appendChild(corner);

  // room headers
  state.rooms.forEach((room, idx) => {
    const cell = document.createElement("div");
    cell.className = "grid-header-cell";
    cell.style.gridRow = "1";
    cell.style.gridColumn = String(idx + 2);
    const notesBadge = room.notes ? `<div class="room-note-badge" title="${escapeHtml(room.notes)}">${escapeHtml(room.notes)}</div>` : "";
    cell.innerHTML = `
      <div class="room-name">${escapeHtml(room.name)}</div>
      <div class="room-meta" title="정원 ${room.capacity}명 · ${escapeHtml(room.equipment || "")}">
        정원 ${room.capacity}명 · ${room.floor ? escapeHtml(room.floor) + " · " : ""}${escapeHtml(room.equipment || "-")}
      </div>
      ${notesBadge}
    `;
    grid.appendChild(cell);
  });

  // time labels
  for (let i = 0; i < SLOT_COUNT; i++) {
    const label = document.createElement("div");
    label.className = "time-label-cell";
    label.style.gridRow = String(i + 2);
    label.style.gridColumn = "1";
    label.textContent = minutesToTimeStr(BOUNDARIES[i]);
    grid.appendChild(label);
  }

  const { roomBoxes, covered } = buildBoardBoxes();

  state.rooms.forEach((room, colIdx) => {
    const boxes = roomBoxes[room.id];
    const coveredSet = covered[room.id];
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (coveredSet.has(i)) {
        const box = boxes.find((b) => b.startIdx === i);
        if (box) {
          const res = box.reservation;
          const cell = document.createElement("div");
          cell.className = "booked-slot";
          cell.style.gridRow = `${box.startIdx + 2} / ${box.endIdx + 2}`;
          cell.style.gridColumn = String(colIdx + 2);
          cell.innerHTML = `
            <div class="booked-title">${escapeHtml(res.title || "(제목 없음)")}</div>
            <div class="booked-meta">${escapeHtml(res.reserver_name)}${res.department ? " · " + escapeHtml(res.department) : ""}</div>
            <div class="booked-time">${formatHM(res.start_time)}–${formatHM(res.end_time)}</div>
          `;
          cell.addEventListener("click", () => openDetailModal(res));
          grid.appendChild(cell);
        }
        // 연속 슬롯(박스의 중간)은 별도 렌더링하지 않음 (grid-row가 이미 span 처리)
        continue;
      }
      const emptyCell = document.createElement("div");
      emptyCell.className = "empty-slot";
      emptyCell.style.gridRow = `${i + 2} / ${i + 3}`;
      emptyCell.style.gridColumn = String(colIdx + 2);
      emptyCell.addEventListener("click", () => openCreateModal(room, BOUNDARIES[i]));
      grid.appendChild(emptyCell);
    }
  });
}

function formatHM(t) {
  if (!t) return "";
  return t.slice(0, 5);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ================= 날짜 네비게이션 =================

function setCurrentDate(dateStr) {
  state.currentDate = dateStr;
  document.getElementById("datePicker").value = dateStr;
  refreshBoard();
}

function shiftDate(days) {
  const d = new Date(state.currentDate + "T00:00:00");
  d.setDate(d.getDate() + days);
  setCurrentDate(formatDateISO(d));
}

// ================= 예약 생성 모달 =================

function populateTimeSelect(selectEl, minMinutes, maxMinutes) {
  selectEl.innerHTML = "";
  BOUNDARIES.forEach((min) => {
    if (min < minMinutes || min > maxMinutes) return;
    const opt = document.createElement("option");
    opt.value = String(min);
    opt.textContent = minutesToTimeStr(min);
    selectEl.appendChild(opt);
  });
}

function refreshEndOptions() {
  const startSel = document.getElementById("createStart");
  const endSel = document.getElementById("createEnd");
  const startMin = parseInt(startSel.value, 10);
  const prevEnd = endSel.value ? parseInt(endSel.value, 10) : null;
  populateTimeSelect(endSel, startMin + SLOT_MINUTES, BOUNDARIES[BOUNDARIES.length - 1]);
  // 기본 종료시간: 시작+1시간(가능하면), 아니면 시작+30분
  const preferred = startMin + 60 <= BOUNDARIES[BOUNDARIES.length - 1] ? startMin + 60 : startMin + SLOT_MINUTES;
  const target = prevEnd && prevEnd > startMin ? prevEnd : preferred;
  const match = Array.from(endSel.options).find((o) => parseInt(o.value, 10) === target);
  endSel.value = match ? match.value : endSel.options[0]?.value;
}

function openCreateModal(room, startMinutes) {
  state.pendingSlot = { roomId: room.id };
  document.getElementById("createForm").reset();
  document.getElementById("createFormError").hidden = true;

  document.getElementById("createRoomLabel").textContent = room.name;
  document.getElementById("createDateLabel").textContent = formatDateLabel(state.currentDate);

  const noteEl = document.getElementById("createRoomNote");
  if (room.notes) {
    noteEl.textContent = `안내: ${room.notes}`;
    noteEl.hidden = false;
  } else {
    noteEl.hidden = true;
  }

  const startSel = document.getElementById("createStart");
  populateTimeSelect(startSel, BOUNDARIES[0], BOUNDARIES[BOUNDARIES.length - 1] - SLOT_MINUTES);
  const startMatch = Array.from(startSel.options).find((o) => parseInt(o.value, 10) === startMinutes);
  startSel.value = startMatch ? startMatch.value : startSel.options[0]?.value;
  refreshEndOptions();

  document.getElementById("createModal").hidden = false;
  document.getElementById("createReserver").focus();
}

async function checkOverlap(roomId, dateStr, startMin, endMin) {
  const { data, error } = await db
    .from("reservations")
    .select("id,start_time,end_time,status")
    .eq("room_id", roomId)
    .eq("reservation_date", dateStr)
    .eq("status", "확정");
  if (error) throw error;
  return (data || []).some((res) => {
    const s = timeStrToMinutes(res.start_time);
    const e = timeStrToMinutes(res.end_time);
    return s < endMin && e > startMin;
  });
}

async function handleCreateSubmit(ev) {
  ev.preventDefault();
  const errorEl = document.getElementById("createFormError");
  errorEl.hidden = true;
  const submitBtn = document.getElementById("createSubmitBtn");

  const roomId = state.pendingSlot.roomId;
  const dateStr = state.currentDate;
  const startMin = parseInt(document.getElementById("createStart").value, 10);
  const endMin = parseInt(document.getElementById("createEnd").value, 10);
  const reserver = document.getElementById("createReserver").value.trim();
  const department = document.getElementById("createDept").value.trim();
  const title = document.getElementById("createTitle").value.trim();

  if (!reserver || !title) {
    errorEl.textContent = "예약자명과 회의 제목을 입력해주세요.";
    errorEl.hidden = false;
    return;
  }
  if (endMin <= startMin) {
    errorEl.textContent = "종료 시간은 시작 시간보다 늦어야 합니다.";
    errorEl.hidden = false;
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "확인 중...";
  try {
    const overlapping = await checkOverlap(roomId, dateStr, startMin, endMin);
    if (overlapping) {
      errorEl.textContent = "이미 예약된 시간대입니다. 다른 시간을 선택해주세요.";
      errorEl.hidden = false;
      return;
    }

    const { error: insertError } = await db.from("reservations").insert({
      room_id: roomId,
      reserver_name: reserver,
      department: department || null,
      title,
      reservation_date: dateStr,
      start_time: minutesToTimeStr(startMin),
      end_time: minutesToTimeStr(endMin),
      status: "확정",
    });
    if (insertError) {
      if (insertError.code === "23514") {
        errorEl.textContent = "종료 시간은 시작 시간보다 늦어야 합니다.";
      } else {
        errorEl.textContent = "예약 저장에 실패했습니다: " + insertError.message;
      }
      errorEl.hidden = false;
      return;
    }

    closeModal("createModal");
    showToast("예약이 완료되었습니다.");
    await refreshBoard();
  } catch (err) {
    errorEl.textContent = "오류가 발생했습니다: " + err.message;
    errorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "예약하기";
  }
}

// ================= 예약 상세 / 취소 =================

function openDetailModal(reservation) {
  state.pendingDetail = reservation;
  const room = state.roomsById[reservation.room_id];
  const content = document.getElementById("detailContent");
  document.getElementById("detailError").hidden = true;
  content.innerHTML = `
    <dt>회의실</dt><dd>${escapeHtml(room ? room.name : "회의실 " + reservation.room_id)}</dd>
    <dt>일시</dt><dd>${escapeHtml(reservation.reservation_date)} ${formatHM(reservation.start_time)}–${formatHM(reservation.end_time)}</dd>
    <dt>예약자</dt><dd>${escapeHtml(reservation.reserver_name)}</dd>
    <dt>부서</dt><dd>${escapeHtml(reservation.department || "-")}</dd>
    <dt>제목</dt><dd>${escapeHtml(reservation.title || "-")}</dd>
    <dt>상태</dt><dd><span class="status-badge ${reservation.status === "확정" ? "confirmed" : "cancelled"}">${escapeHtml(reservation.status)}</span></dd>
  `;
  const cancelBtn = document.getElementById("cancelReservationBtn");
  cancelBtn.hidden = reservation.status !== "확정";
  document.getElementById("detailModal").hidden = false;
}

async function handleCancelReservation() {
  const reservation = state.pendingDetail;
  if (!reservation) return;
  if (!confirm("이 예약을 취소하시겠습니까?")) return;

  const errorEl = document.getElementById("detailError");
  errorEl.hidden = true;
  const cancelBtn = document.getElementById("cancelReservationBtn");
  cancelBtn.disabled = true;
  try {
    const { error } = await db
      .from("reservations")
      .update({ status: "취소" })
      .eq("id", reservation.id);
    if (error) throw error;
    closeModal("detailModal");
    showToast("예약이 취소되었습니다.");
    await refreshBoard();
    if (state.currentView === "mine") await runMineSearch();
  } catch (err) {
    errorEl.textContent = "취소에 실패했습니다: " + err.message;
    errorEl.hidden = false;
  } finally {
    cancelBtn.disabled = false;
  }
}

// ================= 내 예약 =================

async function runMineSearch() {
  const nameInput = document.getElementById("mineNameFilter");
  const listEl = document.getElementById("mineList");
  const statusEl = document.getElementById("mineStatus");
  const name = nameInput.value.trim();

  listEl.innerHTML = "";
  if (!name) {
    setStatusLine(statusEl, "예약자명을 입력하고 조회 버튼을 눌러주세요.", "empty");
    return;
  }

  setStatusLine(statusEl, "불러오는 중...", "");
  try {
    const { data, error } = await db
      .from("reservations")
      .select("*")
      .ilike("reserver_name", `%${name}%`)
      .order("reservation_date", { ascending: false })
      .order("start_time", { ascending: false });
    if (error) throw error;

    if (!data || data.length === 0) {
      setStatusLine(statusEl, "조회된 예약이 없습니다.", "empty");
      return;
    }
    setStatusLine(statusEl, "", "");
    data.forEach((res) => {
      const room = state.roomsById[res.room_id];
      const card = document.createElement("div");
      card.className = "mine-card";
      card.innerHTML = `
        <div class="mine-card-info">
          <div class="mine-card-title">${escapeHtml(res.title || "(제목 없음)")}</div>
          <div class="mine-card-sub">${escapeHtml(room ? room.name : "회의실 " + res.room_id)} · ${escapeHtml(res.reservation_date)} ${formatHM(res.start_time)}–${formatHM(res.end_time)} · ${escapeHtml(res.reserver_name)}${res.department ? " (" + escapeHtml(res.department) + ")" : ""}</div>
        </div>
        <span class="status-badge ${res.status === "확정" ? "confirmed" : "cancelled"}">${escapeHtml(res.status)}</span>
      `;
      card.addEventListener("click", () => openDetailModal(res));
      listEl.appendChild(card);
    });
  } catch (err) {
    setStatusLine(statusEl, "예약 목록을 불러오지 못했습니다: " + err.message, "error");
  }
}

// ================= 모달 공통 =================

function closeModal(id) {
  document.getElementById(id).hidden = true;
}

// ================= 탭 전환 =================

function switchView(view) {
  state.currentView = view;
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.getElementById("view-board").classList.toggle("active", view === "board");
  document.getElementById("view-mine").classList.toggle("active", view === "mine");
}

// ================= Realtime (선택적 반영) =================

function setupRealtime() {
  try {
    db
      .channel("reservations-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reservations" },
        (payload) => {
          const affectedDate = payload.new?.reservation_date || payload.old?.reservation_date;
          if (state.currentView === "board" && affectedDate === state.currentDate) {
            refreshBoard();
          }
          if (state.currentView === "mine") {
            runMineSearch();
          }
        }
      )
      .subscribe();
  } catch (err) {
    console.warn("Realtime 구독을 사용할 수 없습니다.", err);
  }
}

// ================= 오프라인 상태 표시 =================

function updateOfflineBadge() {
  const badge = document.getElementById("offlineBadge");
  badge.hidden = navigator.onLine;
}

function setupConnectionBadge() {
  window.addEventListener("online", () => {
    updateOfflineBadge();
    showToast("다시 연결되었습니다.");
    refreshBoard();
    if (state.currentView === "mine") runMineSearch();
  });
  window.addEventListener("offline", () => {
    updateOfflineBadge();
    showToast("오프라인 상태입니다. 마지막으로 불러온 정보를 보여줍니다.", true);
  });
  updateOfflineBadge();
}

// ================= 서비스 워커 등록 (PWA / 오프라인 지원) =================

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.warn("서비스 워커 등록 실패:", err);
    });
  });
}

// ================= 초기화 =================

function attachEventListeners() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  document.getElementById("prevDay").addEventListener("click", () => shiftDate(-1));
  document.getElementById("nextDay").addEventListener("click", () => shiftDate(1));
  document.getElementById("todayBtn").addEventListener("click", () => setCurrentDate(todayISO()));
  document.getElementById("datePicker").addEventListener("change", (e) => {
    if (e.target.value) setCurrentDate(e.target.value);
  });

  document.getElementById("createForm").addEventListener("submit", handleCreateSubmit);
  document.getElementById("createStart").addEventListener("change", refreshEndOptions);
  document.getElementById("cancelReservationBtn").addEventListener("click", handleCancelReservation);

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.hidden = true;
    });
  });

  document.getElementById("mineSearchBtn").addEventListener("click", runMineSearch);
  document.getElementById("mineNameFilter").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runMineSearch(); }
  });
}

async function init() {
  document.getElementById("datePicker").value = state.currentDate;
  attachEventListeners();
  setupConnectionBadge();
  registerServiceWorker();
  await loadRooms();
  await refreshBoard();
  if (navigator.onLine) setupRealtime();
}

init();
