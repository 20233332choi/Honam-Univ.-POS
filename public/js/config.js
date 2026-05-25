// 공통 설정 및 메뉴 데이터 관리
const CONFIG = {
    // 로컬 HTML 파일을 브라우저로 직접 더블클릭해 실행하는 경우 ngrok 주소로 백업 연결.
    // 브라우저에서 서버 주소(localhost 또는 ngrok 주소)로 직접 접속 시 자동으로 접속한 호스트 주소 사용.
    SERVER_URL: window.location.protocol.startsWith('http') 
        ? window.location.origin 
        : "https://uninvited-shrimp-capture.ngrok-free.dev",
    
    MENUS: {
        main: { 
            "풀드포크 플래터": 25000, 
            "콘 치즈 누룽지 닭전": 20000, 
            "파닭구이": 20000, 
            "매콤순대볶음": 18000 
        },
        side: { 
            "해물 나가사끼": 15000, 
            "매콤 닭발 튀김": 14000, 
            "계란말이": 12000, 
            "묵사발": 12000, 
            "불닭냉면": 8000 
        },
        drink: { 
            "무등산 슬러쉬": 3000, 
            "콜라 슬러쉬": 3000, 
            "매화수": 5000, 
            "테라": 5000, 
            "음료": 2000, 
            "생수": 1000 
        }
    }
};

// 메뉴 이름으로 가격을 찾는 헬퍼 함수
function findPrice(name) {
    for (const cat in CONFIG.MENUS) {
        if (CONFIG.MENUS[cat][name] !== undefined) {
            return CONFIG.MENUS[cat][name];
        }
    }
    return 0;
}

// 절대 타임스탬프 기준으로 자리비움 타이머 남은 초(seconds)를 계산하는 헬퍼 함수
function getAwayTimeLeft(timerState) {
    if (!timerState) return 1200;
    if (timerState.running && timerState.startedAt) {
        const currentServerTime = Date.now() + (window.serverOffset || 0);
        const elapsed = Math.floor((currentServerTime - timerState.startedAt) / 1000);
        return Math.max(0, timerState.timeLeft - elapsed);
    }
    return timerState.timeLeft;
}

// 전화번호 포맷 헬퍼 함수 (010XXXXXXXX -> 010-XXXX-XXXX)
function formatPhoneNumber(phone) {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 11) {
        return cleaned.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
    } else if (cleaned.length === 10) {
        if (cleaned.startsWith('02')) {
            return cleaned.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3');
        }
        return cleaned.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
    } else if (cleaned.length === 9) {
        if (cleaned.startsWith('02')) {
            return cleaned.replace(/(\d{2})(\d{3})(\d{4})/, '$1-$2-$3');
        }
    }
    return phone;
}

// 클립보드 복사 및 피드백 헬퍼 함수
function copyToClipboard(text, element) {
    if (!text || text === '-') return;
    const formatted = formatPhoneNumber(text);
    
    // 모바일 등 HTTP 사설망 환경(비보안 컨텍스트)에서 navigator.clipboard가 undefined인 경우 대비 폴백 적용
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(formatted).then(() => {
            triggerCopyFeedback(element);
        }).catch(err => {
            console.warn('Clipboard API 실패, 폴백 복사 시도:', err);
            fallbackCopyText(formatted, element);
        });
    } else {
        fallbackCopyText(formatted, element);
    }
}

// 구형 브라우저 및 HTTP 사설 IP 주소 접속 환경용 클립보드 복사 폴백 함수
function fallbackCopyText(text, element) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    
    // 화면 레이아웃 스크롤 흔들림 방지
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";

    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        const successful = document.execCommand('copy');
        if (successful) {
            triggerCopyFeedback(element);
        } else {
            console.error('폴백 복사 수행 실패');
        }
    } catch (err) {
        console.error('폴백 복사 중 예외 발생:', err);
    }

    document.body.removeChild(textArea);
}

// 복사 성공 시 녹색 카드 하이라이트 및 배지 피드백 활성화
function triggerCopyFeedback(element) {
    if (element) {
        element.classList.add('copied-flash');
        setTimeout(() => {
            element.classList.remove('copied-flash');
        }, 1500);
    }
}
