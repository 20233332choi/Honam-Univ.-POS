// 직원 무선 오더기 비즈니스 로직 (액션 기반 고도화)
let socket;
let db = { tables: {}, totalSales: 0, itemSales: {}, history: [], soldOut: {}, checkedItems: {} };
let selectedTable = null;
let staffCart = {};
let currentCategory = 'main';

// 오프라인 액션 큐
let localActionQueue = JSON.parse(localStorage.getItem('pos_order_action_queue')) || [];

// 소켓 초기화 및 이벤트 바인딩
try {
    socket = io(CONFIG.SERVER_URL, { 
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 10,
        timeout: 10000 
    });

    socket.on('connect', () => {
        const netStatus = document.getElementById('net-status');
        if (netStatus) {
            netStatus.innerText = "🟢 실시간 연결됨";
            netStatus.style.color = "#10b981";
        }
        // 연결 복구 시 오프라인 큐가 차 있다면 동기화 시작
        replayOfflineActions();
    });

    socket.on('disconnect', () => {
        const netStatus = document.getElementById('net-status');
        if (netStatus) {
            netStatus.innerText = "🔴 연결 끊김";
            netStatus.style.color = "#ef4444";
        }
    });

    socket.on('orderUpdate', (serverDb) => {
        if (serverDb && serverDb.tables) {
            db = serverDb;
            renderTableGrid();
            renderMenuGrid();
            renderWaitingStatus();
        }
    });
} catch(e) {
    console.error("서버 연결 실패", e);
}

// 오프라인 상태일 때 발생한 액션을 큐에 추가
function queueOfflineAction(event, data) {
    localActionQueue.push({ event: event, data: data });
    localStorage.setItem('pos_order_action_queue', JSON.stringify(localActionQueue));
}

// 큐에 적체된 액션을 순차적으로 서버로 재전송
function replayOfflineActions() {
    if (localActionQueue.length === 0) return;
    if (socket && socket.connected) {
        console.log(`⏳ 적체된 오프라인 액션 ${localActionQueue.length}개 전송 시작...`);
        while (localActionQueue.length > 0) {
            const nextAction = localActionQueue[0];
            try {
                socket.emit(nextAction.event, nextAction.data);
                localActionQueue.shift();
            } catch (err) {
                console.error("액션 재전송 실패, 중단:", err);
                break;
            }
        }
        localStorage.setItem('pos_order_action_queue', JSON.stringify(localActionQueue));
    }
}

// 주기적인 큐 체크 타이머 기동 (연결 복구 대비)
setInterval(replayOfflineActions, 5000);

// 테이블 선택 영역 렌더링
function renderTableGrid() {
    const zone = document.getElementById('table-zone');
    if (!zone) return;
    zone.innerHTML = '';
    
    // 테이블 레이아웃 매트릭스 (15번부터 1번까지 역순 배치)
    const layoutMatrix = [
        [15, 10, 5], [14, 9, 4], [13, 8, 3], [12, 7, 2], [11, 6, 1]
    ];
    const renderOrder = [];
    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) { 
            renderOrder.push(layoutMatrix[row][col]); 
        }
    }

    renderOrder.forEach(i => {
        const t = db.tables[i];
        let stateClass = '';
        let extraTxt = '';

        if (selectedTable === i) {
            stateClass = 'selected';
        } else if (t && t.status === 'reserved') {
            stateClass = 'reserved';
            extraTxt = ' (예약)';
        } else if (t && (t.status === 'cooking' || t.status === 'served')) {
            stateClass = 'has-order';
            extraTxt = ' (식사중)';
        }

        zone.innerHTML += `<button class="t-btn ${stateClass}" onclick="selectTable(${i})">#${i}${extraTxt}</button>`;
    });
}

// 테이블 선택 액션
function selectTable(num) {
    const t = db.tables[num];
    if (t && t.status === 'reserved') {
        alert("예약석 지정 테이블입니다. 주방 태블릿에서 먼저 예약 해제를 해주세요.");
        return;
    }
    selectedTable = num;
    staffCart = {}; // 테이블 선택 시 장바구니 새로 리셋
    renderTableGrid();
    updateCartUI();
}

// 카테고리 탭 전환
function changeCat(cat) {
    currentCategory = cat;
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    
    const targetTab = document.getElementById('tab-' + cat);
    if (targetTab) targetTab.classList.add('active');
    
    renderMenuGrid();
}

// 메뉴 리스트 렌더링
function renderMenuGrid() {
    const zone = document.getElementById('menu-zone');
    if (!zone) return;
    zone.innerHTML = '';
    
    const categoryMenus = CONFIG.MENUS[currentCategory];
    if (!categoryMenus) return;

    Object.keys(categoryMenus).forEach(name => {
        const isSoldOut = db.soldOut && db.soldOut[name] === true;
        const soldOutClass = isSoldOut ? 'soldout' : '';
        
        zone.innerHTML += `
            <div class="menu-card ${soldOutClass}" onclick="addToStaffCart('${name}')">
                <div class="name">${name}</div>
                <div class="price">${categoryMenus[name].toLocaleString()}원</div>
            </div>`;
    });
}

// 장바구니 추가
function addToStaffCart(name) {
    if (!selectedTable) {
        alert("주문할 테이블 번호를 먼저 선택해 주세요!");
        return;
    }
    if (db.soldOut && db.soldOut[name] === true) {
        alert("품절된 메뉴입니다.");
        return;
    }
    staffCart[name] = (staffCart[name] || 0) + 1;
    updateCartUI();
}

// 장바구니 수량 조절
function changeQty(name, amt) {
    staffCart[name] = (staffCart[name] || 0) + amt;
    if (staffCart[name] <= 0) {
        delete staffCart[name];
    }
    updateCartUI();
}

// 장바구니 UI 갱신
function updateCartUI() {
    const zone = document.getElementById('cart-zone');
    const totalSpan = document.getElementById('cart-total');
    const sendBtn = document.getElementById('btn-send');
    
    if (!zone || !totalSpan || !sendBtn) return;

    zone.innerHTML = '';
    let total = 0;

    Object.keys(staffCart).forEach(name => {
        const cost = findPrice(name) * staffCart[name];
        total += cost;
        zone.innerHTML += `
            <div class="cart-row">
                <span>${name}</span>
                <div class="qty-controls">
                    <button onclick="changeQty('${name}', -1)">-</button>
                    <span style="display:inline-block; width:25px; text-align:center; font-weight:bold;">${staffCart[name]}</span>
                    <button onclick="changeQty('${name}', 1)">+</button>
                </div>
            </div>`;
    });

    if (Object.keys(staffCart).length === 0) {
        zone.innerHTML = '<div style="text-align:center; color:var(--text-sub); font-size:12px; padding:30px 0;">지정된 메뉴가 없습니다.</div>';
    }

    totalSpan.innerText = total.toLocaleString();
    sendBtn.disabled = (!selectedTable || Object.keys(staffCart).length === 0);
}

// 주방 태블릿으로 주문 전송 (액션 기반 전송)
function submitOrderToKitchen() {
    if (!selectedTable || Object.keys(staffCart).length === 0) return;

    const payload = { tableId: selectedTable, items: staffCart };

    if (socket && socket.connected) {
        socket.emit('placeOrder', payload);
        alert(`#${selectedTable}번 테이블 추가 주문이 주방으로 안전하게 전송되었습니다!`);
    } else {
        queueOfflineAction('placeOrder', payload);
        alert(`⚠️ 현재 인터넷 연결이 불안정합니다.\n#${selectedTable}번 테이블 주문은 로컬에 임시 대기 등록되었으며, 네트워크 연결 시 자동으로 주방에 전송됩니다.`);
    }

    // 로컬 화면 초기화
    staffCart = {};
    selectedTable = null;
    renderTableGrid();
    updateCartUI();
}

// 스크린 전환 (주문 등록 / 대기 접수 / 대기 현황)
function showOrderScreen(screenId) {
    document.querySelectorAll('.order-app-screen').forEach(s => s.style.display = 'none');
    document.querySelectorAll('.mobile-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    
    const targetScreen = document.getElementById('order-app-screen-' + screenId);
    const targetBtn = document.getElementById('tab-btn-' + screenId);
    if (targetScreen) targetScreen.style.display = 'block';
    if (targetBtn) targetBtn.classList.add('active');
    
    // 만약 대기 현황으로 이동하는 경우 렌더링 동기화
    if (screenId === 'waiting-status') {
        renderWaitingStatus();
    }
}

// 모바일 대기 접수 등록
function registerWaitingFromMobile() {
    const nameInput = document.getElementById('mobile-waiting-name');
    const phoneInput = document.getElementById('mobile-waiting-phone');
    const peopleInput = document.getElementById('mobile-waiting-people');
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
        alert(`대기팀 [${name}] 등록이 완료되었습니다.`);
    } else {
        queueOfflineAction('addWaiting', payload);
        alert("⚠️ 오프라인 상태입니다. 대기 접수가 큐에 임시 저장되었습니다.");
    }
    
    // 입력 칸 청소
    nameInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (peopleInput) peopleInput.value = '2';
    
    // 현황판 탭으로 자동 이동
    showOrderScreen('waiting-status');
}

// 모바일용 대기 현황 렌더링
function renderWaitingStatus() {
    const board = document.getElementById('mobile-waiting-board');
    const countDisplay = document.getElementById('mobile-waiting-count-display');
    if (!board) return;
    board.innerHTML = '';
    
    const list = db.waitingList || [];
    if (countDisplay) {
        countDisplay.innerText = `총 ${list.length}팀 대기중`;
    }
    
    if (list.length === 0) {
        board.innerHTML = '<div style="text-align:center; padding:40px 0; color:var(--text-sub); font-size:13px;">대기 중인 팀이 없습니다.</div>';
        return;
    }
    
    list.forEach(w => {
        const date = new Date(w.timestamp);
        const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        const calledClass = w.status === 'called' ? 'called' : '';
        const displayPhone = formatPhoneNumber(w.phone);
        
        board.innerHTML += `
            <div class="mobile-waiting-card ${calledClass}" onclick="copyToClipboard('${w.phone}', this)">
                <div class="mobile-waiting-card-info">
                    <div style="font-size:15px; font-weight:bold; color:#fff;">${w.name} (${w.people}명)</div>
                    <div style="font-size:11px; color:var(--text-sub);">연락처: ${displayPhone || '-'} | 접수: ${timeStr}</div>
                </div>
                <div class="mobile-waiting-card-actions" onclick="event.stopPropagation();">
                    <button class="mobile-waiting-action-seat" onclick="seatWaitingFromMobile(${w.id})">착석</button>
                    <button class="mobile-waiting-action-cancel" onclick="cancelWaitingFromMobile(${w.id})">취소</button>
                </div>
            </div>
        `;
    });
}

// 모바일 호출/착석/취소 소켓 이벤트 연결
function callWaitingFromMobile(id) {
    const payload = { id };
    if (socket && socket.connected) {
        socket.emit('callWaiting', payload);
    } else {
        queueOfflineAction('callWaiting', payload);
        alert("⚠️ 오프라인 상태입니다. 호출 처리가 큐에 임시 저장되었습니다.");
    }
}

function seatWaitingFromMobile(id) {
    const payload = { id };
    if (socket && socket.connected) {
        socket.emit('seatWaiting', payload);
    } else {
        queueOfflineAction('seatWaiting', payload);
        alert("⚠️ 오프라인 상태입니다. 착석 처리가 큐에 임시 저장되었습니다.");
    }
}

function cancelWaitingFromMobile(id) {
    if (!confirm("대기 등록을 취소하시겠습니까?")) return;
    const payload = { id };
    if (socket && socket.connected) {
        socket.emit('cancelWaiting', payload);
    } else {
        queueOfflineAction('cancelWaiting', payload);
        alert("⚠️ 오프라인 상태입니다. 대기 취소가 큐에 임시 저장되었습니다.");
    }
}
