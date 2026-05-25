// 주방 태블릿 POS 비즈니스 로직 (액션 기반 고도화 + 티켓 분할 및 감산 기능 추가)
let socket;
let db = {
    tables: {},
    totalSales: 0,
    itemSales: {},
    history: [],
    soldOut: {},
    checkedItems: {},
    orderHistory: [],
    awayTimers: {},
    pendingOrders: [] // 티켓 분할 목록 추가
};

let activeTable = null;
let cart = {}; 
let cancelCart = { cooking: {}, served: {} };
let currentCat = 'main';
let currentSettingCat = 'main';

// 오프라인 액션 큐
let localActionQueue = JSON.parse(localStorage.getItem('pos_pos_action_queue')) || [];

// ── 알림음 시스템 (AudioContext 기반, 브라우저 Autoplay Policy 대응) ──
let _audioCtx = null;
let _audioBuffer = null;
let _audioUnlocked = false;

function _getAudioCtx() {
    if (!_audioCtx) {
        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return _audioCtx;
}

async function _loadAudioBuffer() {
    if (_audioBuffer) return _audioBuffer;
    try {
        const ctx = _getAudioCtx();
        const resp = await fetch('/sound/order.mp3');
        const arrayBuf = await resp.arrayBuffer();
        _audioBuffer = await ctx.decodeAudioData(arrayBuf);
        return _audioBuffer;
    } catch (e) {
        console.warn('오디오 버퍼 로드 실패:', e);
        return null;
    }
}

async function _unlockAudio() {
    if (_audioUnlocked) return;
    try {
        const ctx = _getAudioCtx();
        if (ctx.state === 'suspended') {
            await ctx.resume();
        }
        // 무음 버퍼 재생으로 잠금 해제
        const silentBuf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = silentBuf;
        src.connect(ctx.destination);
        src.start(0);
        _audioUnlocked = true;
        // 오디오 파일 미리 로드
        await _loadAudioBuffer();
        // 잠금 해제 배지 숨기기
        const badge = document.getElementById('sound-unlock-badge');
        if (badge) {
            badge.style.opacity = '0';
            badge.style.pointerEvents = 'none';
            setTimeout(() => { if(badge) badge.style.display = 'none'; }, 600);
        }
        console.log('🔊 알림음 시스템 활성화 완료');
    } catch (e) {
        console.warn('오디오 잠금 해제 실패:', e);
    }
}

// 문서 첫 인터랙션 시 자동으로 오디오 잠금 해제
document.addEventListener('click', _unlockAudio, { once: false });
document.addEventListener('touchstart', _unlockAudio, { once: false });

// 시계 업데이트 및 자리비움 타이머 매초 갱신
setInterval(() => {
    const now = new Date();
    const liveClock = document.getElementById('live-clock');
    if (liveClock) {
        liveClock.innerText = now.toTimeString().split(' ')[0];
    }
    
    // awayTimers는 db_manager 및 config의 getAwayTimeLeft 헬퍼를 사용하므로
    // 매초 메모리를 마이너스 할 필요 없이 렌더링 시점에 시작 타임스탬프 기준으로 역산합니다.

    const screenOrders = document.getElementById('screen-orders');
    if (screenOrders && screenOrders.classList.contains('active')) {
        renderOrdersSilently();
    }
    if (activeTable !== null) {
        drawAwayTimerUI();
    }
}, 1000);

// 소켓 초기화 및 이벤트 연결
try {
    socket = io(CONFIG.SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 10,
        timeout: 10000
    });

    window.serverOffset = 0;

    socket.on('connect', () => {
        console.log("✅ 포스 시스템 메인 통신망 동기화 완료");
        replayOfflineActions();
    });

    socket.on('orderUpdate', (updatedDbData) => {
        if (updatedDbData && updatedDbData.tables) {
            if (updatedDbData.serverTime) {
                window.serverOffset = updatedDbData.serverTime - Date.now();
            }
            
            // 신규 주문 발생 여부 감지 (최초 로드 시점 제외)
            const isInitialLoad = !db.tables || Object.keys(db.tables).length === 0;
            const oldOrderIds = new Set((db.pendingOrders || []).map(o => o.orderId));
            const newOrders = updatedDbData.pendingOrders || [];
            const hasNewOrder = !isInitialLoad && newOrders.some(o => !oldOrderIds.has(o.orderId));
            
            db = updatedDbData;
            localStorage.setItem('pos_v7_db', JSON.stringify(db)); 
            refreshActiveScreen();
            
            if (hasNewOrder) {
                playOrderSound();
            }
            
            if (activeTable !== null) {
                updateModalUI();
            }
            // 만약 메뉴 품절 설정 모달이 열려있다면 모달 내부 리스트도 즉시 갱신
            const menuSettingsOverlay = document.getElementById('menu-settings-overlay');
            if (menuSettingsOverlay && menuSettingsOverlay.style.display === 'flex') {
                changeSettingCategory(currentSettingCat);
            }
        }
    });
} catch (e) {
    console.log("⚠️ 오프라인 모드", e);
}

// 터치 스크롤 최적화
document.addEventListener('touchmove', function(e) {
    if (e.target.closest('.menu-grid') || 
        e.target.closest('#modal-cart-items') || 
        e.target.closest('#setting-menu-list') || 
        e.target.closest('.order-board') || 
        e.target.closest('#timeline-log-list') || 
        e.target.closest('.history-container') || 
        e.target.closest('.screen')) {
        return; 
    }
    e.preventDefault(); 
}, { passive: false });

// 이벤트 위임을 통한 오더 보드 체크박스 클릭 처리 (티켓 ID 기반으로 변경)
const orderBoard = document.getElementById('order-board');
if (orderBoard) {
    orderBoard.addEventListener('click', function(e) {
        const item = e.target.closest('.ticket-item');
        if (item && item.getAttribute('data-action') === 'toggle-check') {
            const orderId = item.getAttribute('data-order-id');
            const menuName = item.getAttribute('data-menu-name');
            toggleMultiItemCheck(e, orderId, menuName);
        }
    });
}

// 오프라인 상태일 때 발생한 액션을 큐에 추가
function queueOfflineAction(event, data) {
    localActionQueue.push({ event: event, data: data });
    localStorage.setItem('pos_pos_action_queue', JSON.stringify(localActionQueue));
}

// 큐에 적체된 액션을 순차적으로 서버로 재전송
function replayOfflineActions() {
    if (localActionQueue.length === 0) return;
    if (socket && socket.connected) {
        console.log(`⏳ 적체된 POS 오프라인 액션 ${localActionQueue.length}개 전송 시작...`);
        while (localActionQueue.length > 0) {
            const nextAction = localActionQueue[0];
            try {
                socket.emit(nextAction.event, nextAction.data);
                localActionQueue.shift();
            } catch (err) {
                console.error("POS 액션 재전송 실패, 중단:", err);
                break;
            }
        }
        localStorage.setItem('pos_pos_action_queue', JSON.stringify(localActionQueue));
    }
}

// 주기적인 큐 체크 타이머 기동 (연결 복구 대비)
setInterval(replayOfflineActions, 5000);

// 현재 활성화된 화면 새로고침
function refreshActiveScreen() {
    if (document.getElementById('screen-tables').classList.contains('active')) renderTables();
    if (document.getElementById('screen-orders').classList.contains('active')) renderOrders();
    if (document.getElementById('screen-logs').classList.contains('active')) renderOrderLogs();
    if (document.getElementById('screen-sales').classList.contains('active')) renderSales();
    if (document.getElementById('screen-settings').classList.contains('active')) renderSettings();
    if (document.getElementById('screen-waiting').classList.contains('active')) renderWaitingList();
}

// 화면 전환
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    
    const targetScreen = document.getElementById('screen-' + id);
    const targetBtn = document.getElementById('btn-' + id);
    if (targetScreen) targetScreen.classList.add('active');
    if (targetBtn) targetBtn.classList.add('active');
    
    refreshActiveScreen();
}

// 테이블 이용 시간 계산 (시차 보정 추가)
function calculateTableTime(ts) {
    if (!ts) return "0시간 0분";
    const currentServerTime = Date.now() + (window.serverOffset || 0);
    const diff = Math.max(0, Math.floor((currentServerTime - ts) / 60000));
    return `${Math.floor(diff/60)}시간 ${diff%60}분`;
}

// 자리비움 타이머 제어
function controlAwayTimer(action) {
    if (activeTable === null) return;
    const payload = { tableId: activeTable, action: action };
    
    if (socket && socket.connected) {
        socket.emit('controlAwayTimer', payload);
    } else {
        queueOfflineAction('controlAwayTimer', payload);
        alert("⚠️ 오프라인 상태입니다. 타이머 변경이 큐에 임시 저장되었습니다.");
    }
}

// 자리비움 타이머 UI 드로잉
function drawAwayTimerUI() {
    if (activeTable === null) return;
    const clockNode = document.getElementById('away-clock-display');
    const labelNode = document.getElementById('away-label-display');
    if (!clockNode || !labelNode) return;

    const state = db.awayTimers[activeTable];
    const timeLeft = getAwayTimeLeft(state);
    const min = Math.floor(timeLeft / 60);
    const sec = timeLeft % 60;
    
    let clockText = `${min < 10 ? '0' + min : min}:${sec < 10 ? '0' + sec : sec}`;
    if (state && !state.running && state.timeLeft > 0 && state.timeLeft < 1200) {
        clockText += ` <span class="away-status-sub">[일시정지]</span>`;
    }
    clockNode.innerHTML = clockText;
    
    if (timeLeft <= 0) {
        clockNode.classList.add('timeout');
        labelNode.classList.add('timeout');
        clockNode.innerText = "시간초과";
    } else {
        clockNode.classList.remove('timeout');
        labelNode.classList.remove('timeout');
    }
}

// 주문 대기 흐른 시간 계산 (시차 보정 추가)
function calculateOrderTime(ts) {
    if (!ts) return "0분 0초";
    const currentServerTime = Date.now() + (window.serverOffset || 0);
    const diffMs = currentServerTime - ts;
    const totalSecs = Math.max(0, Math.floor(diffMs / 1000));
    return `${Math.floor(totalSecs / 60)}분 ${totalSecs % 60}초`;
}

// 테이블 현황 화면 렌더링
function renderTables() {
    const container = document.getElementById('table-grid');
    if (!container) return;
    container.innerHTML = '';
    
    const layoutMatrix = [[15, 10, 5], [14, 9, 4], [13, 8, 3], [12, 7, 2], [11, 6, 1]];
    const renderOrder = [];
    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) { 
            renderOrder.push(layoutMatrix[row][col]); 
        }
    }

    renderOrder.forEach(i => {
        const t = db.tables[i];
        const awayState = db.awayTimers[i];
        let awayBadgeHtml = "";
        
        if (awayState && awayState.timeLeft < 1200) {
            const timeLeft = getAwayTimeLeft(awayState);
            const am = Math.floor(timeLeft / 60);
            const as = timeLeft % 60;
            let pauseText = (!awayState.running && timeLeft > 0) ? " (일시정지)" : "";
            if (timeLeft <= 0) {
                awayBadgeHtml = `<span style="font-size:10px; color:var(--danger); font-weight:bold; margin-left:5px;">🕒 비움(초과)</span>`;
            } else {
                awayBadgeHtml = `<span style="font-size:10px; color:var(--warning); margin-left:5px;">🕒 비움(${am}:${as < 10 ? '0'+as : as}${pauseText})</span>`;
            }
        }

        if (!t || t.status === 'empty') {
            container.innerHTML += `<div class="table-card empty" onclick="openModal(${i})">
                <div class="table-header"><span class="table-num">#${i}</span><span class="badge empty">Empty</span></div>
                <div class="order-preview">주문 대기 ${awayBadgeHtml}</div>
            </div>`;
        } else if (t.status === 'reserved') {
            container.innerHTML += `<div class="table-card reserved" onclick="openModal(${i})">
                <div class="table-header"><span class="table-num">#${i}</span><span class="badge reserve-badge">예약석</span></div>
                <div class="order-preview" style="color:var(--reserve); font-weight:bold;">⚠️ 예약 손님 대기 중</div>
            </div>`;
        } else {
            const novelItems = t.menus || {};
            const servedItems = t.paidMenus || {};
            let previewArr = [];
            Object.keys(novelItems).forEach(k => previewArr.push(`🔔 ${k} x${novelItems[k]}`));
            Object.keys(servedItems).forEach(k => previewArr.push(`✓ ${k} x${servedItems[k]}`));
            
            const preview = previewArr.join(', ') || "주문 내역 없음";
            const badgeTxt = t.status === 'cooking' ? '조리중 🔔' : '서빙완료 ✓';
            const badgeClass = t.status === 'cooking' ? 'cooking' : 'served';
            const timerText = calculateTableTime(t.timestamp);

            let unservedPrice = 0;
            Object.keys(novelItems).forEach(k => { unservedPrice += findPrice(k) * novelItems[k]; });
            let totalServedPrice = 0;
            Object.keys(servedItems).forEach(k => { totalServedPrice += findPrice(k) * servedItems[k]; });

            container.innerHTML += `<div class="table-card active" onclick="openModal(${i})">
                <div class="table-header"><span class="table-num">#${i}</span><span class="badge ${badgeClass}">${badgeTxt}</span></div>
                <div class="timer">${timerText} ${awayBadgeHtml}</div>
                <div class="order-preview">${preview}</div>
                <div class="price-footer">
                    <div class="price-line">조리중 금액: <span>${unservedPrice.toLocaleString()}원</span></div>
                    <div class="price-line">서빙완료 누적: <strong>${totalServedPrice.toLocaleString()}원</strong></div>
                </div>
            </div>`;
        }
    });
}

// 실시간 주문 현황판 렌더링 (주문서별 티켓 분리 렌더링 개편)
function renderOrders() {
    const board = document.getElementById('order-board');
    if (!board) return;

    const activeOrders = (db.pendingOrders || [])
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    if (activeOrders.length === 0) {
        board.innerHTML = `<div style="width:100%; text-align:center; padding-top:100px; color:var(--text-sub);">조리 대기 주문이 없습니다.</div>`;
        return;
    }

    let htmlBuffer = "";
    activeOrders.forEach(ticket => {
        const id = ticket.orderId;
        const tableId = ticket.tableId;
        const items = ticket.items;
        const checked = ticket.checkedItems || {};

        let uniqueMenuTypesCount = 0;
        let checkedMenuTypesCount = 0;
        let itemsHtml = '';

        Object.keys(items).forEach(name => {
            const qty = items[name];
            if (qty > 0) {
                uniqueMenuTypesCount++;
                const isChecked = checked[name] === true;
                if (isChecked) checkedMenuTypesCount++;
                const checkedClass = isChecked ? 'checked' : '';
                const iconHtml = isChecked 
                    ? '<i class="fa-solid fa-circle-check" style="color:var(--success);"></i>' 
                    : '<i class="fa-regular fa-circle" style="color:var(--text-sub);"></i>';
                const touchAttrs = `data-action="toggle-check" data-order-id="${id}" data-menu-name="${name}"`;

                itemsHtml += `
                    <div class="ticket-item ${checkedClass}" ${touchAttrs}>
                        <span>${iconHtml} ${name}</span>
                        <strong style="font-size:16px; color:var(--accent);">x${qty}</strong>
                    </div>`;
            }
        });

        if (uniqueMenuTypesCount > 0) {
            const isAllChecked = uniqueMenuTypesCount === checkedMenuTypesCount;
            let footerHtml = isAllChecked ? `
                    <div class="ticket-footer" style="border:none; padding-top:0;">
                        <button class="complete-action-btn" onclick="completeCookingFromBoard(${id})">🚀 전체 서빙 완료 (매출 및 내역 반영)</button>
                    </div>` : `
                    <div class="ticket-footer">
                        각 메뉴를 터치하여 확인해 주세요.<br>
                        <span style="color:var(--warning)">(${checkedMenuTypesCount}/${uniqueMenuTypesCount} 체크됨)</span>
                    </div>`;

            htmlBuffer += `
                <div class="order-ticket">
                    <div class="ticket-header">
                        <div><span style="font-size:20px; font-weight:bold; color:var(--accent);">#${tableId}번</span></div>
                        <div class="ticket-timer" id="timer-display-ticket-${id}"><i class="fa-regular fa-clock"></i> ${calculateOrderTime(ticket.timestamp)}</div>
                    </div>
                    <div class="ticket-body">${itemsHtml}</div>
                    ${footerHtml}
                </div>`;
        }
    });
    board.innerHTML = htmlBuffer || `<div style="width:100%; text-align:center; padding-top:100px; color:var(--text-sub);">조리 대기 주문이 없습니다.</div>`;
}

// 오더 현황판 실시간 흐른 시간 조용히 갱신
function renderOrdersSilently() {
    (db.pendingOrders || []).forEach(ticket => {
        const display = document.getElementById(`timer-display-ticket-${ticket.orderId}`);
        if (display) {
            display.innerHTML = `<i class="fa-regular fa-clock"></i> ${calculateOrderTime(ticket.timestamp)}`;
        }
    });
}

// 완료된 주문 이력 타임라인 렌더링
function renderOrderLogs() {
    const listContainer = document.getElementById('timeline-log-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    if (!db.orderHistory || db.orderHistory.length === 0) {
        listContainer.innerHTML = '<div style="color:var(--text-sub); text-align:center; padding-top:80px; font-size:14px; line-height:1.6;"><i class="fa-solid fa-receipt" style="font-size:26px; color:var(--text-sub); margin-bottom:12px; display:block;"></i>완료된 주문 기록이 비어있습니다.</div>';
        return;
    }

    const reversedLogs = [...db.orderHistory].reverse();
    let htmlBuffer = "";
    reversedLogs.forEach(log => {
        const isCancel = log.cost < 0 || (log.items && log.items.includes('[취소]'));
        const cardClass = isCancel ? "timeline-card cancel-card" : "timeline-card";
        const headerStatus = isCancel 
            ? `<span><i class="fa-solid fa-ban" style="color:var(--danger);"></i> ${log.time} 취소 완료</span>`
            : `<span><i class="fa-solid fa-bell-concierge" style="color:var(--success);"></i> ${log.time} 완료</span>`;
        const footerLabel = isCancel 
            ? `취소 차감 금액: <span style="color:var(--danger);">${Number(log.cost).toLocaleString()}원</span>`
            : `서빙 완료 금액: ${Number(log.cost).toLocaleString()}원`;

        htmlBuffer += `
            <div class="${cardClass}">
                <div class="timeline-header">
                    <span style="font-weight:bold; color:#fff; font-size:15px;"><i class="fa-solid fa-receipt" style="color:${isCancel ? 'var(--danger)' : 'var(--accent)'};"></i> #${log.tableId}번 테이블</span>
                    ${headerStatus}
                </div>
                <div class="timeline-body">${log.items}</div>
                <div class="timeline-footer">${footerLabel}</div>
            </div>`;
    });
    listContainer.innerHTML = htmlBuffer;
}

// 개별 메뉴 조리 확인 토글 (티켓 ID 기반으로 변경)
function toggleMultiItemCheck(event, orderId, menuName) {
    event.stopPropagation();
    const payload = { orderId: parseInt(orderId), menuName: menuName };
    if (socket && socket.connected) {
        socket.emit('toggleCheckItem', payload);
    } else {
        queueOfflineAction('toggleCheckItem', payload);
        alert("⚠️ 오프라인 상태입니다. 체크 상태 변경이 큐에 임시 저장되었습니다.");
    }
}

// 주방 보드에서 '서빙 완료' 처리 (티켓 ID 기반으로 변경)
function completeCookingFromBoard(orderId) {
    const payload = { orderId: parseInt(orderId) };
    if (socket && socket.connected) {
        socket.emit('completeServing', payload);
    } else {
        queueOfflineAction('completeServing', payload);
        alert("⚠️ 오프라인 상태입니다. 서빙 완료 액션이 큐에 임시 저장되었습니다.");
    }
}

// 상세 주문 및 관리 모달 열기
function openModal(id) {
    activeTable = id;
    const t = db.tables[id];
    const modalTableName = document.getElementById('modal-table-name');
    if (modalTableName) {
        if (t && t.status === 'reserved') {
            modalTableName.innerText = `#${id} 예약석`;
        } else {
            modalTableName.innerText = `#${id} 테이블 주문/관리`;
        }
    }
    cart = {}; 
    cancelCart = { cooking: {}, served: {} };
    updateModalUI();
    drawAwayTimerUI(); 
    changeCategory(currentCat);
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

// 모달 닫기
function closeModal() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.style.display = 'none';
    activeTable = null; 
    cart = {}; 
    cancelCart = { cooking: {}, served: {} };
    renderTables(); 
}

// 모달 내 실시간 금액 및 주문 내역 표시 갱신 (취소 장바구니 누적 조절 기능 탑재)
function updateModalUI() {
    const cartDiv = document.getElementById('modal-cart-items');
    if (!cartDiv) return;
    cartDiv.innerHTML = '';
    
    const t = db.tables[activeTable];
    let accumulatedTablePrice = 0; 
    
    // 이미 들어간 주문 내역 렌더링
    if (t) {
        // 이미 서빙 완료된 주문 리스트 (+ 감산 버튼)
        if (t.paidMenus) {
            Object.keys(t.paidMenus).forEach(name => {
                const qty = t.paidMenus[name];
                if (qty > 0) {
                    const cancelQty = cancelCart.served[name] || 0;
                    const netQty = qty - cancelQty;
                    accumulatedTablePrice += findPrice(name) * netQty;
                    
                    const isMinCancel = cancelQty === 0;
                    const isMaxCancel = cancelQty === qty;
                    
                    let cancelStatusText = '';
                    if (cancelQty > 0) {
                        if (netQty === 0) {
                            cancelStatusText = `<span style="color:var(--danger); font-size:12px; font-weight:bold;">(전체 취소예정)</span>`;
                        } else {
                            cancelStatusText = `<span style="color:var(--danger); font-size:12px; font-weight:bold;">(${cancelQty}개 취소예정)</span>`;
                        }
                    }

                    const cardClass = `cart-row served-item ${netQty === 0 ? 'cancelled' : ''}`;
                    const borderStyle = cancelQty > 0 ? 'border-left:4px solid var(--danger);' : '';
                    
                    cartDiv.innerHTML += `
                        <div class="${cardClass}" style="${borderStyle}">
                            <span class="cart-item-name">
                                <i class="fa-solid fa-circle-check"></i> ${name} ${cancelStatusText}
                            </span>
                            <div class="cart-qty-ctrl">
                                <button class="qty-btn" style="background:#ff4757; width:26px; height:26px; font-size:16px; ${isMaxCancel ? 'opacity: 0.35; pointer-events: none;' : ''}" onclick="addCancel('${name}', 'served')" title="수량 감소 (취소)">-</button>
                                <span class="cart-qty-num" style="font-size:13px; min-width:14px;">${netQty}</span>
                                <button class="qty-btn" style="background:#475569; width:26px; height:26px; font-size:16px; ${isMinCancel ? 'opacity: 0.35; pointer-events: none;' : ''}" onclick="removeCancel('${name}', 'served')" title="수량 증가 (원복)">+</button>
                            </div>
                        </div>`;
                }
            });
        }
        // 주방에서 조리 중인 주문 리스트 (+ 감산 버튼)
        if (t.menus) {
            Object.keys(t.menus).forEach(name => {
                const qty = t.menus[name];
                if (qty > 0) {
                    const cancelQty = cancelCart.cooking[name] || 0;
                    const netQty = qty - cancelQty;
                    accumulatedTablePrice += findPrice(name) * netQty;
                    
                    const isMinCancel = cancelQty === 0;
                    const isMaxCancel = cancelQty === qty;
                    
                    let cancelStatusText = '';
                    if (cancelQty > 0) {
                        if (netQty === 0) {
                            cancelStatusText = `<span style="color:var(--danger); font-size:12px; font-weight:bold;">(전체 취소예정)</span>`;
                        } else {
                            cancelStatusText = `<span style="color:var(--danger); font-size:12px; font-weight:bold;">(${cancelQty}개 취소예정)</span>`;
                        }
                    }

                    const cardClass = `cart-row ${netQty === 0 ? 'cancelled' : ''}`;
                    let borderStyle = 'background:#2a1f1f; border-left:4px solid var(--danger);';
                    if (cancelQty > 0) {
                        borderStyle += ' border-left-width: 4px;';
                    } else {
                        borderStyle += ' border-left-color: #475569;';
                    }
                    
                    cartDiv.innerHTML += `
                        <div class="${cardClass}" style="${borderStyle}">
                            <span class="cart-item-name" style="color:var(--danger);">
                                <i class="fa-solid fa-fire"></i> ${name} ${cancelStatusText}
                            </span>
                            <div class="cart-qty-ctrl">
                                <button class="qty-btn" style="background:#ff4757; width:26px; height:26px; font-size:16px; ${isMaxCancel ? 'opacity: 0.35; pointer-events: none;' : ''}" onclick="addCancel('${name}', 'cooking')" title="수량 감소 (취소)">-</button>
                                <span class="cart-qty-num" style="font-size:13px; min-width:14px;">${netQty}</span>
                                <button class="qty-btn" style="background:#475569; width:26px; height:26px; font-size:16px; ${isMinCancel ? 'opacity: 0.35; pointer-events: none;' : ''}" onclick="removeCancel('${name}', 'cooking')" title="수량 증가 (원복)">+</button>
                            </div>
                        </div>`;
                }
            });
        }
    }

    // 주방에서 직접 새로 등록하려는 신규 메뉴 장바구니 렌더링
    let newTotal = 0;
    Object.keys(cart).forEach(name => {
        const qty = cart[name];
        if (qty > 0) {
            newTotal += findPrice(name) * qty;
            cartDiv.innerHTML += `
                <div class="cart-row" style="border-left:4px solid var(--accent);">
                    <span class="cart-item-name" style="color:var(--accent);">🆕 ${name}</span>
                    <div class="cart-qty-ctrl">
                        <button class="qty-btn" onclick="changeQty('${name}', -1)">-</button>
                        <span class="cart-qty-num">${qty}</span>
                        <button class="qty-btn" onclick="changeQty('${name}', 1)">+</button>
                    </div>
                </div>`;
        }
    });

    const modalAccumulated = document.getElementById('modal-table-accumulated');
    const modalTotal = document.getElementById('modal-cart-total');
    if (modalAccumulated) modalAccumulated.innerText = accumulatedTablePrice.toLocaleString();
    if (modalTotal) modalTotal.innerText = newTotal.toLocaleString();
}

// 취소 품목 누적에 추가 (감산 수량 증가)
function addCancel(name, type) {
    if (activeTable === null || !db.tables[activeTable]) return;
    const t = db.tables[activeTable];
    const maxQty = type === 'cooking' ? (t.menus[name] || 0) : (t.paidMenus[name] || 0);
    
    if (!cancelCart[type][name]) cancelCart[type][name] = 0;
    if (cancelCart[type][name] < maxQty) {
        cancelCart[type][name]++;
    }
    updateModalUI();
}

// 취소 품목 누적에서 해제 (감산 수량 감소)
function removeCancel(name, type) {
    if (cancelCart[type][name]) {
        cancelCart[type][name]--;
        if (cancelCart[type][name] <= 0) {
            delete cancelCart[type][name];
        }
    }
    updateModalUI();
}

// 모달 장바구니 수량 조절
function changeQty(name, amount) {
    if (!cart[name]) cart[name] = 0;
    cart[name] += amount;
    if (cart[name] <= 0) {
        delete cart[name];
    }
    updateModalUI();
}

// 모달 장바구니 추가
function addToCart(name) {
    if (!cart[name]) cart[name] = 0;
    cart[name] += 1;
    updateModalUI();
}

// 모달 내 '주문 넣기' 액션 (취소 및 신규 주문 일괄 처리)
function saveOrder() {
    if (activeTable === null) return;
    
    const hasCart = Object.keys(cart).length > 0;
    const hasCookingCancels = Object.keys(cancelCart.cooking).length > 0;
    const hasServedCancels = Object.keys(cancelCart.served).length > 0;

    if (!hasCart && !hasCookingCancels && !hasServedCancels) {
        alert("선택된 신규 추가 메뉴 또는 취소할 메뉴가 없습니다.");
        return;
    }

    // 변경 내역 최종 컨펌 메세지 생성
    let confirmMsg = "";
    if (hasCart) {
        confirmMsg += "[신규 추가 주문]\n" + Object.entries(cart).map(([n, q]) => `- ${n} x${q}`).join('\n') + "\n\n";
    }
    if (hasCookingCancels || hasServedCancels) {
        confirmMsg += "[주문 취소/감산]\n";
        if (hasCookingCancels) {
            confirmMsg += Object.entries(cancelCart.cooking).map(([n, q]) => `- ${n} x${q} (조리 대기중)`).join('\n') + "\n";
        }
        if (hasServedCancels) {
            confirmMsg += Object.entries(cancelCart.served).map(([n, q]) => `- ${n} x${q} (서빙 완료분)`).join('\n') + "\n";
        }
        confirmMsg += "\n";
    }

    if (!confirm(confirmMsg + "주문 및 변경 내역을 최종 반영하시겠습니까?")) return;

    const payload = { 
        tableId: activeTable, 
        items: cart,
        cancels: cancelCart
    };

    if (socket && socket.connected) {
        socket.emit('placeOrder', payload);
    } else {
        queueOfflineAction('placeOrder', payload);
        alert("⚠️ 오프라인 상태입니다. 주문 변경 사항이 큐에 임시 저장되었습니다.");
    }
    closeModal();
}

// 테이블 퇴실 비우기
function clearTable() {
    if (activeTable === null || !db.tables[activeTable]) return;
    if (!confirm("손님이 퇴실하셨습니까? 테이블을 초기화하고 비웁니다.")) return;

    const payload = { tableId: activeTable };

    if (socket && socket.connected) {
        socket.emit('clearTable', payload);
    } else {
        queueOfflineAction('clearTable', payload);
        alert("⚠️ 오프라인 상태입니다. 퇴실 처리가 큐에 임시 저장되었습니다.");
    }
    closeModal();
}

// 예약석 토글
function toggleReservation() {
    if (activeTable === null) return;
    
    const payload = { tableId: activeTable };

    if (socket && socket.connected) {
        socket.emit('toggleReservation', payload);
    } else {
        queueOfflineAction('toggleReservation', payload);
        alert("⚠️ 오프라인 상태입니다. 예약 변경이 큐에 임시 저장되었습니다.");
    }
    closeModal();
}

// 매출 대시보드 화면 렌더링
function renderSales() {
    const todayTotalAmt = document.getElementById('today-total-amt');
    if (todayTotalAmt) todayTotalAmt.innerText = (db.totalSales || 0).toLocaleString() + "원";
    
    const list = document.getElementById('item-stats-list');
    if (!list) return;
    list.innerHTML = '';
    
    let hasItems = false;
    for (let cat in CONFIG.MENUS) {
        for (let item in CONFIG.MENUS[cat]) {
            const qty = db.itemSales[item] || 0;
            if (qty > 0) {
                hasItems = true;
                list.innerHTML += `
                    <div class="list-item">
                        <span>${item}</span>
                        <strong>${qty}개 (+ ${(qty * CONFIG.MENUS[cat][item]).toLocaleString()}원)</strong>
                    </div>`;
            }
        }
    }
    if (!hasItems) {
        list.innerHTML = '<div style="color:var(--text-sub); text-align:center; padding:20px 0;">정산 판매된 품목이 없습니다.</div>';
    }
}

// 설정 아카이브 리스트 렌더링
function renderSettings() {
    const container = document.getElementById('archive-list');
    if (!container) return;
    container.innerHTML = '';
    
    if (!db.history || db.history.length === 0) {
        container.innerHTML = '<div style="color:var(--text-sub); font-size:12px; padding:10px 0;">아직 마감 저장된 내역이 없습니다.</div>';
        return;
    }
    db.history.forEach((h, idx) => {
        container.innerHTML += `
            <div class="history-card" style="cursor:pointer;" onclick="openArchiveDetailModal(${idx})" title="클릭 시 상세 기록 조회">
                <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:bold; margin-bottom:4px;">
                    <span style="color:#fff;"><i class="fa-solid fa-folder-open" style="color:var(--accent); margin-right:5px;"></i> ${idx+1}일차 마감 기록</span>
                    <span style="color:var(--accent);">${h.sales.toLocaleString()}원</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
                    <span style="font-size:11px; color:var(--text-sub);">${h.date} 정산 완료</span>
                    <span style="font-size:11px; color:var(--accent); font-weight:bold;">상세 보기 ></span>
                </div>
            </div>`;
    });
}

// 매출 일차별 아카이브 생성
function archiveDay() {
    if (db.totalSales === 0) {
        alert("오늘 발생한 매출액이 0원이므로 아카이브를 생성할 수 없습니다.");
        return;
    }
    if (!confirm(`현재 누적 매출액 [${db.totalSales.toLocaleString()}원]을 아카이브에 백업하시겠습니까?`)) return;
    
    if (socket && socket.connected) {
        socket.emit('archiveDay', {});
    } else {
        queueOfflineAction('archiveDay', {});
        alert("⚠️ 오프라인 상태입니다. 매출 아카이브 저장이 큐에 임시 저장되었습니다.");
    }
}

// 오늘 데이터 초기화 (아카이브 유지)
function resetTodayLive() {
    if (!confirm("⚠️ 매출 및 모든 테이블 상태를 완전히 초기화하시겠습니까? (아카이브 보존)")) return;
    
    if (socket && socket.connected) {
        socket.emit('resetToday', {});
    } else {
        queueOfflineAction('resetToday', {});
        alert("⚠️ 오프라인 상태입니다. 오늘 테이블 초기화가 큐에 임시 저장되었습니다.");
    }
}

// 시스템 공장 초기화
function factoryReset() {
    if (!confirm("🚨 아카이브 포함 전체 데이터를 영구 삭제하시겠습니까?")) return;
    
    if (socket && socket.connected) {
        socket.emit('factoryReset', {});
    } else {
        localStorage.removeItem('pos_v7_db');
        queueOfflineAction('factoryReset', {});
        alert("💀 로컬 및 서버 오프라인 큐 공장 초기화 대기 등록!");
        window.location.reload();
    }
}

// 품절 메뉴 제어 모달 오픈
function openMenuSettingsModal() {
    const overlay = document.getElementById('menu-settings-overlay');
    if (overlay) overlay.style.display = 'flex';
    changeSettingCategory(currentSettingCat);
}

// 품절 메뉴 제어 모달 닫기
function closeMenuSettingsModal() {
    const overlay = document.getElementById('menu-settings-overlay');
    if (overlay) overlay.style.display = 'none';
    if (activeTable !== null) {
        openModal(activeTable); 
    } else {
        refreshActiveScreen();
    }
}

// 품절 설정 카테고리 전환
function changeSettingCategory(cat) {
    currentSettingCat = cat;
    document.querySelectorAll('#menu-settings-overlay .cat-btn').forEach(b => b.classList.remove('active'));
    
    const targetTab = document.getElementById('setting-tab-' + cat);
    if (targetTab) targetTab.classList.add('active');
    
    const listDiv = document.getElementById('setting-menu-list');
    if (!listDiv) return;
    listDiv.innerHTML = '';
    
    Object.keys(CONFIG.MENUS[cat]).forEach(name => {
        const isSoldOut = db.soldOut && db.soldOut[name] === true;
        const btnTxt = isSoldOut ? '품절 상태 (해제하기)' : '판매 중 (품절 처리)';
        listDiv.innerHTML += `
            <div style="display:flex; justify-content:space-between; align-items:center; background:#0f172a; padding:12px; border-radius:8px; margin-bottom:6px;">
                <span>${name} <small style="color:var(--accent);">(${CONFIG.MENUS[cat][name].toLocaleString()}원)</small></span>
                <button class="toggle-soldout-btn ${isSoldOut ? 'off' : 'on'}" onclick="toggleSoldOutStatus('${name}')">${btnTxt}</button>
            </div>`;
    });
}

// 품절 설정 상태 토글
function toggleSoldOutStatus(name) {
    const payload = { menuName: name };
    if (socket && socket.connected) {
        socket.emit('toggleSoldOut', payload);
    } else {
        queueOfflineAction('toggleSoldOut', payload);
        alert("⚠️ 오프라인 상태입니다. 품절 토글 상태가 큐에 임시 저장되었습니다.");
    }
}

// 모달 내 메뉴 카테고리 전환
function changeCategory(cat) {
    currentCat = cat;
    document.querySelectorAll('.menu-portal .cat-btn').forEach(b => b.classList.remove('active'));
    
    const tabBtn = document.getElementById('tab-' + cat);
    if (tabBtn) tabBtn.classList.add('active');
    
    const grid = document.getElementById('menu-grid');
    if (!grid) return;
    grid.innerHTML = '';
    
    Object.keys(CONFIG.MENUS[cat]).forEach(name => {
        const price = CONFIG.MENUS[cat][name];
        const isSold = db.soldOut && db.soldOut[name] === true;
        grid.innerHTML += `
            <button class="menu-item-btn ${isSold ? 'soldout' : ''}" onclick="addToCart('${name}')">
                <div>${name}</div>
                <div class="p">${price.toLocaleString()}원</div>
            </button>`;
    });
}

// 대기자 접수 및 현황판 렌더링
function renderWaitingList() {
    const board = document.getElementById('waiting-board');
    const countDisplay = document.getElementById('waiting-count-display');
    if (!board) return;
    board.innerHTML = '';
    
    const list = db.waitingList || [];
    if (countDisplay) {
        countDisplay.innerText = `총 ${list.length}팀 대기중`;
    }
    
    if (list.length === 0) {
        board.innerHTML = '<div style="text-align:center; padding:60px 0; color:var(--text-sub);">대기 중인 팀이 없습니다.</div>';
        return;
    }
    
    list.forEach(w => {
        const date = new Date(w.timestamp);
        const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        const calledClass = w.status === 'called' ? 'called' : '';
        const displayPhone = formatPhoneNumber(w.phone);
        
        board.innerHTML += `
            <div class="waiting-card ${calledClass}" onclick="copyToClipboard('${w.phone}', this)">
                <div class="waiting-card-info">
                    <div style="font-size:16px; font-weight:bold; color:#fff;">${w.name} (${w.people}명)</div>
                    <div style="font-size:12px; color:var(--text-sub);">연락처: ${displayPhone || '-'} | 접수시간: ${timeStr}</div>
                </div>
                <div class="waiting-card-actions" onclick="event.stopPropagation();">
                    <button class="waiting-action-seat" onclick="seatWaiting(${w.id})"><i class="fa-solid fa-chair"></i> 착석</button>
                    <button class="waiting-action-cancel" onclick="cancelWaiting(${w.id})"><i class="fa-solid fa-xmark"></i> 취소</button>
                </div>
            </div>
        `;
    });
}

// 대기팀 수동 등록
function registerWaiting() {
    const nameInput = document.getElementById('waiting-name');
    const phoneInput = document.getElementById('waiting-phone');
    const peopleInput = document.getElementById('waiting-people');
    if (!nameInput) return;
    
    const name = nameInput.value.trim();
    const rawPhone = phoneInput ? phoneInput.value.trim() : '';
    const people = peopleInput ? parseInt(peopleInput.value) : 2;
    
    if (!name) {
        alert("대기자명 또는 팀명을 입력해주세요.");
        return;
    }
    
    let phone = '';
    if (rawPhone) {
        const digits = rawPhone.replace(/\D/g, '');
        let fullPhone = '';
        if (digits.startsWith('010') && digits.length >= 10) {
            fullPhone = digits;
        } else {
            fullPhone = '010' + digits;
        }
        phone = formatPhoneNumber(fullPhone);
    }
    
    const payload = { name, phone, people };
    if (socket && socket.connected) {
        socket.emit('addWaiting', payload);
    } else {
        queueOfflineAction('addWaiting', payload);
        alert("⚠️ 오프라인 상태입니다. 대기 접수가 큐에 임시 저장되었습니다.");
    }
    
    nameInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (peopleInput) peopleInput.value = '2';
}

function callWaiting(id) {
    const payload = { id };
    if (socket && socket.connected) {
        socket.emit('callWaiting', payload);
    } else {
        queueOfflineAction('callWaiting', payload);
        alert("⚠️ 오프라인 상태입니다. 호출 처리가 큐에 임시 저장되었습니다.");
    }
}

function seatWaiting(id) {
    const payload = { id };
    if (socket && socket.connected) {
        socket.emit('seatWaiting', payload);
    } else {
        queueOfflineAction('seatWaiting', payload);
        alert("⚠️ 오프라인 상태입니다. 착석 처리가 큐에 임시 저장되었습니다.");
    }
}

function cancelWaiting(id) {
    if (!confirm("대기 등록을 취소하시겠습니까?")) return;
    const payload = { id };
    if (socket && socket.connected) {
        socket.emit('cancelWaiting', payload);
    } else {
        queueOfflineAction('cancelWaiting', payload);
        alert("⚠️ 오프라인 상태입니다. 대기 취소가 큐에 임시 저장되었습니다.");
    }
}

// 오늘 대기 기록 모달 열기
function openWaitingHistoryModal() {
    const overlay = document.getElementById('waiting-history-overlay');
    if (overlay) overlay.style.display = 'flex';
    
    const listDiv = document.getElementById('waiting-history-list');
    if (!listDiv) return;
    listDiv.innerHTML = '';
    
    if (!db.waitingHistory || db.waitingHistory.length === 0) {
        listDiv.innerHTML = '<div style="color:var(--text-sub); text-align:center; padding:30px 0;">오늘 접수된 대기 기록이 없습니다.</div>';
        return;
    }
    
    let html = `
        <table class="waiting-history-table">
            <thead>
                <tr>
                    <th>시간</th>
                    <th>대기자/팀명</th>
                    <th>인원</th>
                    <th>연락처</th>
                    <th>상태</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    db.waitingHistory.forEach(w => {
        const date = new Date(w.timestamp);
        const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        const displayPhone = formatPhoneNumber(w.phone);
        
        let statusBadge = '';
        if (w.status === 'waiting') {
            statusBadge = '<span class="status-badge waiting">대기중</span>';
        } else if (w.status === 'called') {
            statusBadge = '<span class="status-badge called">호출됨</span>';
        } else if (w.status === 'seated') {
            statusBadge = '<span class="status-badge seated">착석완료</span>';
        } else if (w.status === 'cancelled') {
            statusBadge = '<span class="status-badge cancelled">취소완료</span>';
        }
        
        html += `
            <tr>
                <td>${timeStr}</td>
                <td style="font-weight:bold;">${w.name}</td>
                <td>${w.people}명</td>
                <td>${displayPhone || '-'}</td>
                <td>${statusBadge}</td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    listDiv.innerHTML = html;
}

function closeWaitingHistoryModal() {
    const overlay = document.getElementById('waiting-history-overlay');
    if (overlay) overlay.style.display = 'none';
}

// 신규 주문 접수 알림음 재생 (AudioContext 기반)
async function playOrderSound() {
    try {
        const ctx = _getAudioCtx();
        // AudioContext가 suspended 상태이면 resume 시도
        if (ctx.state === 'suspended') {
            await ctx.resume();
        }
        const buffer = await _loadAudioBuffer();
        if (!buffer) {
            console.warn('오디오 버퍼 없음 - 소리 재생 불가');
            return;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gainNode = ctx.createGain();
        gainNode.gain.value = 1.0;
        source.connect(gainNode);
        gainNode.connect(ctx.destination);
        source.start(0);
        console.log('🔔 주문 알림음 재생');
    } catch (err) {
        console.error('알림음 재생 오류:', err);
        // 폴백: 기존 Audio 방식 시도
        try {
            const audio = new Audio('/sound/order.mp3');
            audio.volume = 1.0;
            await audio.play();
        } catch(e2) {
            console.warn('폴백 재생도 실패:', e2);
        }
    }
}

// 매출 아카이브 상세 모달 열기
function openArchiveDetailModal(idx) {
    const h = db.history[idx];
    if (!h) return;
    
    const overlay = document.getElementById('archive-detail-overlay');
    if (overlay) overlay.style.display = 'flex';
    
    const titleNode = document.getElementById('archive-detail-title');
    const metaNode = document.getElementById('archive-detail-meta');
    const itemsNode = document.getElementById('archive-detail-items');
    
    if (titleNode) titleNode.innerText = `${idx + 1}일차 마감 상세 기록`;
    if (metaNode) metaNode.innerHTML = `정산 시각: ${h.date}<br><strong>총 매출액: <span style="color:var(--warning); font-size:16px;">${h.sales.toLocaleString()}원</span></strong>`;
    
    if (itemsNode) {
        itemsNode.innerHTML = '';
        const details = h.details || {};
        const items = Object.entries(details);
        
        if (items.length === 0) {
            itemsNode.innerHTML = '<div style="color:var(--text-sub); text-align:center; padding:20px 0;">상세 품목 판매 내역이 없는 구형 레코드입니다.</div>';
            return;
        }
        
        let html = '<div class="list-section" style="background:#0f172a; padding:12px; border-radius:10px;">';
        html += '<h4 style="margin: 0 0 10px 0; color:var(--accent); font-size:14px;">🍗 품목별 판매 내역</h4>';
        
        items.forEach(([name, qty]) => {
            let price = 0;
            for (let cat in CONFIG.MENUS) {
                if (name in CONFIG.MENUS[cat]) {
                    price = CONFIG.MENUS[cat][name];
                    break;
                }
            }
            const sumPrice = price * qty;
            html += `
                <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #1e293b; font-size:13px;">
                    <span>${name} <small style="color:var(--text-sub);">(${price.toLocaleString()}원)</small></span>
                    <strong>${qty}개 (+ ${sumPrice.toLocaleString()}원)</strong>
                </div>
            `;
        });
        html += '</div>';
        itemsNode.innerHTML = html;
    }
}

// 매출 아카이브 상세 모달 닫기
function closeArchiveDetailModal() {
    const overlay = document.getElementById('archive-detail-overlay');
    if (overlay) overlay.style.display = 'none';
}

// 윈도우 로드 시 자동 실행
window.onload = function() {
    refreshActiveScreen(); 
};
