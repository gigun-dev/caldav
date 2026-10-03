#!/usr/bin/env python3
"""0058 の本人試用用データを準備する。UI の使いやすさの判定は行わない。

seed は専用リストが存在すれば停止し、既存データを上書きしない。
verify は専用リストに一時タスクを作り、その一件だけで更新・完了・移動を検証する。
cleanup は専用識別子・表示名を照合してから、その3リストだけを削除する。
認証は .dev.vars から読み、例外/応答本文を表示しない。公開結果は件数と真偽値だけ。
"""
import argparse
import datetime
import json
import pathlib
import re
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'test/fixtures/task-card-mobile-ux-20261003.json'
REPORT = ROOT / 'docs/verification/2026-10-03-task-card-functional.json'
WORKER = 'https://caldav.gigun-dev.workers.dev/mcp'
PREFIX = 'ux0058-20261003'
# 人工データ以外の本文をログへ流さないため、失敗時も内部例外の文字列は出さない。
VALUES = dict(re.findall(r'^([A-Z_]+)=(.*)$', (ROOT / '.dev.vars').read_text(), re.M))
TOKEN = VALUES['MCP_TOKEN'].strip().strip('\"\'')
CHECKS = []

def call(name, args):
    payload = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
               'params': {'name': name, 'arguments': args}}
    request = urllib.request.Request(WORKER, data=json.dumps(payload).encode(), headers={
        'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'User-Agent': 'caldav-production-verification/1.0'}, method='POST')
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read().decode()
    # MCP の JSON と SSE の両方を受ける。結果の全量はメモリ内のみ。
    result = json.loads(raw if raw.startswith('{') else next(
        line[6:] for line in raw.splitlines() if line.startswith('data: ')))
    assert 'error' not in result and not result['result'].get('isError'), name
    return result['result'].get('structuredContent', {})

def check(label, condition):
    CHECKS.append({'label': label, 'pass': bool(condition)})
    assert condition, label

def lists():
    return call('list-calendars', {})['calendars']

def tasks(calendar):
    return call('list-todos', {'calendarId': calendar, 'includeCompleted': True,
                              'timeZone': 'Asia/Tokyo'})

def rows(vm):
    # list-todos は未完了中心の tasks と completedRecent を分ける。
    return vm.get('tasks', []) + vm.get('completedRecent', [])

def guard(fixture):
    calendars = {c['id']: c for c in lists()}
    for wanted in fixture['calendars']:
        actual = calendars.get(wanted['id'])
        check('dedicated-calendar ' + wanted['id'], actual is not None and
              actual['displayName'] == wanted['displayName'])

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('mode', choices=['seed', 'verify', 'cleanup'])
args = parser.parse_args()
fixture = json.loads(FIXTURE.read_text())
try:
    if args.mode == 'seed':
        existing = {c['id'] for c in lists()}
        # 前回途中成功があれば停止する。二重投入の復旧は件数を調べてから個別に判断する。
        check('no-existing-dedicated-calendars', not existing.intersection(
            c['id'] for c in fixture['calendars']))
        for calendar in fixture['calendars']:
            call('create-calendar', dict(calendar, components=['VTODO'], timeZone='Asia/Tokyo'))
        call('create-todos', {'calendarId': PREFIX, 'timeZone': 'Asia/Tokyo',
                              'items': fixture['items']})
        # 完了2件は batch 作成後に独立した標準操作で付ける。
        vm = tasks(PREFIX)
        for title in fixture['completedTitles']:
            task = next(t for t in rows(vm) if t['title'] == title)
            call('complete-todo', {'calendarId': PREFIX, 'id': task['id'], 'timeZone': 'Asia/Tokyo'})
    if args.mode in ['seed', 'verify']:
        guard(fixture)
        vm = tasks(PREFIX)
        ready = rows(vm)
        check('primary-24-items', len(ready) == len(fixture['items']))
        expected = {item['title']: item for item in fixture['items']}
        check('all-synthetic-titles-roundtrip', set(t['title'] for t in ready) == set(expected))
        check('1000-character-title-roundtrip', any(len(t['title']) == 1000 for t in ready))
        check('1000-character-notes-roundtrip', any(len(t.get('notes') or '') == 1000 for t in ready))
        check('multiline-notes-roundtrip', all((t.get('notes') or '') == expected[t['title']].get('notes', '') for t in ready))
        check('completed-two', sum(t.get('status') == 'COMPLETED' for t in ready) == 2)
        check('empty-list-zero', not rows(tasks(PREFIX + '-empty')))
        check('move-target-zero', not rows(tasks(PREFIX + '-move')))
    if args.mode == 'verify':
        # 操作の連鎖は専用一時タスクのみ。本人用24件には触れない。
        title = '[UX0058] 自動検証一時行'
        created = call('create-todo', {'calendarId': PREFIX, 'title': title, 'notes': 'before', 'timeZone': 'Asia/Tokyo'})
        task = next(t for t in rows(created) if t['title'] == title)
        task_id = task['id']
        call('update-todo', {'calendarId': PREFIX, 'id': task_id, 'title': title + '更新', 'notes': '', 'timeZone': 'Asia/Tokyo'})
        updated = next(t for t in rows(tasks(PREFIX)) if t['id'] == task_id)
        check('update-title-and-clear-notes', updated['title'] == title + '更新' and not updated.get('notes'))
        call('complete-todo', {'calendarId': PREFIX, 'id': task_id, 'timeZone': 'Asia/Tokyo'})
        check('complete-persisted', next(t for t in rows(tasks(PREFIX)) if t['id'] == task_id)['status'] == 'COMPLETED')
        call('update-todo', {'calendarId': PREFIX, 'id': task_id, 'status': 'NEEDS-ACTION', 'timeZone': 'Asia/Tokyo'})
        check('reopen-persisted', next(t for t in rows(tasks(PREFIX)) if t['id'] == task_id)['status'] == 'NEEDS-ACTION')
        call('move-todo', {'calendarId': PREFIX, 'id': task_id, 'toCalendarId': PREFIX + '-move', 'timeZone': 'Asia/Tokyo'})
        moved = next(t for t in rows(tasks(PREFIX + '-move')) if t['title'] == title + '更新')
        check('move-source-absent', not any(t['id'] == task_id for t in rows(tasks(PREFIX))))
        check('move-destination-present', moved['title'] == title + '更新')
        call('delete-todo', {'calendarId': PREFIX + '-move', 'id': moved['id'], 'timeZone': 'Asia/Tokyo'})
        check('temporary-task-cleaned', not rows(tasks(PREFIX + '-move')))
        REPORT.write_text(json.dumps({'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'scope': 'production MCP functional API; no browser/device UX acceptance',
            'calendars': fixture['calendars'], 'retainedTaskCount': len(fixture['items']),
            'checks': CHECKS}, ensure_ascii=False, indent=2) + '\n')
    if args.mode == 'cleanup':
        guard(fixture)
        # cleanup は利用者が試用を終えた後に明示実行する。通常 seed/verify は削除しない。
        for calendar in fixture['calendars']:
            assert calendar['id'].startswith(PREFIX)
            call('delete-calendar', {'id': calendar['id'], 'force': True, 'timeZone': 'Asia/Tokyo'})
    print(json.dumps({'mode': args.mode, 'checks': CHECKS}, ensure_ascii=False))
except Exception:
    print(json.dumps({'mode': args.mode, 'checks': CHECKS, 'failed': True}, ensure_ascii=False))
    raise SystemExit(1)
