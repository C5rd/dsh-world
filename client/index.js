/**
 * dsh-world — 浏览器半侧：设置里的「世界控制台」（只读）。
 * 模块 id 必须等于 bundle 行名 dsh-world；数据来自宿主半侧的 /dsh-world/console/* 只读路由。
 */
window.__ModuleLoader__.load({
  id: 'dsh-world',
  factory: (require) => {
    var react = require('react')
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect
    var useRef = react.useRef

    function api(path) {
      return fetch('/dsh-world/console/' + path, { cache: 'no-store' }).then(function (r) {
        return r.json().then(function (body) { return { body: body } }, function () { return null }).then(function (parsed) {
          var body = parsed && parsed.body
          if (!r.ok) { var err = new Error((body && body.error) || ('HTTP ' + r.status)); err.status = r.status; throw err }
          if (!parsed) { var bad = new Error('回复不是 JSON'); bad.notJson = true; throw bad }
          return body
        })
      })
    }
    /**
     * 快照，或 null 表示控制台不在（404、不是 JSON 的页面、没有 life 字段的回复）。
     * life 为 null 是生活线没能启动：照常显示，健康里写着原因。
     */
    function loadSnapshot() {
      return api('snapshot').then(function (s) {
        return s && typeof s === 'object' && typeof s.life === 'object' ? s : null
      }, function (e) { if (e && (e.status === 404 || e.notJson)) return null; throw e })
    }
    function clock(iso, zone) {
      try { return new Date(iso).toLocaleTimeString('zh-CN', { timeZone: zone, hourCycle: 'h23' }) } catch (e) { return String(iso) }
    }
    function local(iso, zone) {
      if (!iso) return '—'
      try { return new Date(iso).toLocaleString('zh-CN', { timeZone: zone, hourCycle: 'h23' }) } catch (e) { return iso }
    }
    function remaining(iso) {
      var ms = Date.parse(iso) - Date.now()
      if (!(ms > 0)) return '马上'
      var m = Math.round(ms / 60000), d = Math.floor(m / 1440), hr = Math.floor(m % 1440 / 60), mi = m % 60
      return (d ? d + ' 天 ' : '') + (hr ? hr + ' 小时 ' : '') + mi + ' 分'
    }
    var sourceLabel = { first: '新家', plan: '闹钟', fallback: '断线保护' }
    var statusLabel = { running: '正在做事', idle: '空闲', cold: '休息中（会话未加载）' }

    var CSS = '.dw{max-width:760px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}'
      + '.dw section{border:1px solid rgba(127,127,127,.25);border-radius:8px;padding:10px 12px}'
      + '.dw h4{margin:0 0 6px;font-size:13px}.dw .muted{color:var(--dsw-alias-label-tertiary)}'
      + '.dw table{width:100%;border-collapse:collapse}.dw td{padding:2px 6px;vertical-align:top}'
      + '.dw .bad{color:#d4380d}.dw .ok{color:#389e0d}.dw pre{white-space:pre-wrap;margin:6px 0 0;font-family:inherit}'
      + '.dw button{font:inherit;cursor:pointer}'
    function ensureStyle() {
      if (document.getElementById('dsh-world-console-style')) return
      var tag = document.createElement('style'); tag.id = 'dsh-world-console-style'; tag.textContent = CSS; document.head.appendChild(tag)
    }

    function Row(label, value) { return h('tr', null, h('td', { className: 'muted', style: { whiteSpace: 'nowrap' } }, label), h('td', null, value)) }

    function Activity(props) {
      var days = props.days, zone = props.zone
      var dayState = useState(days[0] || ''), day = dayState[0], setDay = dayState[1]
      var outsideState = useState(false), outside = outsideState[0], setOutside = outsideState[1]
      var rowsState = useState([]), rows = rowsState[0], setRows = rowsState[1]
      var errState = useState(null), err = errState[0], setErr = errState[1]
      useEffect(function () {
        if (!day) return
        var alive = true
        api('activity?day=' + encodeURIComponent(day) + (outside ? '&outside=1' : '')).then(
          function (r) { if (alive) { setRows(r); setErr(null) } },
          function (e) { if (alive) { setRows([]); setErr(String(e.message || e)) } })
        return function () { alive = false }
      }, [day, outside, props.tick])
      return h('section', null, h('h4', null, '活动记录'),
        days.length === 0 ? h('div', { className: 'muted' }, '还没有活动记录') : h('div', null,
          h('select', { value: day, onChange: function (e) { setDay(e.target.value) } }, days.map(function (d) { return h('option', { key: d, value: d }, d) })),
          ' ', h('label', null, h('input', { type: 'checkbox', checked: outside, onChange: function (e) { setOutside(e.target.checked) } }), ' 只看房间外'),
          err ? h('div', { className: 'bad' }, '读取失败：' + err) : null,
          h('table', null, h('tbody', null, rows.map(function (r) {
            return h('tr', { key: r.callId + r.time }, h('td', { className: 'muted' }, clock(r.time, zone)), h('td', null, r.tool), h('td', null, r.summary), h('td', { className: 'bad' }, r.status === 'error' ? '失败' : ''), h('td', { className: r.outside ? 'bad' : 'muted' }, (r.gapBefore ? '（此前有缺口）' : '') + (r.outside ? '房间外' : '')))
          })))))
    }
    function Diary(props) {
      var openState = useState(null), open = openState[0], setOpen = openState[1]
      var textState = useState(''), text = textState[0], setText = textState[1]
      var errState = useState(null), err = errState[0], setErr = errState[1]
      var wanted = useRef(null)
      function show(date) {
        wanted.current = date; setOpen(date); setText(''); setErr(null)
        api('diary?date=' + encodeURIComponent(date)).then(
          function (b) { if (wanted.current === date) setText(String(b.text || '')) },
          function (e) { if (wanted.current === date) setErr(String(e.message || e)) })
      }
      return h('section', null, h('h4', null, '日记'),
        props.dates.length === 0 ? h('div', { className: 'muted' }, '还没有日记') : h('div', null,
          props.dates.map(function (d) { return h('button', { key: d, onClick: function () { show(d) }, style: { marginRight: 6 } }, d) }),
          err ? h('div', { className: 'bad' }, '读取失败：' + err) : null,
          open && !err ? h('pre', null, text) : null))
    }

    function Console() {
      var snapState = useState(null), snap = snapState[0], setSnap = snapState[1]
      var errorState = useState(null), error = errorState[0], setError = errorState[1]
      var offState = useState(false), off = offState[0], setOff = offState[1]
      var tickState = useState(0), tick = tickState[0], setTick = tickState[1]
      var loadRef = useRef(null)
      useEffect(function () {
        ensureStyle()
        var alive = true, pending = false, timer = null
        function load() {
          if (!alive || pending) return
          pending = true
          loadSnapshot().then(function (s) {
            pending = false
            if (!alive) return
            if (s === null) { setOff(true); if (timer) { clearInterval(timer); timer = null } return }
            setSnap(s); setError(null); setTick(function (t) { return t + 1 })
          }, function (e) {
            pending = false
            if (alive) setError(String((e && e.message) || e))
          })
        }
        function onVisible() { if (document.visibilityState === 'visible') load() }
        loadRef.current = load
        load()
        timer = setInterval(onVisible, 10000)
        document.addEventListener('visibilitychange', onVisible)
        return function () { alive = false; loadRef.current = null; if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
      }, [])
      if (off) return h('div', { className: 'dw' }, h('div', { className: 'muted' }, '生活线未开启'))
      if (!snap) return h('div', { className: 'dw' }, error ? h('div', { className: 'bad' }, '读取失败：' + error) : h('div', { className: 'muted' }, '读取中…'))
      return h(View, { snap: snap, error: error, tick: tick, refresh: function () { if (loadRef.current) loadRef.current() } })
    }
    function list(value) { return Array.isArray(value) ? value : [] }
    /** 一份快照的画面；life 为 null（生活线没能启动）或缺了哪一块都不会崩。 */
    function View(props) {
      var snap = props.snap, error = props.error
      var zone = snap.timeZone, life = snap.life, alarm = life && life.alarm, mem = snap.memory
      var health = list(snap.health), compactions = list(snap.compactions), wakes = life ? list(life.recentWakes) : []
      return h('div', { className: 'dw' },
        h('div', null, h('b', null, '世界控制台 · ' + snap.worldId), ' ', h('span', { className: 'muted' }, local(snap.now, zone)), ' ',
          h('button', { onClick: props.refresh }, '刷新'),
          error ? h('span', { className: 'bad' }, ' 刷新失败：' + error) : null),
        h('section', null, h('h4', null, '生活线'), life ? h('table', null, h('tbody', null,
          Row('家', life.homeSessionId || '还没有家'),
          Row('状态', statusLabel[life.status] || life.status),
          Row('下次醒来', alarm ? local(alarm.at, zone) + '（还有 ' + remaining(alarm.at) + '，' + (sourceLabel[alarm.source] || alarm.source) + '）' : '没有待定闹钟'),
          Row('留给自己', alarm && alarm.note ? '「' + alarm.note + '」' : '—'),
          Row('最近唤醒', wakes.length ? wakes.map(function (w) { return local(w.deliveredAt, zone) + ' ' + (sourceLabel[w.source] || w.source) + (w.lateMs >= 120000 ? ' · 晚 ' + Math.round(w.lateMs / 60000) + ' 分' : ' · 准时') }).join('　') : '—')))
          : h('div', { className: 'bad' }, '生活线没有运行，原因见下面的健康')),
        h('section', null, h('h4', null, '健康'), health.length ? health.map(function (f, i) { return h('div', { key: i, className: 'bad' }, '● ' + f) }) : h('div', { className: 'ok' }, '● 正常')),
        h('section', null, h('h4', null, '记忆'), mem ? h('table', null, h('tbody', null,
          Row('窗口', mem.turns + ' / ' + (mem.windowTurns || 200) + ' 轮 · 约 ' + mem.approxTokens + ' token · 最早 ' + local(mem.oldest, zone)),
          Row('归档', mem.records + ' 条 · 来自 ' + mem.sessions + ' 个会话'))) : h('div', { className: 'muted' }, '—')),
        h('section', null, h('h4', null, '压缩'), compactions.length ? h('table', null, h('tbody', null, compactions.map(function (c, i) {
          return h('tr', { key: i }, h('td', { className: 'muted' }, local(c.time, zone)), h('td', null, life && c.sessionId === life.homeSessionId ? '家' : String(c.sessionId || '').slice(-8)), h('td', { className: c.ok ? 'ok' : 'bad' }, c.ok ? '成功' : '失败：' + (c.error || '')), h('td', null, c.shadowedTokens ? '缩掉约 ' + c.shadowedTokens + ' token' : ''))
        }))) : h('div', { className: 'muted' }, '还没有压缩记录')),
        h(Activity, { days: list(snap.activityDays), zone: zone, tick: props.tick }),
        h(Diary, { dates: list(snap.diaryDates) }))
    }

    var exports = { inject: ['slots'] }
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    exports.apply = function (ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({ name: 'settings.section', id: 'world-console', order: 28, label: '世界控制台' }, function () { return h(Console) })
      })
    }
    Object.defineProperty(exports, '__test', { value: { Activity: Activity, Diary: Diary, View: View, loadSnapshot: loadSnapshot }, enumerable: false })
    return exports
  },
})
