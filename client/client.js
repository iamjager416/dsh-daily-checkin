/**
 * dsh-checkin — 浏览器端（DSH 设置侧边栏栏目）。
 *
 * 这是 `exports["./client"]` 指向的自注册 bundle：由页面的 window.__ModuleLoader__
 * 装载，在 `apply` 里把面板注册进 `settings.section` 插槽（设置侧边栏栏目，与 pixiv 插件同一接法）。
 * 数据通过宿主插件提供的绝对路由 /api/dsh-checkin/... 读写。
 *
 * @module dsh-checkin/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-checkin',

  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/api/dsh-checkin/v4'
    const PLUGIN_KEY = 'dsh-checkin'

    // ------------------------------------------------------------------ 文案

    const zh = {
      title: '签到设置',
      subtitle: '定时、推送与登录手机号；保存后立即生效。',
      schedule: '定时签到',
      enabled: '启用每日定时签到',
      time: '运行时间（HH:MM，本机时区）',
      providers: '参与平台',
      push: 'QQ 推送',
      pushEnabled: '签到完成后主动推送到 QQ',
      target: '推送目标 openid（只发私聊）',
      appId: '机器人 AppID',
      appSecret: '机器人 AppSecret',
      secretSaved: '已保存，留空不改',
      login: '账号登录',
      loginHint: '账号登录：填手机号 → 发送验证码 → 填验证码 → 绑定（绑定后自动使用新凭据）',
      sendCode: '发送验证码',
      bind: '绑定',
      code: '验证码',
      codeSent: '验证码已发送，5 分钟内有效',
      needCode: '先填验证码',
      bindOk: '绑定成功',
      kuroPhone: '库街区',
      sklandPhone: '森空岛（鹰角通行证）',
      ntePhone: '塔吉多（异环）',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      run: '立即签到一次',
      running: '签到中…',
      lastRun: '上次自动运行',
      never: '还没有',
      nextRun: '下次运行',
      lastPush: '上次推送',
      report: '最近报告',
      loadFailed: '读取设置失败：',
      saveFailed: '保存失败：',
      name_kuro: '库街区',
      name_skland: '森空岛',
      name_nte: '塔吉多',
    }

    // ------------------------------------------------------------------ 请求

    function formatTime(value) {
      if (!value) return zh.never
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    async function request(method, path, body) {
      const response = await fetch(`${API}/${path}`, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`)
      }
      if (!json || json.ok !== true) throw new Error(json?.error ?? `HTTP ${response.status}`)
      return json.data
    }

    // ------------------------------------------------------------------ 组件

    function Label(props) {
      return h(
        'label',
        { style: { display: 'block', marginTop: 10, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-text-secondary, #666)' } },
        props.children,
      )
    }

    const inputStyle = {
      width: '100%',
      marginTop: 4,
      padding: '6px 8px',
      fontSize: 13,
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      boxSizing: 'border-box',
      outline: 'none',
    }

    const labelStyle = {
      display: 'block',
      marginTop: 10,
      fontSize: 12,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-secondary, inherit)',
    }

    const buttonStyle = {
      padding: '6px 14px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
      background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      cursor: 'pointer',
    }

    function Row(props) {
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } }, props.children)
    }

    function Panel() {
      const [config, setConfig] = useState(null)
      const [draft, setDraft] = useState(null)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [runResult, setRunResult] = useState(null)
      const [loginState, setLoginState] = useState({
        kuro: { code: '', busy: false, msg: null },
        skland: { code: '', busy: false, msg: null },
        nte: { code: '', busy: false, msg: null },
      })

      const patchLogin = (provider, changes) =>
        setLoginState((prev) => ({ ...prev, [provider]: { ...prev[provider], ...changes } }))

      const dirtyRef = React.useRef(false)
      const draftFrom = (data) => ({
        schedule: { enabled: data.schedule.enabled, time: data.schedule.time, providers: [...data.schedule.providers] },
        notify: {
          enabled: data.notify.enabled,
          openid: String(data.notify.target ?? '').replace(/^c2c:/, ''),
          appId: data.notify.appId,
          appSecret: '',
        },
        phones: { ...data.phones },
      })

      const load = useCallback(async () => {
        try {
          const data = await request('GET', 'config')
          setConfig(data)
          setDraft(draftFrom(data))
          dirtyRef.current = false
        } catch (error) {
          setStatus({ kind: 'err', text: zh.loadFailed + String(error.message ?? error) })
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      // 配置同步：外部（聊天工具/另一个页面）改动后，没有未保存草稿时自动刷新页面草稿
      useEffect(() => {
        const timer = setInterval(async () => {
          try {
            const data = await request('GET', 'config')
            setConfig(data)
            if (dirtyRef.current === false) setDraft(draftFrom(data))
          } catch {
            // 轮询失败静默，下一次再试
          }
        }, 15000)
        return () => clearInterval(timer)
      }, [])

      const patch = (section, key, value) => {
        dirtyRef.current = true
        setDraft((prev) => (prev === null ? prev : { ...prev, [section]: { ...prev[section], [key]: value } }))
      }

      const toggleProvider = (provider) => {
        setDraft((prev) => {
          if (prev === null) return prev
          const set = new Set(prev.schedule.providers)
          set.has(provider) ? set.delete(provider) : set.add(provider)
          return { ...prev, schedule: { ...prev.schedule, providers: [...set] } }
        })
      }

      const saveSection = async (section) => {
        if (draft === null || busy) return
        setBusy(true)
        setStatus(null)
        try {
          const body = {}
          if (section === 'schedule') body.schedule = draft.schedule
          if (section === 'notify') {
            body.notify = {
              enabled: draft.notify.enabled,
              target: `c2c:${draft.notify.openid.trim()}`,
              appId: draft.notify.appId,
              ...(draft.notify.appSecret.trim() === '' ? {} : { appSecret: draft.notify.appSecret }),
            }
          }
          if (section === 'phones') body.phones = draft.phones
          const data = await request('POST', 'config/save', body)
          setConfig(data)
          setDraft((prev) => ({
            ...prev,
            schedule: { enabled: data.schedule.enabled, time: data.schedule.time, providers: [...data.schedule.providers] },
            notify: { ...prev.notify, openid: String(data.notify.target ?? '').replace(/^c2c:/, ''), appSecret: '' },
          }))
          dirtyRef.current = false
          setStatus({ kind: 'ok', text: zh.saved })
        } catch (error) {
          setStatus({ kind: 'err', text: zh.saveFailed + String(error.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      const saveButton = (section) =>
        h('button', {
          onClick: () => saveSection(section),
          disabled: busy,
          style: { ...buttonStyle, marginTop: 10, fontWeight: 600 },
        }, busy ? zh.saving : zh.save)

      const sendLoginCode = async (provider) => {
        if (draft === null || loginState[provider].busy) return
        patchLogin(provider, { busy: true, msg: null })
        try {
          await request('POST', 'login/send', { provider, phone: draft.phones[provider].trim() })
          patchLogin(provider, { busy: false, msg: { kind: 'ok', text: zh.codeSent } })
        } catch (error) {
          patchLogin(provider, { busy: false, msg: { kind: 'err', text: String(error.message ?? error) } })
        }
      }

      const verifyLoginCode = async (provider) => {
        if (draft === null || loginState[provider].busy) return
        const code = loginState[provider].code.trim()
        if (code === '') {
          patchLogin(provider, { msg: { kind: 'err', text: zh.needCode } })
          return
        }
        patchLogin(provider, { busy: true, msg: null })
        try {
          const data = await request('POST', 'login/verify', { provider, code })
          setConfig(data)
          setDraft((prev) => ({ ...prev, phones: { ...data.phones } }))
          patchLogin(provider, { busy: false, code: '', msg: { kind: 'ok', text: zh.bindOk } })
        } catch (error) {
          patchLogin(provider, { busy: false, msg: { kind: 'err', text: String(error.message ?? error) } })
        }
      }

      const loginBlock = (provider) => {
        const account = config.accounts?.[provider] ?? null
        const state = loginState[provider]
        return h('div', {
          key: provider,
          style: {
            marginTop: 10,
            padding: 10,
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
            background: 'var(--dsw-alias-bg-layer-1, transparent)',
          },
        },
          h('div', { style: { fontWeight: 600 } },
            `${zh['name_' + provider]}${account ? ` · 已绑定 uid=${account.uid || '?'}` : ' · 未绑定'}`),
          h(Row, { style: { marginTop: 6 } },
            h('input', {
              style: { ...inputStyle, marginTop: 0, flex: 1 },
              value: draft.phones[provider],
              placeholder: '11 位手机号',
              onChange: (event) => patch('phones', provider, event.target.value),
            }),
            h('button', {
              onClick: () => sendLoginCode(provider),
              disabled: state.busy,
              style: { ...buttonStyle, marginTop: 0, whiteSpace: 'nowrap' },
            }, zh.sendCode)),
          h(Row, null,
            h('input', {
              style: { ...inputStyle, marginTop: 0, flex: 1 },
              value: state.code,
              placeholder: zh.code,
              onChange: (event) => patchLogin(provider, { code: event.target.value }),
            }),
            h('button', {
              onClick: () => verifyLoginCode(provider),
              disabled: state.busy,
              style: { ...buttonStyle, marginTop: 0, fontWeight: 600, whiteSpace: 'nowrap' },
            }, zh.bind)),
          state.msg !== null
            ? h('div', {
              style: {
                marginTop: 6,
                fontSize: 12,
                color: state.msg.kind === 'err' ? 'var(--dsw-alias-label-error, #c62828)' : 'var(--dsw-alias-state-success-primary, #2e7d32)',
              },
            }, state.msg.text)
            : null)
      }

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      const runNow = async () => {
        if (busy) return
        setBusy(true)
        setRunResult(null)
        setStatus({ kind: 'ok', text: '已开始签到，完成后会自动刷新结果…' })
        try {
          const before = config?.reportAt ?? ''
          await request('POST', 'run', { push: true })
          for (let attempt = 0; attempt < 60; attempt += 1) {
            await sleep(1500)
            const data = await request('GET', 'config')
            setConfig(data)
            if ((data.reportAt ?? '') !== before) {
              setRunResult({ ok: data.reportOk, at: data.reportAt, lines: data.reportLines ?? [] })
              setStatus({ kind: 'ok', text: '签到完成' })
              break
            }
          }
        } catch (error) {
          setStatus({ kind: 'err', text: String(error.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      if (config === null || draft === null) {
        return h('div', { style: { padding: 12, fontSize: 13 } }, status?.text ?? '读取中…')
      }

      const name = (id) => zh[`name_${id}`] ?? id

      const timeParts = String(draft.schedule.time || '00:00').split(':')
      const hourValue = String(Math.min(23, Math.max(0, Number(timeParts[0]) || 0))).padStart(2, '0')
      const minuteValue = String(Math.min(59, Math.max(0, Number(timeParts[1]) || 0))).padStart(2, '0')
      const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
      const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'))
      if (!MINUTES.includes(minuteValue)) MINUTES.push(minuteValue)
      MINUTES.sort()
      const timeSelectStyle = { ...inputStyle, marginTop: 0, width: 96 }
      const setHour = (value) => patch('schedule', 'time', value + ':' + minuteValue)
      const setMinute = (value) => patch('schedule', 'time', hourValue + ':' + value)

      return h(
        'div',
        { style: { padding: '4px 2px 8px', fontSize: 13 } },
        h('div', { style: { fontWeight: 600, fontSize: 14 } }, zh.title),
        h('div', { style: { color: 'var(--dsw-alias-label-secondary, inherit)', marginTop: 2 } }, zh.subtitle),
        h('div', { style: { marginTop: 6, color: 'var(--dsw-alias-label-primary, inherit)' } },
          `当前生效：${config.schedule.enabled ? '每天 ' + config.schedule.time : '定时已停用'} · 平台 ${(config.schedule.providers ?? []).map((id) => zh['name_' + id] ?? id).join('、')} · 推送 ${config.notify.enabled ? '开' : '关'}`),

        h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l2, rgba(127,127,127,.3))', margin: '12px 0' } }),

        h(Label, null, zh.schedule),
        h(Row, null,
          h('input', { type: 'checkbox', checked: draft.schedule.enabled, onChange: (event) => patch('schedule', 'enabled', event.target.checked) }),
          h('span', null, zh.enabled)),
        h(Label, null, zh.time),
        h(Row, null,
          h('select', { style: timeSelectStyle, value: hourValue, onChange: (event) => setHour(event.target.value) },
            HOURS.map((value) => h('option', { key: 'h' + value, value }, value))),
          h('span', null, '时'),
          h('select', { style: timeSelectStyle, value: minuteValue, onChange: (event) => setMinute(event.target.value) },
            MINUTES.map((value) => h('option', { key: 'm' + value, value }, value))),
          h('span', null, '分')),
        h(Label, null, zh.providers),
        h(Row, null,
          ['kuro', 'skland', 'nte'].map((id) =>
            h('label', { key: id, style: { display: 'flex', alignItems: 'center', gap: 4, marginRight: 12 } },
              h('input', { type: 'checkbox', checked: draft.schedule.providers.includes(id), onChange: () => toggleProvider(id) }),
              h('span', null, name(id))))),
        saveButton('schedule'),

        h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l2, rgba(127,127,127,.3))', margin: '14px 0' } }),

        h(Label, null, zh.push),
        h(Row, null,
          h('input', { type: 'checkbox', checked: draft.notify.enabled, onChange: (event) => patch('notify', 'enabled', event.target.checked) }),
          h('span', null, zh.pushEnabled)),
        h(Label, null, zh.target),
        h('input', {
          style: inputStyle,
          value: draft.notify.openid,
          placeholder: 'openid',
          onChange: (event) => patch('notify', 'openid', event.target.value),
        }),
        h(Label, null, zh.appId),
        h('input', { style: inputStyle, value: draft.notify.appId, placeholder: '你的机器人 AppID', onChange: (event) => patch('notify', 'appId', event.target.value) }),
        h(Label, null, zh.appSecret),
        h('input', {
          style: inputStyle,
          type: 'password',
          value: draft.notify.appSecret,
          placeholder: config.notify.hasSecret ? zh.secretSaved : '',
          onChange: (event) => patch('notify', 'appSecret', event.target.value),
        }),
        saveButton('notify'),

        h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l2, rgba(127,127,127,.3))', margin: '14px 0' } }),

        h(Label, null, zh.loginHint),
        loginBlock('kuro'),
        loginBlock('skland'),
        loginBlock('nte'),

        h(Row, { style: { marginTop: 16 } },
          h('button', {
            onClick: runNow,
            disabled: busy,
            style: buttonStyle,
          }, busy ? zh.running : zh.run)),

        status !== null
          ? h('div', { style: { marginTop: 8, color: status.kind === 'err' ? 'var(--dsw-alias-label-error, #c62828)' : 'var(--dsw-alias-state-success-primary, #2e7d32)' } }, status.text)
          : null,

        runResult !== null
          ? h('pre', {
            style: { marginTop: 10, padding: 8, background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1))', color: 'var(--dsw-alias-label-primary, inherit)', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', borderRadius: 6, whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 260, overflow: 'auto' },
          }, `${runResult.ok ? '全部完成' : '有失败项'} ${runResult.at}\n${(runResult.lines ?? []).join('\n')}`)
          : null,

        h('div', { style: { marginTop: 12, color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 12 } },
          `${zh.nextRun}：${formatTime(config.nextRunAt)}`),
        h('div', { style: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 12 } },
          `${zh.lastRun}：${formatTime(config.schedule.lastRunAt)}`),
        h('div', { style: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 12 } },
          `${zh.report}：${config.reportAt || zh.never}`),
        h('div', { style: { color: 'var(--dsw-alias-label-secondary, inherit)', fontSize: 12 } },
          `${zh.lastPush}：${formatTime(config.schedule.lastPushAt)}${config.schedule.lastPushOk === false ? `（${config.schedule.lastPushError || '失败'}）` : ''}`),
      )
    }

    // ------------------------------------------------------------------ 注册

    return {
      inject: ['slots'],

      apply(ctx) {
        if (ctx?.slots === undefined) return
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: PLUGIN_KEY,
              order: 46,
              label: () => '每日签到',
            },
            Panel,
          ))
      },
    }
  },
})
