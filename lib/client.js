/**
 * dsh-plugin-session-delete — browser half.
 *
 * Adds a destructive "删除会话 / Delete session" entry to the sidebar session
 * row menu, plus the confirmation dialog that guards it. DSH ships archive but
 * no delete, so this plugin contributes the missing verb through the two slots
 * the shipped workspace browser already declares for client plugins:
 * `sidebar.workspaces.session.menu.item` (the "..." menu row) and
 * `shell.overlay` (the modal).
 *
 * Everything destructive happens on the host half; this file only collects the
 * user's intent, shows the host's refusal reason verbatim when the session
 * cannot be deleted, and asks for one explicit acknowledgement before issuing
 * the request. The request carries the plugin's own marker header so a stray
 * cross-site post cannot reach the mutation route.
 *
 * Bundle contract: `window.__ModuleLoader__.load({ id, factory })`. The only
 * externals are the platform seed modules (`react`, the shared UI primitives),
 * so this file stays a single self-contained bundle with no chunk siblings.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-delete',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    var h = React.createElement;

    /** Route prefix owned by the host half. */
    var BASE = '/session-delete';

    /** Marker header the host mutation route requires. */
    var MARKER_HEADER = 'x-dsh-session-delete';

    /** Locale namespace owned by this plugin. */
    var NS = 'dsh-session-delete';

    /**
     * A minimal observable matching the slot renderer's source contract
     * (`getSnapshot` + `subscribe`), so an inject face can expose it as a
     * `use<Name>` selector hook without pulling in another package.
     * @param initial - the first snapshot.
     * @returns the store handle.
     */
    function createObservable(initial) {
      var value = initial;
      var listeners = new Set();
      return {
        getSnapshot: function () {
          return value;
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () {
            listeners.delete(listener);
          };
        },
        set: function (next) {
          value = next;
          for (var fn of Array.from(listeners)) fn();
        },
      };
    }

    /**
     * Call one host route on this plugin's prefix.
     *
     * Never throws for a transport or business failure: the caller decides what
     * a refusal means, so both outcomes arrive as the same shaped result.
     *
     * @param path - route path below the prefix.
     * @param init - fetch init; the marker header is added for mutations.
     * @returns `{ ok, status, data, error }`.
     */
    async function callHost(path, init) {
      var options = init || {};
      var headers = Object.assign({ accept: 'application/json' }, options.headers || {});
      if (options.method === 'POST') headers[MARKER_HEADER] = '1';
      try {
        var response = await fetch(BASE + path, Object.assign({}, options, { headers: headers, cache: 'no-store' }));
        var data = null;
        try {
          data = await response.json();
        } catch (error) {
          return { ok: false, status: response.status, data: null, error: '服务器返回了非 JSON 响应' };
        }
        if (!response.ok || data === null || data.ok !== true) {
          return {
            ok: false,
            status: response.status,
            data: data,
            error: (data && data.error) || 'HTTP ' + String(response.status),
          };
        }
        return { ok: true, status: response.status, data: data, error: null };
      } catch (error) {
        return { ok: false, status: 0, data: null, error: String((error && error.message) || error) };
      }
    }

    /** Dictionaries. Keys are shared by both entries so one namespace serves all. */
    var zh = {
      'menu.delete': '删除会话',
      'dialog.title': '删除会话',
      'dialog.desc': '将永久删除“{name}”的完整对话记录，此操作无法撤销。',
      'dialog.detail': '会话日志文件会从磁盘上移除；它所在的工作区、置顶与归档记录也会一并清理。',
      'dialog.children': '该会话有 {count} 个派生的子会话，子会话会保留，但其父级引用将失效。',
      'dialog.ack': '我明白删除后无法恢复',
      'dialog.cancel': '取消',
      'dialog.confirm': '永久删除',
      'dialog.close': '关闭',
      'dialog.checking': '正在检查该会话…',
      'dialog.deleting': '正在删除…',
      'blocked.title': '无法删除',
      'blocked.not-found': '该会话已不存在，可能已被删除。',
      'blocked.live': '该会话正在本应用中被打开或持有，请先切换到其他会话再试。',
      'blocked.running': '该会话正在运行，请先停止它再删除。',
      'blocked.other': '该会话当前无法删除。',
      'toast.done': '已删除会话：{name}',
      'toast.refresh': '会话列表未能刷新，请手动刷新页面。',
      'menu.batch': '批量删除会话…',
      'batch.title': '批量删除会话',
      'batch.checking': '正在检查会话…',
      'batch.desc': '共 {total} 个可删除的会话，已选中 {count} 个。删除后无法恢复。',
      'batch.selectAll': '全选可删除的会话',
      'batch.none': '当前没有可删除的会话。',
      'batch.empty': '没有选中任何会话。',
      'batch.undeletable.running': '运行中',
      'batch.undeletable.live': '已打开',
      'batch.undeletable.not-found': '已不存在',
      'batch.undeletable.other': '不可删除',
      'batch.ack': '我明白删除后无法恢复',
      'batch.cancel': '取消',
      'batch.close': '关闭',
      'batch.confirm': '删除选中的 {count} 个会话',
      'batch.deleting': '正在删除…',
      'batch.toast.done': '已删除 {count} 个会话',
      'batch.toast.partial': '已删除 {deleted} 个，跳过 {skipped} 个',
    };

    var en = {
      'menu.delete': 'Delete session',
      'dialog.title': 'Delete session',
      'dialog.desc': 'This permanently deletes the entire conversation of “{name}”. It cannot be undone.',
      'dialog.detail': 'The session log is removed from disk, together with its workspace accounting, pin, and archive records.',
      'dialog.children': 'This session has {count} derived child session(s). They are kept, but their parent reference will dangle.',
      'dialog.ack': 'I understand this cannot be undone',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete permanently',
      'dialog.close': 'Close',
      'dialog.checking': 'Checking this session…',
      'dialog.deleting': 'Deleting…',
      'blocked.title': 'Cannot delete',
      'blocked.not-found': 'This session no longer exists; it may already have been deleted.',
      'blocked.live': 'This session is open or retained in this app. Switch to another session first.',
      'blocked.running': 'This session is running. Stop it before deleting.',
      'blocked.other': 'This session cannot be deleted right now.',
      'toast.done': 'Deleted session: {name}',
      'toast.refresh': 'The session list could not be refreshed; reload the page.',
      'menu.batch': 'Delete multiple sessions…',
      'batch.title': 'Delete multiple sessions',
      'batch.checking': 'Checking sessions…',
      'batch.desc': '{total} session(s) can be deleted; {count} selected. This cannot be undone.',
      'batch.selectAll': 'Select every deletable session',
      'batch.none': 'No session can be deleted right now.',
      'batch.empty': 'No session is selected.',
      'batch.undeletable.running': 'Running',
      'batch.undeletable.live': 'Open',
      'batch.undeletable.not-found': 'Gone',
      'batch.undeletable.other': 'Not deletable',
      'batch.ack': 'I understand this cannot be undone',
      'batch.cancel': 'Cancel',
      'batch.close': 'Close',
      'batch.confirm': 'Delete {count} selected session(s)',
      'batch.deleting': 'Deleting…',
      'batch.toast.done': 'Deleted {count} session(s)',
      'batch.toast.partial': 'Deleted {deleted}, skipped {skipped}',
    };

    /**
     * The "..." menu row: opens the confirmation flow for one session.
     * @param props - row identity, the owner's menu-open hook, and this plugin's face.
     * @returns the menu row.
     */
    function DeleteSessionMenuItem(props) {
      var sessionId = props.sessionId;
      var displayTitle = props.displayTitle;
      var useMenuOpenState = props.useMenuOpenState;
      var t = props.t;
      var requestDelete = props.requestDelete;
      var openState = useMenuOpenState();
      var setMenuOpen = openState[1];
      var title = displayTitle || sessionId;
      return h(
        primitives.MenuItemButton,
        {
          separatorBefore: true,
          danger: true,
          icon: h(primitives.IconTrashOutlineRegular, { size: 14 }),
          onSelect: function () {
            setMenuOpen(false);
            requestDelete(sessionId, title);
          },
        },
        t('menu.delete'),
      );
    }

    /**
     * The `shell.overlay` entry: the check/confirm/delete dialog for the one
     * pending request, or nothing while no request is pending.
     * @param props - the request hook, the action callbacks, and the locale seat.
     * @returns the dialog, or null.
     */
    function DeleteSessionDialog(props) {
      var useRequest = props.useRequest;
      var t = props.t;
      var request = useRequest(function (value) {
        return value;
      });
      if (request === null || request === undefined) return null;
      // `key` must ride in props: this file uses createElement, where a third
      // argument is a child, not the automatic runtime's key seat.
      return h(DeleteSessionDialogBody, {
        key: request.token,
        request: request,
        cancelDelete: props.cancelDelete,
        confirmDelete: props.confirmDelete,
        t: t,
      });
    }

    /**
     * One request's dialog body. Acknowledgement, in-flight state, and error
     * text die with the request because the parent keys this component by the
     * request token.
     */
    function DeleteSessionDialogBody(props) {
      var request = props.request;
      var t = props.t;
      var acknowledgedPair = React.useState(false);
      var acknowledged = acknowledgedPair[0];
      var setAcknowledged = acknowledgedPair[1];
      var blocked = request.phase === 'blocked';
      var busy = request.phase === 'checking' || request.phase === 'deleting';

      var description;
      if (request.phase === 'checking') description = t('dialog.checking');
      else if (blocked) description = t('blocked.' + (request.reason || 'other'));
      else description = t('dialog.desc', { name: request.title });

      var body = [];
      if (blocked) {
        body.push(
          h('div', { key: 'blocked', className: 'dsh-session-delete-note', role: 'alert' }, description),
        );
      } else {
        body.push(h('p', { key: 'desc', className: 'dsh-session-delete-desc' }, description));
        if (request.phase === 'confirm' || request.phase === 'deleting' || request.phase === 'error') {
          body.push(h('p', { key: 'detail', className: 'dsh-session-delete-detail' }, t('dialog.detail')));
        }
        if (request.childCount > 0) {
          body.push(
            h('p', { key: 'children', className: 'dsh-session-delete-detail' },
              t('dialog.children', { count: String(request.childCount) })),
          );
        }
      }
      if (request.phase === 'deleting') {
        body.push(h('div', { key: 'pending', className: 'dsh-session-delete-note', role: 'status' }, t('dialog.deleting')));
      }
      if (request.phase === 'error') {
        body.push(h('div', { key: 'error', className: 'dsh-session-delete-error', role: 'alert' }, request.error));
      }
      if (request.phase === 'confirm') {
        body.push(
          h('label', { key: 'ack', className: 'dsh-session-delete-ack' },
            h('input', {
              type: 'checkbox',
              checked: acknowledged,
              'data-modal-autofocus': true,
              onChange: function (event) {
                setAcknowledged(event.currentTarget.checked);
              },
            }),
            h('span', null, t('dialog.ack')),
          ),
        );
      }

      var footer = blocked
        ? h(primitives.Button, { variant: 'outline', onClick: props.cancelDelete }, t('dialog.close'))
        : h(React.Fragment, null,
            h(primitives.Button, { variant: 'outline', disabled: request.phase === 'deleting', onClick: props.cancelDelete }, t('dialog.cancel')),
            h(primitives.Button, {
              variant: 'primary',
              className: 'dsh-session-delete-confirm',
              disabled: busy || !acknowledged,
              onClick: props.confirmDelete,
            }, t('dialog.confirm')),
          );

      return h(primitives.Modal, {
        open: true,
        onClose: props.cancelDelete,
        closeLabel: t('dialog.close'),
        title: blocked ? t('blocked.title') : t('dialog.title'),
        footer: footer,
        className: 'dsh-session-delete-dialog',
      }, body);
    }

    /** Styles for the dialog's own copy; the shell owns the modal chrome. */
    var CSS = [
      '.dsh-session-delete-desc{margin:0 0 8px;font-size:14px;line-height:1.55;}',
      '.dsh-session-delete-detail{margin:0 0 12px;font-size:13px;line-height:1.6;opacity:.72;}',
      '.dsh-session-delete-note{margin:0 0 12px;font-size:13px;line-height:1.6;opacity:.82;}',
      '.dsh-session-delete-error{margin:0 0 12px;padding:8px 10px;border-radius:6px;font-size:13px;line-height:1.5;background:rgba(220,60,60,.12);color:#e06a6a;overflow-wrap:anywhere;}',
      '.dsh-session-delete-ack{display:flex;gap:8px;align-items:flex-start;margin-top:4px;font-size:13px;line-height:1.5;cursor:pointer;}',
      '.dsh-session-delete-ack input{margin:2px 0 0;}',
      // The shipped workspace-delete dialog marks its destructive confirm button
      // the same way: the shared Button has no danger variant, so the error
      // colour rides in as an override.
      '.dsh-session-delete-confirm:not(:disabled){color:var(--dsw-alias-state-error-primary);}',
      // Batch selection list: a bounded scroller so a 200-session workspace does
      // not push the dialog's footer off-screen.
      '.dsh-session-delete-list{max-height:320px;overflow-y:auto;margin:4px 0 12px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l4);}',
      '.dsh-session-delete-item{display:flex;gap:8px;align-items:flex-start;padding:6px 10px;font-size:13px;line-height:1.45;cursor:pointer;}',
      '.dsh-session-delete-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsh-session-delete-item input{margin:3px 0 0;flex:none;}',
      '.dsh-session-delete-itemText{min-width:0;flex:1;}',
      '.dsh-session-delete-itemTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsh-session-delete-itemMeta{font-size:12px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsh-session-delete-item.dsh-session-delete-itemBlocked{cursor:default;opacity:.55;}',
      '.dsh-session-delete-item.dsh-session-delete-itemBlocked:hover{background:transparent;}',
      '.dsh-session-delete-badge{flex:none;font-size:11px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);opacity:.85;}',
      '.dsh-session-delete-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;}',
    ].join('');

    /** Required client services. */
    var inject = ['slots', 'locale'];

    /**
     * Register the dictionaries, the menu row, and the dialog.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, 'dsh-session-delete: dictionaries');

      ctx.effect(function () {
        if (typeof document === 'undefined') return function () {};
        var tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-plugin-session-delete';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return function () {
          tag.remove();
        };
      }, 'dsh-session-delete: styles');

      /** The single pending delete request, or null. */
      var requestStore = createObservable(null);
      var tokenSeq = 0;

      /** Show one host refusal in the dialog instead of a confirmation. */
      var block = function (token, sessionId, title, reason, error) {
        if (requestStore.getSnapshot()?.token !== token) return;
        requestStore.set({
          token: token,
          sessionId: sessionId,
          title: title,
          phase: 'blocked',
          reason: reason,
          error: error || null,
          childCount: 0,
        });
      };

      /**
       * Open the flow for one row: check first, then confirm or refuse.
       * @param sessionId - the row's session identity.
       * @param title - the row's display title.
       */
      var requestDelete = async function (sessionId, title) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return;
        tokenSeq += 1;
        var token = tokenSeq;
        requestStore.set({ token: token, sessionId: sessionId, title: title, phase: 'checking', reason: null, error: null, childCount: 0 });

        var result = await callHost('/check?sessionId=' + encodeURIComponent(sessionId), { method: 'GET' });
        if (requestStore.getSnapshot()?.token !== token) return;
        if (!result.ok) {
          block(token, sessionId, title, 'other', result.error);
          return;
        }
        var check = result.data.check || {};
        if (check.deletable !== true) {
          block(token, sessionId, title, check.reason || 'other', null);
          return;
        }
        requestStore.set({
          token: token,
          sessionId: sessionId,
          title: title,
          phase: 'confirm',
          reason: null,
          error: null,
          childCount: typeof check.childCount === 'number' ? check.childCount : 0,
        });
      };

      /** Dismiss the pending request unless it is mid-flight. */
      var cancelDelete = function () {
        var current = requestStore.getSnapshot();
        if (current === null || current.phase === 'deleting') return;
        requestStore.set(null);
      };

      /** Ask the host to delete, then drop the row and report the outcome. */
      var confirmDelete = async function () {
        var current = requestStore.getSnapshot();
        if (current === null || current.phase !== 'confirm') return;
        var token = current.token;
        requestStore.set(Object.assign({}, current, { phase: 'deleting', error: null }));

        var result = await callHost('/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: current.sessionId }),
        });
        if (requestStore.getSnapshot()?.token !== token) return;

        if (!result.ok) {
          var reason = result.data && result.data.code === 'not-found' ? 'not-found'
            : result.data && result.data.code === 'live' ? 'live'
              : result.data && result.data.code === 'running' ? 'running'
                : 'other';
          if (reason !== 'other') {
            block(token, current.sessionId, current.title, reason, null);
            return;
          }
          requestStore.set(Object.assign({}, current, { phase: 'error', error: result.error }));
          return;
        }

        requestStore.set(null);
        toastStore.set({
          seq: (toastStore.getSnapshot()?.seq ?? 0) + 1,
          text: { key: 'toast.done', params: { name: current.title } },
        });
        // The host's `api-session/removed` notice drops the row; this refresh
        // is the belt-and-braces path for a dropped or missed event.
        var sessions = ctx.get('sessions');
        if (sessions !== undefined && typeof sessions.refresh === 'function') {
          sessions.refresh().catch(function () {
            toastStore.set({
              seq: (toastStore.getSnapshot()?.seq ?? 0) + 1,
              text: { key: 'toast.refresh', params: {} },
            });
          });
        }
      };

      /** Transient completion notice. */
      var toastStore = createObservable(null);

      /** The `shell.overlay` entry rendering that notice. */
      function DeleteToast(props) {
        var useToast = props.useToast;
        var t = props.t;
        var toast = useToast(function (value) {
          return value;
        });
        if (toast === null || toast === undefined) return null;
        return h(primitives.Toast, {
          key: toast.seq,
          text: t(toast.text.key, toast.text.params),
          tone: 'default',
          onDone: function () {
            if (toastStore.getSnapshot()?.seq === toast.seq) toastStore.set(null);
          },
        });
      }

      /** The pending batch request, or null. */
      var batchStore = createObservable(null);
      var batchTokenSeq = 0;

      /**
       * Read every deletable session from the live list.
       *
       * Rows that are running, open in this app, or already gone are returned
       * separately as blocked, so the dialog can show why they are excluded
       * instead of silently omitting them.
       *
       * @returns `{ rows }` in list order, each row carrying its own state.
       */
      var collectCandidates = function () {
        var sessions = ctx.get('sessions');
        var list = sessions?.list?.getSnapshot?.();
        if (list === undefined || list === null) return { rows: [] };
        var rows = [];
        var ids = Array.isArray(list.ids) ? list.ids : [];
        for (var i = 0; i < ids.length; i += 1) {
          var id = ids[i];
          var row = list.byId?.[id];
          if (row === undefined) continue;
          // Subagent rows and the current blank session are not user-facing
          // sessions the sidebar would let you delete.
          if (row.origin === 'subagent') continue;
          if (row.blank === true) continue;
          rows.push({
            sessionId: id,
            title: row.displayTitle || row.title || id,
            running: row.running === true,
            cwd: typeof row.cwd === 'string' ? row.cwd : null,
          });
        }
        return { rows: rows };
      };

      /**
       * Open the batch flow: collect the visible sessions, then ask the host
       * which of them may actually be deleted.
       */
      var requestBatchDelete = async function () {
        batchTokenSeq += 1;
        var token = batchTokenSeq;
        batchStore.set({ token: token, phase: 'checking', rows: [], selected: {}, error: null });

        var collected = collectCandidates();
        if (collected.rows.length === 0) {
          batchStore.set({ token: token, phase: 'empty', rows: [], selected: {}, error: null });
          return;
        }

        var result = await callHost('/check-many', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionIds: collected.rows.map(function (row) { return row.sessionId; }) }),
        });
        if (batchStore.getSnapshot()?.token !== token) return;

        if (!result.ok) {
          batchStore.set({ token: token, phase: 'error', rows: [], selected: {}, error: result.error });
          return;
        }

        // Merge the host's verdict onto the rows the list gave us, preserving
        // the sidebar's own order.
        var verdicts = {};
        var checks = Array.isArray(result.data.checks) ? result.data.checks : [];
        for (var j = 0; j < checks.length; j += 1) verdicts[checks[j].sessionId] = checks[j];
        var rows = [];
        for (var k = 0; k < collected.rows.length; k += 1) {
          var base = collected.rows[k];
          var check = verdicts[base.sessionId];
          rows.push({
            sessionId: base.sessionId,
            title: base.title,
            running: base.running,
            deletable: check?.deletable === true,
            reason: check?.deletable === true ? null : (check?.reason ?? 'other'),
          });
        }

        // Pre-select everything deletable: the common case is "clean these up".
        var selected = {};
        var deletableCount = 0;
        for (var m = 0; m < rows.length; m += 1) {
          if (!rows[m].deletable) continue;
          selected[rows[m].sessionId] = true;
          deletableCount += 1;
        }
        batchStore.set({
          token: token,
          phase: deletableCount === 0 ? 'none' : 'confirm',
          rows: rows,
          selected: selected,
          error: null,
        });
      };

      /** Dismiss the batch dialog unless a delete is in flight. */
      var cancelBatch = function () {
        var current = batchStore.getSnapshot();
        if (current === null || current.phase === 'deleting') return;
        batchStore.set(null);
      };

      /** Toggle one row's selection. */
      var toggleBatchRow = function (sessionId, checked) {
        var current = batchStore.getSnapshot();
        if (current === null || current.phase === 'deleting') return;
        var selected = Object.assign({}, current.selected);
        if (checked) selected[sessionId] = true;
        else delete selected[sessionId];
        batchStore.set(Object.assign({}, current, { selected: selected }));
      };

      /** Select or clear every deletable row. */
      var setBatchAll = function (checked) {
        var current = batchStore.getSnapshot();
        if (current === null || current.phase === 'deleting') return;
        var selected = {};
        if (checked) {
          for (var i = 0; i < current.rows.length; i += 1) {
            if (current.rows[i].deletable) selected[current.rows[i].sessionId] = true;
          }
        }
        batchStore.set(Object.assign({}, current, { selected: selected }));
      };

      /** Delete every selected row in one request, then report the outcome. */
      var confirmBatchDelete = async function () {
        var current = batchStore.getSnapshot();
        if (current === null || current.phase !== 'confirm') return;
        var token = current.token;
        var sessionIds = Object.keys(current.selected);
        if (sessionIds.length === 0) return;

        batchStore.set(Object.assign({}, current, { phase: 'deleting', error: null }));
        var result = await callHost('/delete-many', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionIds: sessionIds }),
        });
        if (batchStore.getSnapshot()?.token !== token) return;

        if (!result.ok) {
          batchStore.set(Object.assign({}, current, { phase: 'error', error: result.error }));
          return;
        }

        var deleted = Array.isArray(result.data.deleted) ? result.data.deleted.length : 0;
        var skipped = Array.isArray(result.data.skipped) ? result.data.skipped.length : 0;
        batchStore.set(null);
        toastStore.set({
          seq: (toastStore.getSnapshot()?.seq ?? 0) + 1,
          text: skipped === 0
            ? { key: 'batch.toast.done', params: { count: String(deleted) } }
            : { key: 'batch.toast.partial', params: { deleted: String(deleted), skipped: String(skipped) } },
        });
        var sessions = ctx.get('sessions');
        if (sessions !== undefined && typeof sessions.refresh === 'function') {
          sessions.refresh().catch(function () {
            toastStore.set({
              seq: (toastStore.getSnapshot()?.seq ?? 0) + 1,
              text: { key: 'toast.refresh', params: {} },
            });
          });
        }
      };

      /**
       * The batch dialog: one checkbox per visible session, with undeletable
       * rows shown greyed out and labelled rather than hidden.
       * @param props - the batch hook, the row actions, and the locale seat.
       * @returns the dialog, or null.
       */
      function BatchDeleteDialog(props) {
        var useBatch = props.useBatch;
        var t = props.t;
        var batch = useBatch(function (value) {
          return value;
        });
        if (batch === null || batch === undefined) return null;
        return h(BatchDeleteForm, {
          key: batch.token,
          batch: batch,
          cancelBatch: props.cancelBatch,
          confirmBatchDelete: props.confirmBatchDelete,
          toggleBatchRow: props.toggleBatchRow,
          setBatchAll: props.setBatchAll,
          t: t,
        });
      }

      /** One batch's form; acknowledgement and in-flight state die with the token. */
      function BatchDeleteForm(props) {
        var batch = props.batch;
        var t = props.t;
        var ackPair = React.useState(false);
        var acknowledged = ackPair[0];
        var setAcknowledged = ackPair[1];
        var busy = batch.phase === 'checking' || batch.phase === 'deleting';

        var deletable = 0;
        for (var i = 0; i < batch.rows.length; i += 1) if (batch.rows[i].deletable) deletable += 1;
        var selectedCount = Object.keys(batch.selected).length;

        var body = [];
        if (batch.phase === 'checking') {
          body.push(h('p', { key: 'checking', className: 'dsh-session-delete-desc' }, t('batch.checking')));
        } else if (batch.phase === 'empty') {
          body.push(h('p', { key: 'empty', className: 'dsh-session-delete-note' }, t('batch.empty')));
        } else if (batch.phase === 'none') {
          body.push(h('p', { key: 'none', className: 'dsh-session-delete-note' }, t('batch.none')));
        } else {
          body.push(h('p', { key: 'desc', className: 'dsh-session-delete-desc' },
            t('batch.desc', { total: String(deletable), count: String(selectedCount) })));

          if (batch.phase === 'confirm') {
            body.push(h('div', { key: 'toolbar', className: 'dsh-session-delete-toolbar' },
              h(primitives.Checkbox, {
                checked: deletable > 0 && selectedCount === deletable,
                disabled: busy || deletable === 0,
                label: t('batch.selectAll'),
                onChange: function (checked) { props.setBatchAll(checked); },
              })));
          }

          var items = [];
          // Reasons the host can report for a non-deletable session; anything
          // else falls back to the generic label rather than printing a key.
          var knownReasons = { running: true, live: true, 'not-found': true };
          for (var j = 0; j < batch.rows.length; j += 1) {
            var row = batch.rows[j];
            var meta = [];
            if (row.deletable !== true) {
              var reasonKey = knownReasons[row.reason] === true ? row.reason : 'other';
              meta.push(t('batch.undeletable.' + reasonKey));
            }
            items.push(h('label', {
              key: row.sessionId,
              className: 'dsh-session-delete-item' + (row.deletable ? '' : ' dsh-session-delete-itemBlocked'),
            },
              h('input', {
                type: 'checkbox',
                checked: batch.selected[row.sessionId] === true,
                disabled: busy || !row.deletable,
                onChange: function (sessionId) {
                  return function (event) { props.toggleBatchRow(sessionId, event.currentTarget.checked); };
                }(row.sessionId),
              }),
              h('span', { className: 'dsh-session-delete-itemText' },
                h('span', { className: 'dsh-session-delete-itemTitle' }, row.title),
                meta.length > 0 ? h('span', { className: 'dsh-session-delete-itemMeta' }, meta.join(' · ')) : null),
            ));
          }
          body.push(h('div', { key: 'list', className: 'dsh-session-delete-list' }, items));

          if (batch.phase === 'confirm' || batch.phase === 'deleting') {
            body.push(h('label', { key: 'ack', className: 'dsh-session-delete-ack' },
              h('input', {
                type: 'checkbox',
                checked: acknowledged,
                disabled: busy,
                'data-modal-autofocus': true,
                onChange: function (event) { setAcknowledged(event.currentTarget.checked); },
              }),
              h('span', null, t('batch.ack'))));
          }
        }
        if (batch.phase === 'deleting') {
          body.push(h('div', { key: 'pending', className: 'dsh-session-delete-note', role: 'status' }, t('batch.deleting')));
        }
        if (batch.phase === 'error' && batch.error !== null) {
          body.push(h('div', { key: 'error', className: 'dsh-session-delete-error', role: 'alert' }, batch.error));
        }

        var canConfirm = batch.phase === 'confirm' && selectedCount > 0 && acknowledged && !busy;
        var footer = batch.phase === 'confirm' || batch.phase === 'deleting' || batch.phase === 'error'
          ? h(React.Fragment, null,
              h(primitives.Button, { variant: 'outline', disabled: busy, onClick: props.cancelBatch }, t('batch.cancel')),
              h(primitives.Button, {
                variant: 'primary',
                className: 'dsh-session-delete-confirm',
                disabled: !canConfirm,
                onClick: props.confirmBatchDelete,
              }, t('batch.confirm', { count: String(selectedCount) })))
          : h(primitives.Button, { variant: 'outline', onClick: props.cancelBatch }, t('batch.close'));

        return h(primitives.Modal, {
          open: true,
          onClose: props.cancelBatch,
          closeLabel: t('batch.close'),
          title: t('batch.title'),
          footer: footer,
          className: 'dsh-session-delete-dialog',
        }, body);
      }

      /** The menu row that opens the batch flow. */
      function BatchDeleteMenuItem(props) {
        var useMenuOpenState = props.useMenuOpenState;
        var t = props.t;
        var requestBatchDelete = props.requestBatchDelete;
        var openState = useMenuOpenState();
        var setMenuOpen = openState[1];
        return h(primitives.MenuItemButton, {
          separatorBefore: true,
          icon: h(primitives.IconTrashOutlineRegular, { size: 14 }),
          onSelect: function () {
            setMenuOpen(false);
            requestBatchDelete();
          },
        }, t('menu.batch'));
      }

      ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
        return ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-session-delete',
          order: 500,
          locale: NS,
          inject: function () {
            return { requestDelete: requestDelete };
          },
        }, DeleteSessionMenuItem);
      });

      // The batch entry lives in the same per-row menu: that menu is the only
      // sidebar surface a client plugin can contribute to, and "delete several"
      // is reached from the same place as "delete one".
      ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
        return ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'dsh-session-delete-batch',
          order: 501,
          locale: NS,
          inject: function () {
            return { requestBatchDelete: requestBatchDelete };
          },
        }, BatchDeleteMenuItem);
      });

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-session-delete-batch-dialog',
          order: 502,
          locale: NS,
          inject: function () {
            return {
              hooks: { batch: batchStore },
              cancelBatch: cancelBatch,
              confirmBatchDelete: confirmBatchDelete,
              toggleBatchRow: toggleBatchRow,
              setBatchAll: setBatchAll,
            };
          },
        }, BatchDeleteDialog);
      });

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-session-delete-dialog',
          order: 500,
          locale: NS,
          inject: function () {
            return {
              hooks: { request: requestStore },
              cancelDelete: cancelDelete,
              confirmDelete: confirmDelete,
            };
          },
        }, DeleteSessionDialog);
      });

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-session-delete-toast',
          order: 501,
          locale: NS,
          inject: function () {
            return { hooks: { toast: toastStore } };
          },
        }, DeleteToast);
      });

    }

    exports.apply = apply;
    exports.inject = inject;
    exports.DICT = { zh: zh, en: en };
    return module.exports;
  },
});
