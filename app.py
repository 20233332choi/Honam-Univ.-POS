import os
import sqlite3
import json
import time
from datetime import datetime
from flask import Flask, send_from_directory
from flask_socketio import SocketIO, emit

app = Flask(__name__, static_folder='public', static_url_path='')
socketio = SocketIO(app, cors_allowed_origins="*")

# ngrok 무료 플랜 브라우저 경고창 자동 우회
# (직원 핸드폰에서 처음 접속할 때 "Visit Site" 클릭 없이 바로 연결)
@app.after_request
def add_ngrok_skip_header(response):
    response.headers['ngrok-skip-browser-warning'] = 'true'
    return response


DB_DIR = os.path.join(os.path.dirname(__file__), 'database')
DB_PATH = os.path.join(DB_DIR, 'pos.db')

# 메뉴 구성 정보 (서버 단가 계산용)
MENUS = {
    'main': { "풀드포크 플래터": 25000, "콘 치즈 누룽지 닭전": 20000, "파닭구이": 20000, "매콤순대볶음": 18000 },
    'side': { "해물 나가사끼": 15000, "매콤 닭발 튀김": 14000, "계란말이": 12000, "묵사발": 12000, "불닭냉면": 8000 },
    'drink': { "무등산 슬러쉬": 3000, "콜라 슬러쉬": 3000, "매화수": 5000, "테라": 5000, "음료": 2000, "생수": 1000 }
}

def find_price(name):
    """메뉴 가격 찾기"""
    for cat in MENUS:
        if name in MENUS[cat]:
            return MENUS[cat][name]
    return 0

def get_korean_now():
    """한국식 날짜 및 오전/오후 시간 표기 생성"""
    now = datetime.now()
    ampm = "오후" if now.hour >= 12 else "오전"
    hour = now.hour - 12 if now.hour > 12 else (now.hour if now.hour > 0 else 12)
    return f"{now.year}. {now.month}. {now.day}. {ampm} {hour}:{now.minute:02d}:{now.second:02d}"

def get_mobile_safe_time():
    """모바일용 안전 시간 표기 (HH:MM:SS)"""
    now = datetime.now()
    return f"{now.hour:02d}:{now.minute:02d}:{now.second:02d}"

def init_db():
    """데이터베이스 및 테이블 생성"""
    if not os.path.exists(DB_DIR):
        os.makedirs(DB_DIR)
        
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # 1. tables 테이블 생성
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS tables (
            table_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL,
            timestamp INTEGER,
            price INTEGER DEFAULT 0,
            paid_price INTEGER DEFAULT 0,
            menus TEXT DEFAULT '{}',
            paid_menus TEXT DEFAULT '{}'
        )
    ''')
    
    # 기본 1~15번 테이블 삽입
    for i in range(1, 16):
        cursor.execute('''
            INSERT OR IGNORE INTO tables (table_id, status, timestamp, price, paid_price, menus, paid_menus)
            VALUES (?, 'empty', NULL, 0, 0, '{}', '{}')
        ''', (i,))
        
    # 2. sales_summary 테이블 생성
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sales_summary (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            total_sales INTEGER DEFAULT 0,
            item_sales TEXT DEFAULT '{}'
        )
    ''')
    cursor.execute('INSERT OR IGNORE INTO sales_summary (id, total_sales, item_sales) VALUES (1, 0, \'{}\')')
    
    # 3. daily_archive 테이블 생성
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS daily_archive (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            sales INTEGER NOT NULL,
            details TEXT DEFAULT '{}'
        )
    ''')
    try:
        cursor.execute("ALTER TABLE daily_archive ADD COLUMN details TEXT DEFAULT '{}'")
    except sqlite3.OperationalError:
        pass # 이미 존재함
    
    # 4. sold_out 테이블 생성
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sold_out (
            menu_name TEXT PRIMARY KEY,
            is_sold_out INTEGER DEFAULT 0
        )
    ''')
    
    # 5. checked_items 테이블 생성 (티켓 단위 분할로 미사용 처리하지만 호환용 유지)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS checked_items (
            table_id INTEGER PRIMARY KEY,
            items_json TEXT DEFAULT '{}'
        )
    ''')
    
    # 6. order_history 테이블 생성
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS order_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id INTEGER NOT NULL,
            time TEXT NOT NULL,
            items TEXT NOT NULL,
            cost INTEGER NOT NULL
        )
    ''')
    
    # 7. away_timers 테이블 생성
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS away_timers (
            table_id INTEGER PRIMARY KEY,
            time_left INTEGER DEFAULT 1200,
            started_at INTEGER DEFAULT NULL,
            running INTEGER DEFAULT 0
        )
    ''')

    # 8. pending_orders 테이블 생성 (티켓 개별 분리 관리용)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS pending_orders (
            order_id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_id INTEGER NOT NULL,
            timestamp INTEGER NOT NULL,
            items TEXT NOT NULL,
            checked_items TEXT DEFAULT '{}'
        )
    ''')
    
    # 9. waiting_list 테이블 생성
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS waiting_list (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            people INTEGER NOT NULL,
            status TEXT DEFAULT 'waiting',
            timestamp INTEGER NOT NULL
        )
    ''')
    
    conn.commit()
    conn.close()

def load_shared_db():
    """DB 상태 로드 및 클라이언트 규격 가공"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # 1. tables 로드
    cursor.execute('SELECT * FROM tables')
    tables = {}
    for r in cursor.fetchall():
        tables[str(r['table_id'])] = {
            'status': r['status'],
            'timestamp': r['timestamp'],
            'price': r['price'],
            'paidPrice': r['paid_price'],
            'menus': json.loads(r['menus']),
            'paidMenus': json.loads(r['paid_menus'])
        }
        
    # 2. sales_summary 로드
    cursor.execute('SELECT * FROM sales_summary WHERE id = 1')
    summary = cursor.fetchone()
    total_sales = summary['total_sales'] if summary else 0
    item_sales = json.loads(summary['item_sales']) if summary else {}
    
    # 3. daily_archive 로드
    cursor.execute('SELECT * FROM daily_archive')
    history = []
    for r in cursor.fetchall():
        # 하위 호환성 유지 (details 컬럼이 없는 경우 대비)
        details_val = '{}'
        try:
            details_val = r['details']
        except:
            pass
        history.append({
            'date': r['date'],
            'sales': r['sales'],
            'details': json.loads(details_val) if details_val else {}
        })
        
    # 4. sold_out 로드
    cursor.execute('SELECT * FROM sold_out')
    sold_out = {}
    for r in cursor.fetchall():
        sold_out[r['menu_name']] = bool(r['is_sold_out'])
        
    # 5. checked_items 로드
    cursor.execute('SELECT * FROM checked_items')
    checked_items = {}
    for r in cursor.fetchall():
        checked_items[str(r['table_id'])] = json.loads(r['items_json'])
        
    # 6. order_history 로드
    cursor.execute('SELECT * FROM order_history')
    order_history = []
    for r in cursor.fetchall():
        order_history.append({
            'tableId': r['table_id'],
            'time': r['time'],
            'items': r['items'],
            'cost': r['cost']
        })
        
    # 7. away_timers 로드
    cursor.execute('SELECT * FROM away_timers')
    away_timers = {}
    for r in cursor.fetchall():
        away_timers[str(r['table_id'])] = {
            'timeLeft': r['time_left'],
            'startedAt': r['started_at'],
            'running': bool(r['running'])
        }

    # 8. pending_orders 로드 (티켓 분할 렌더링용)
    cursor.execute('SELECT * FROM pending_orders')
    pending_orders = []
    for r in cursor.fetchall():
        pending_orders.append({
            'orderId': r['order_id'],
            'tableId': r['table_id'],
            'timestamp': r['timestamp'],
            'items': json.loads(r['items']),
            'checkedItems': json.loads(r['checked_items'])
        })
        
    # 9. waiting_list 로드 (상태가 waiting 또는 called인 활성 대기자)
    cursor.execute("SELECT * FROM waiting_list WHERE status IN ('waiting', 'called') ORDER BY timestamp ASC")
    waiting_list = []
    for r in cursor.fetchall():
        waiting_list.append({
            'id': r['id'],
            'name': r['name'],
            'phone': r['phone'],
            'people': r['people'],
            'status': r['status'],
            'timestamp': r['timestamp']
        })
        
    # 10. 오늘 전체 대기 이력 로드
    cursor.execute("SELECT * FROM waiting_list ORDER BY timestamp DESC")
    waiting_history = []
    for r in cursor.fetchall():
        waiting_history.append({
            'id': r['id'],
            'name': r['name'],
            'phone': r['phone'],
            'people': r['people'],
            'status': r['status'],
            'timestamp': r['timestamp']
        })
        
    conn.close()
    
    return {
        'tables': tables,
        'totalSales': total_sales,
        'itemSales': item_sales,
        'history': history,
        'soldOut': sold_out,
        'checkedItems': checked_items,
        'orderHistory': order_history,
        'awayTimers': away_timers,
        'pendingOrders': pending_orders,
        'waitingList': waiting_list,
        'waitingHistory': waiting_history,
        'serverTime': int(time.time() * 1000)
    }

# HTTP 라우팅
@app.route('/')
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/pos')
def serve_pos():
    return send_from_directory(app.static_folder, 'pos.html')

# 실시간 웹소켓 이벤트 핸들러
@socketio.on('connect')
def handle_connect():
    print("📱 새로운 기기가 서버에 연동되었습니다.")
    try:
        emit('orderUpdate', load_shared_db())
    except Exception as e:
        print(f"연동 로드 에러: {e}")

@socketio.on('placeOrder')
def handle_place_order(data):
    """신규 주문 추가 및 취소 일괄 처리"""
    if not data: return
    table_id = int(data.get('tableId'))
    new_items = data.get('items', {})
    cancels = data.get('cancels', {})
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        # 1. 취소건 일괄 처리
        cooking_cancels = cancels.get('cooking', {}) if cancels else {}
        served_cancels = cancels.get('served', {}) if cancels else {}
        
        for name, qty in cooking_cancels.items():
            if qty > 0:
                decrease_item_internal(cursor, table_id, name, 'cooking', qty)
                
        for name, qty in served_cancels.items():
            if qty > 0:
                decrease_item_internal(cursor, table_id, name, 'served', qty)
                
        # 2. 신규 주문 건 처리
        if new_items:
            now_ms = int(time.time() * 1000)
            # pending_orders 에 개별 티켓 등록
            cursor.execute('''
                INSERT INTO pending_orders (table_id, timestamp, items, checked_items)
                VALUES (?, ?, ?, '{}')
            ''', (table_id, now_ms, json.dumps(new_items)))
            
            # tables 의 테이블 전체 메뉴 누적 데이터 업데이트
            cursor.execute('SELECT status, menus, price FROM tables WHERE table_id = ?', (table_id,))
            row = cursor.fetchone()
            
            status, menus_json, price = row if row else ('empty', '{}', 0)
            menus = json.loads(menus_json)
            
            # 메뉴 및 수량 추가
            for name, qty in new_items.items():
                menus[name] = menus.get(name, 0) + int(qty)
                
            # 총금액 재계산
            new_price = sum(find_price(k) * v for k, v in menus.items())
            
            # 상태 업데이트 및 타임스탬프 갱신
            cursor.execute('''
                UPDATE tables 
                SET status = 'cooking', timestamp = ?, price = ?, menus = ?
                WHERE table_id = ?
            ''', (now_ms, new_price, json.dumps(menus), table_id))
            
        conn.commit()
        print(f"🔔 #{table_id}번 테이블 주문 및 취소 변경 저장 완료")
    except Exception as e:
        print(f"placeOrder 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('completeServing')
def handle_complete_serving(data):
    """조리 대기중인 특정 티켓(주문서) ➡️ 서빙 완료 전환 처리"""
    if not data: return
    order_id = int(data.get('orderId'))
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        # 1. 완료할 pending_order 조회
        cursor.execute('SELECT table_id, items FROM pending_orders WHERE order_id = ?', (order_id,))
        order_row = cursor.fetchone()
        if not order_row:
            print(f"⚠️ 이미 완료되었거나 존재하지 않는 주문서 ID: {order_id}")
            return
            
        table_id, items_json = order_row
        items = json.loads(items_json)
        
        # 2. tables 테이블의 상태 갱신을 위해 데이터 로드
        cursor.execute('SELECT menus, paid_menus, paid_price FROM tables WHERE table_id = ?', (table_id,))
        table_row = cursor.fetchone()
        
        if table_row:
            menus = json.loads(table_row[0])
            paid_menus = json.loads(table_row[1])
            paid_price = table_row[2]
            
            log_items_arr = []
            log_cost_total = 0
            
            # 서빙 완료 메뉴로 병합 및 가격 계산
            for name, qty in items.items():
                if qty > 0:
                    # 조리 중 메뉴에서 빼기
                    if name in menus:
                        menus[name] = max(0, menus[name] - qty)
                        if menus[name] == 0:
                            del menus[name]
                            
                    # 서빙 완료 메뉴로 이동
                    paid_menus[name] = paid_menus.get(name, 0) + qty
                    price_sum = find_price(name) * qty
                    paid_price += price_sum
                    log_items_arr.append(f"- {name} x{qty}")
                    log_cost_total += price_sum
                    
                    # 당일 누적 매출 및 아이템 판매량 갱신
                    cursor.execute('SELECT total_sales, item_sales FROM sales_summary WHERE id = 1')
                    sum_row = cursor.fetchone()
                    total_sales = sum_row[0] if sum_row else 0
                    item_sales = json.loads(sum_row[1]) if sum_row else {}
                    
                    item_sales[name] = item_sales.get(name, 0) + qty
                    cursor.execute('''
                        UPDATE sales_summary 
                        SET total_sales = ?, item_sales = ?
                        WHERE id = 1
                    ''', (total_sales + price_sum, json.dumps(item_sales)))
            
            # 주문 완료 이력 등록
            if log_items_arr:
                cursor.execute('''
                    INSERT INTO order_history (table_id, time, items, cost)
                    VALUES (?, ?, ?, ?)
                ''', (table_id, get_mobile_safe_time(), '\n'.join(log_items_arr), log_cost_total))
                
            # 테이블의 남은 조리중 금액 재계산
            new_price = sum(find_price(k) * v for k, v in menus.items())
            
            # 조리중인 메뉴가 남아있는지 체크하여 테이블 상태 결정
            new_status = 'served' if not menus else 'cooking'
            
            cursor.execute('''
                UPDATE tables 
                SET status = ?, price = ?, paid_price = ?, menus = ?, paid_menus = ?
                WHERE table_id = ?
            ''', (new_status, new_price, paid_price, json.dumps(menus), json.dumps(paid_menus), table_id))
            
            # 3. pending_orders 에서 해당 티켓 삭제
            cursor.execute('DELETE FROM pending_orders WHERE order_id = ?', (order_id,))
            
            conn.commit()
            print(f"🚀 주문서 #{order_id} (테이블 #{table_id}) 서빙 완료 처리됨")
    except Exception as e:
        print(f"completeServing 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

def decrease_item_internal(cursor, table_id, menu_name, item_type, qty):
    """table_id번 테이블의 menu_name 품목을 item_type(cooking/served)에 맞게 qty만큼 감산 처리"""
    cursor.execute('SELECT menus, paid_menus, price, paid_price, status FROM tables WHERE table_id = ?', (table_id,))
    row = cursor.fetchone()
    if not row:
        return
    
    menus = json.loads(row[0])
    paid_menus = json.loads(row[1])
    price = row[2]
    paid_price = row[3]
    status = row[4]
    
    item_cost = find_price(menu_name)
    
    if item_type == 'cooking':
        # 조리 대기 품목 취소
        if menu_name in menus and menus[menu_name] > 0:
            cancel_qty = min(qty, menus[menu_name])
            menus[menu_name] -= cancel_qty
            if menus[menu_name] <= 0:
                del menus[menu_name]
            
            # pending_orders에서 감산 (최신 순)
            cursor.execute('''
                SELECT order_id, items FROM pending_orders 
                WHERE table_id = ? ORDER BY timestamp DESC
            ''', (table_id,))
            tickets = cursor.fetchall()
            
            remaining_to_cancel = cancel_qty
            for ticket in tickets:
                if remaining_to_cancel <= 0:
                    break
                o_id = ticket[0]
                o_items = json.loads(ticket[1])
                
                if menu_name in o_items and o_items[menu_name] > 0:
                    deduct = min(remaining_to_cancel, o_items[menu_name])
                    o_items[menu_name] -= deduct
                    remaining_to_cancel -= deduct
                    
                    if o_items[menu_name] <= 0:
                        del o_items[menu_name]
                    
                    if not o_items:
                        cursor.execute('DELETE FROM pending_orders WHERE order_id = ?', (o_id,))
                    else:
                        cursor.execute('UPDATE pending_orders SET items = ? WHERE order_id = ?', (json.dumps(o_items), o_id))
            
            # 취소 이력 등록
            cancel_item_str = f"- [취소] {menu_name} x{cancel_qty} (조리 대기중)"
            cursor.execute('''
                INSERT INTO order_history (table_id, time, items, cost)
                VALUES (?, ?, ?, ?)
            ''', (table_id, get_mobile_safe_time(), cancel_item_str, -item_cost * cancel_qty))
            
    elif item_type == 'served':
        # 서빙 완료 품목 취소
        if menu_name in paid_menus and paid_menus[menu_name] > 0:
            cancel_qty = min(qty, paid_menus[menu_name])
            paid_menus[menu_name] -= cancel_qty
            if paid_menus[menu_name] <= 0:
                del paid_menus[menu_name]
                
            # 테이블 누적 정산금액 감산
            paid_price = max(0, paid_price - item_cost * cancel_qty)
            
            # 당일 총매출 및 품목 판매요약 감산
            cursor.execute('SELECT total_sales, item_sales FROM sales_summary WHERE id = 1')
            sum_row = cursor.fetchone()
            total_sales = sum_row[0] if sum_row else 0
            item_sales = json.loads(sum_row[1]) if sum_row else {}
            
            total_sales = max(0, total_sales - item_cost * cancel_qty)
            if menu_name in item_sales:
                item_sales[menu_name] = max(0, item_sales[menu_name] - cancel_qty)
                if item_sales[menu_name] <= 0:
                    del item_sales[menu_name]
                    
            cursor.execute('''
                UPDATE sales_summary 
                SET total_sales = ?, item_sales = ?
                WHERE id = 1
            ''', (total_sales, json.dumps(item_sales)))
            
            # 취소 이력 등록
            cancel_item_str = f"- [취소] {menu_name} x{cancel_qty} (서빙 완료분)"
            cursor.execute('''
                INSERT INTO order_history (table_id, time, items, cost)
                VALUES (?, ?, ?, ?)
            ''', (table_id, get_mobile_safe_time(), cancel_item_str, -item_cost * cancel_qty))
            
    # 테이블의 남은 조리중 금액 재계산
    new_price = sum(find_price(k) * v for k, v in menus.items())
    
    # 테이블 최종 상태 정의
    if not menus and not paid_menus:
        new_status = 'empty'
        cursor.execute('DELETE FROM away_timers WHERE table_id = ?', (table_id,))
    else:
        new_status = 'cooking' if menus else 'served'
        
    cursor.execute('''
        UPDATE tables 
        SET status = ?, price = ?, paid_price = ?, menus = ?, paid_menus = ?
        WHERE table_id = ?
    ''', (new_status, new_price, paid_price, json.dumps(menus), json.dumps(paid_menus), table_id))

@socketio.on('decreaseOrderedItem')
def handle_decrease_ordered_item(data):
    """주방 모달창 내 주문 품목 1개 감산(취소) 처리"""
    if not data: return
    table_id = int(data.get('tableId'))
    menu_name = data.get('menuName')
    item_type = data.get('type') # 'cooking' (조리중) 또는 'served' (서빙완료)
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        decrease_item_internal(cursor, table_id, menu_name, item_type, 1)
        conn.commit()
        print(f"📉 #{table_id}번 테이블 {menu_name} ({item_type}) 1개 감산 처리 완료")
    except Exception as e:
        print(f"decreaseOrderedItem 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('clearTable')
def handle_clear_table(data):
    """퇴실 처리 (테이블 비우기)"""
    if not data: return
    table_id = int(data.get('tableId'))
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            UPDATE tables 
            SET status = 'empty', timestamp = NULL, price = 0, paid_price = 0, menus = '{}', paid_menus = '{}'
            WHERE table_id = ?
        ''', (table_id,))
        
        cursor.execute('DELETE FROM checked_items WHERE table_id = ?', (table_id,))
        cursor.execute('DELETE FROM away_timers WHERE table_id = ?', (table_id,))
        cursor.execute('DELETE FROM pending_orders WHERE table_id = ?', (table_id,))
        
        conn.commit()
        print(f"🧹 #{table_id}번 테이블 퇴실 초기화 완료")
    except Exception as e:
        print(f"clearTable 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('toggleReservation')
def handle_toggle_reservation(data):
    """예약석 지정 및 해제 토글"""
    if not data: return
    table_id = int(data.get('tableId'))
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute('SELECT status FROM tables WHERE table_id = ?', (table_id,))
        row = cursor.fetchone()
        if row:
            current_status = row[0]
            new_status = 'empty'
            if current_status == 'empty':
                new_status = 'reserved'
            elif current_status == 'reserved':
                new_status = 'empty'
            else:
                # 이미 손님이 이용 중인 테이블은 무시
                return
                
            cursor.execute('UPDATE tables SET status = ? WHERE table_id = ?', (new_status, table_id))
            conn.commit()
            print(f"📌 #{table_id}번 예약 상태 토글 -> {new_status}")
    except Exception as e:
        print(f"toggleReservation 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('toggleSoldOut')
def handle_toggle_sold_out(data):
    """메뉴 품절/해제 토글"""
    if not data: return
    menu_name = data.get('menuName')
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute('SELECT is_sold_out FROM sold_out WHERE menu_name = ?', (menu_name,))
        row = cursor.fetchone()
        new_so = 1
        if row:
            new_so = 0 if row[0] == 1 else 1
            cursor.execute('UPDATE sold_out SET is_sold_out = ? WHERE menu_name = ?', (new_so, menu_name))
        else:
            cursor.execute('INSERT INTO sold_out (menu_name, is_sold_out) VALUES (?, 1)', (menu_name,))
            
        conn.commit()
        print(f"🚫 품절 상태 변경 -> {menu_name}: {'품절' if new_so == 1 else '판매중'}")
    except Exception as e:
        print(f"toggleSoldOut 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('toggleCheckItem')
def handle_toggle_check_item(data):
    """특정 티켓(주문서) 내 개별 메뉴 조리완료 체크 토글"""
    if not data: return
    order_id = int(data.get('orderId'))
    menu_name = data.get('menuName')
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute('SELECT checked_items FROM pending_orders WHERE order_id = ?', (order_id,))
        row = cursor.fetchone()
        
        if row:
            checked = json.loads(row[0])
            checked[menu_name] = not checked.get(menu_name, False)
            cursor.execute('UPDATE pending_orders SET checked_items = ? WHERE order_id = ?', (json.dumps(checked), order_id))
            conn.commit()
    except Exception as e:
        print(f"toggleCheckItem 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('controlAwayTimer')
def handle_control_away_timer(data):
    """자리비움 타이머 제어 (절대 시간 스탬프 연동)"""
    if not data: return
    table_id = int(data.get('tableId'))
    action = data.get('action') # 'start', 'pause', 'reset'
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute('SELECT time_left, started_at, running FROM away_timers WHERE table_id = ?', (table_id,))
        row = cursor.fetchone()
        
        time_left = 1200
        started_at = None
        running = 0
        
        if row:
            time_left, started_at, running = row
            
        now_ms = int(time.time() * 1000)
        
        if action == 'start':
            started_at = now_ms
            running = 1
        elif action == 'pause':
            if running == 1 and started_at is not None:
                elapsed = now_ms - started_at
                time_left = max(0, time_left - int(elapsed / 1000))
            started_at = None
            running = 0
        elif action == 'reset':
            time_left = 1200
            started_at = None
            running = 0
            
        cursor.execute('''
            INSERT OR REPLACE INTO away_timers (table_id, time_left, started_at, running)
            VALUES (?, ?, ?, ?)
        ''', (table_id, time_left, started_at, running))
        
        conn.commit()
        print(f"🕒 #{table_id}번 타이머 제어 -> {action} (time_left: {time_left}, running: {running})")
    except Exception as e:
        print(f"controlAwayTimer 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('archiveDay')
def handle_archive_day(data):
    """오늘 매출 마감 및 아카이브 저장"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute('SELECT total_sales, item_sales FROM sales_summary WHERE id = 1')
        row = cursor.fetchone()
        total_sales = row[0] if row else 0
        item_sales_json = row[1] if row else '{}'
        
        if total_sales > 0:
            cursor.execute('''
                INSERT INTO daily_archive (date, sales, details)
                VALUES (?, ?, ?)
            ''', (get_korean_now(), total_sales, item_sales_json))
            conn.commit()
            print(f"🎉 매출 아카이브 저장 완료: {total_sales}원")
    except Exception as e:
        print(f"archiveDay 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('resetToday')
def handle_reset_today(data):
    """오늘 데이터 초기화 (아카이브는 보존)"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            UPDATE tables 
            SET status = 'empty', timestamp = NULL, price = 0, paid_price = 0, menus = '{}', paid_menus = '{}'
        ''')
        cursor.execute('UPDATE sales_summary SET total_sales = 0, item_sales = \'{}\' WHERE id = 1')
        cursor.execute('DELETE FROM checked_items')
        cursor.execute('DELETE FROM order_history')
        cursor.execute('DELETE FROM away_timers')
        cursor.execute('DELETE FROM pending_orders')
        cursor.execute('DELETE FROM waiting_list')
        
        conn.commit()
        print("✅ 당일 라이브 데이터 초기화 완료")
    except Exception as e:
        print(f"resetToday 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('factoryReset')
def handle_factory_reset(data):
    """시스템 전체 공장 초기화 (완전 삭제)"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute('DELETE FROM tables')
        cursor.execute('DELETE FROM sales_summary')
        cursor.execute('DELETE FROM daily_archive')
        cursor.execute('DELETE FROM sold_out')
        cursor.execute('DELETE FROM checked_items')
        cursor.execute('DELETE FROM order_history')
        cursor.execute('DELETE FROM away_timers')
        cursor.execute('DELETE FROM pending_orders')
        cursor.execute('DELETE FROM waiting_list')
        
        # 다시 테이블 및 세일즈 초기값 삽입
        for i in range(1, 16):
            cursor.execute('''
                INSERT INTO tables (table_id, status, timestamp, price, paid_price, menus, paid_menus)
                VALUES (?, 'empty', NULL, 0, 0, '{}', '{}')
            ''', (i,))
        cursor.execute('INSERT INTO sales_summary (id, total_sales, item_sales) VALUES (1, 0, \'{}\')')
        
        conn.commit()
        print("🚨 전체 공장 초기화 완료")
    except Exception as e:
        print(f"factoryReset 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('addWaiting')
def handle_add_waiting(data):
    """신규 대기 등록"""
    if not data: return
    name = data.get('name')
    phone = data.get('phone', '')
    people = int(data.get('people', 2))
    now_ms = int(time.time() * 1000)
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute('''
            INSERT INTO waiting_list (name, phone, people, status, timestamp)
            VALUES (?, ?, ?, 'waiting', ?)
        ''', (name, phone, people, now_ms))
        conn.commit()
        print(f"📋 신규 대기팀 등록 완료: {name} ({people}명)")
    except Exception as e:
        print(f"addWaiting 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('callWaiting')
def handle_call_waiting(data):
    """대기팀 호출"""
    if not data: return
    w_id = int(data.get('id'))
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE waiting_list SET status = 'called' WHERE id = ?", (w_id,))
        conn.commit()
        print(f"🔊 대기팀 호출 완료 (ID: {w_id})")
    except Exception as e:
        print(f"callWaiting 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('seatWaiting')
def handle_seat_waiting(data):
    """대기팀 착석(입장)"""
    if not data: return
    w_id = int(data.get('id'))
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE waiting_list SET status = 'seated' WHERE id = ?", (w_id,))
        conn.commit()
        print(f"✅ 대기팀 입장 완료 (ID: {w_id})")
    except Exception as e:
        print(f"seatWaiting 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

@socketio.on('cancelWaiting')
def handle_cancel_waiting(data):
    """대기팀 취소"""
    if not data: return
    w_id = int(data.get('id'))
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("UPDATE waiting_list SET status = 'cancelled' WHERE id = ?", (w_id,))
        conn.commit()
        print(f"❌ 대기팀 취소 완료 (ID: {w_id})")
    except Exception as e:
        print(f"cancelWaiting 에러: {e}")
        conn.rollback()
    finally:
        conn.close()
        
    emit('orderUpdate', load_shared_db(), broadcast=True)

if __name__ == '__main__':
    init_db()
    PORT = 3000
    print(f"🚀 파이썬 백엔드 서버가 포트 {PORT}에서 정상 기동 중입니다!")
    socketio.run(app, host='0.0.0.0', port=PORT, debug=True)
