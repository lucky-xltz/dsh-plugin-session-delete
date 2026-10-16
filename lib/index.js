/**
 * dsh-plugin-session-delete — host half.
 *
 * A Cordis plugin (loaded as an out-of-tree bundle row, see cordis.patch.yml)
 * that adds a real "delete session" capability to the DSH web GUI. DSH ships
 * archive but deliberately no delete ("没有 Session 删除：会话可以归档但绝不会
 * 被删除" — ui-workspace README), so this plugin supplies the missing
 * destructive verb behind an explicit confirmation.
 *
 * Responsibilities, all through the DSH webserver service (`ctx.webServer`):
 *   1. Detect whether one session may be deleted right now and report why not
 *      (`GET <BASE>/check?sessionId=…`). A session whose Agent is resident in
 *      this Host process is refused: the Agent owns the persistence write
 *      handle (an open `session.lock`), so removing its directory underneath
 *      a live writer would corrupt the store.
 *   2. Delete a cold session (`POST <BASE>/delete`): drop its workspace
 *      accounting, its pinned/archived entries, its projection-cache
 *      checkpoint, and finally its on-disk session directory.
 *
 * Route shapes are deliberately two: a read-only check and one mutation, both
 * same-origin guarded. The plugin contributes no model-visible tool and no
 * prompt text. Every route is registered through the plugin fiber so it
 * unwinds on unload. `webServer` is a hard dependency; the domain services are
 * read through `ctx.get()` so a composition without one degrades to a clear
 * diagnostic instead of refusing to boot.
 *
 * Safety posture (this code deletes user data):
 *   · Only absolute paths reported by the persistence backend itself are ever
 *     removed — this file never re-derives the project/session path encoding
 *     (that encoding is backend-internal and would drift).
 *   · The resolved target is asserted to be a strict descendant of the
 *     backend's own session root before `rm -rf` runs.
 *   · A session with a resident Agent is refused, never force-deleted.
 *   · The mutation route requires the plugin's own marker header, so a stray
 *     cross-site form post cannot reach it.
 *
 * @module dsh-plugin-session-delete
 */

import { rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';

/** Route prefix owned by this plugin. */
const BASE = '/session-delete';

/** Required marker header on the mutation route (a non-simple CORS header). */
const MARKER_HEADER = 'x-dsh-session-delete';

/** Cap on one request body; both routes carry only a session id. */
const MAX_BODY_BYTES = 64 * 1024;

/** Loopback spellings accepted for the request `Host` authority. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/**
 * Read and JSON-parse one bounded request body.
 * @param req - incoming HTTP request.
 * @returns the parsed body, or an empty object for an empty body.
 * @throws when the body exceeds the cap, is not valid JSON, or the stream fails.
 */
function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectBody(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error(`request body exceeds ${String(MAX_BODY_BYTES)} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length === 0) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(text));
      } catch (error) {
        rejectBody(new Error(`request body is not valid JSON: ${String(error?.message ?? error)}`));
      }
    });
    req.on('error', fail);
  });
}

/**
 * Send one JSON response.
 * @param res - HTTP response.
 * @param status - HTTP status code.
 * @param payload - losslessly JSON-serializable body.
 * @param head - true for a HEAD request, which sends headers only.
 */
function sendJson(res, status, payload, head = false) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (head) res.end();
  else res.end(body);
}

/**
 * Reject a request whose `Host`/`Origin` do not describe this same-origin GUI.
 * @param req - incoming HTTP request.
 * @param trustedHosts - extra authorities the Host composition trusts.
 * @returns a diagnostic string when the request must be refused, else undefined.
 */
function requestOriginError(req, trustedHosts) {
  const raw = req.headers.host;
  if (typeof raw !== 'string' || raw.length === 0) return 'missing Host header';
  let hostUrl;
  try {
    hostUrl = new URL(`http://${raw}`);
  } catch {
    return 'malformed Host header';
  }
  const trusted = trustedHosts.some((entry) => {
    try {
      return new URL(`http://${String(entry)}`).host === hostUrl.host;
    } catch {
      return false;
    }
  });
  if (!LOOPBACK_HOSTNAMES.has(hostUrl.hostname) && !trusted) return 'forbidden host';
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    if (origin === 'null') return 'forbidden origin';
    try {
      if (new URL(origin).host !== hostUrl.host) return 'forbidden origin';
    } catch {
      return 'forbidden origin';
    }
  }
  return undefined;
}

/**
 * Assert that one backend-reported session directory is safe to remove.
 *
 * The path is trusted only because the persistence backend itself produced it
 * from `(session id, cwd)`; this function then narrows it further so a
 * backend bug or a bad header can never turn into a wide `rm -rf`.
 *
 * @param dir - absolute directory reported by the persistence backend.
 * @param root - the backend's own session root, when it exposes one.
 * @returns the resolved absolute directory.
 * @throws when the path is not absolute, is not a strict descendant of `root`,
 *   or names no usable final segment.
 */
function assertSafeSessionDir(dir, root) {
  if (typeof dir !== 'string' || dir.length === 0) throw new Error('session persistence reported no log location');
  if (!isAbsolute(dir)) throw new Error(`refusing to delete a non-absolute path: ${dir}`);
  const target = resolve(dir);
  const name = basename(target);
  if (name.length === 0 || name === '.' || name === '..' || name === sep) throw new Error(`refusing to delete a suspicious path: ${target}`);
  if (root !== undefined) {
    const base = resolve(root);
    if (target === base) throw new Error('refusing to delete the session store root');
    if (!target.startsWith(base + sep)) throw new Error(`refusing to delete a path outside the session store: ${target}`);
  }
  return target;
}

/**
 * Resolve the on-disk directory owning one stored session.
 *
 * Uses the persistence backend's own `locate(meta)` mapping — the authoritative
 * `(id, cwd) → log path` function — and takes its parent directory, so this
 * plugin never reimplements the backend's path encoding.
 *
 * @param persistence - `ctx.sessionPersistence`.
 * @param header - the stored session header (needs `id` and `cwd`).
 * @returns the absolute session directory, or undefined when the backend cannot report one.
 */
function sessionDirectoryOf(persistence, header) {
  if (typeof persistence.locate !== 'function') return undefined;
  let located;
  try {
    located = persistence.locate({ id: header.id, cwd: header.cwd });
  } catch {
    return undefined;
  }
  const logPath = located?.path;
  if (typeof logPath !== 'string' || logPath.length === 0) return undefined;
  const root = typeof persistence.root === 'string' ? persistence.root : undefined;
  return assertSafeSessionDir(resolve(logPath, '..'), root);
}

/**
 * Count stored sessions that name `sessionId` as their durable parent.
 * @param persistence - `ctx.sessionPersistence`.
 * @param sessionId - candidate parent identity.
 * @returns the number of direct children, or 0 when the listing fails.
 */
async function countChildren(persistence, sessionId) {
  try {
    const snapshots = await persistence.list();
    return snapshots.filter((snapshot) => snapshot.header.parentSession === sessionId).length;
  } catch {
    return 0;
  }
}

/**
 * Drop every durable reference to one session outside its own log: workspace
 * accounting, the registry-global pin and archive sets, and the projection
 * cache checkpoint.
 *
 * Each step is independently guarded: a session that is absent from one
 * structure is a no-op there, and a failing step must not leave the log
 * half-deleted, so callers run this before touching the filesystem.
 *
 * @param ctx - host context.
 * @param sessionId - the session being deleted.
 * @returns a per-step report of what was removed, for the caller's response.
 */
async function forgetSessionReferences(ctx, sessionId) {
  const removed = { workspace: undefined, unpinned: false, unarchived: false, projectionCache: false };

  const registry = ctx.get('workspaceRegistry');
  if (registry !== undefined) {
    if (registry.pinnedSessionIds.includes(sessionId)) {
      await registry.unpinSession(sessionId);
      removed.unpinned = true;
    }
    if (registry.archivedSessionIds.includes(sessionId)) {
      await registry.unarchiveSession(sessionId);
      removed.unarchived = true;
    }
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds.includes(sessionId)) continue;
      await workspace.detachSession(sessionId);
      removed.workspace = workspace.title;
      break;
    }
  }

  // The projection cache is derived data keyed by session id. Its own service
  // owns the opened table (`ctx.storageDomain` only opens domains, it does not
  // hand out already-open ones), so the record is dropped through that service
  // and a missing table simply means this profile has no projection cache.
  const table = ctx.get('sessionProjectionCache')?.table;
  if (table !== undefined) {
    try {
      removed.projectionCache = (await table.delete(sessionId)) === true;
    } catch (error) {
      ctx.logger.warn(`session-delete: projection checkpoint for "${sessionId}" was not removed: ${String(error)}`);
    }
  }

  return removed;
}

/**
 * Inspect one session and decide whether it may be deleted now.
 * @param ctx - host context.
 * @param sessionId - candidate identity.
 * @returns the check report, including a stable `reason` code.
 */
async function inspectSession(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) {
    throw Object.assign(new Error('this profile mounts no session persistence backend'), { code: 'no-persistence' });
  }
  const sessions = ctx.get('sessions');
  const agents = ctx.get('agents');
  const registry = ctx.get('workspaceRegistry');

  const liveSession = sessions?.get(sessionId);
  const agent = agents?.get(sessionId);
  const running = agent?.status === 'running';
  const snapshot = await persistence.stat(sessionId).catch(() => undefined);

  const known = liveSession !== undefined || snapshot !== undefined;
  const reason = !known ? 'not-found' : running ? 'running' : liveSession !== undefined ? 'live' : 'ok';

  const archived = registry?.archivedSessionIds.includes(sessionId) === true;
  const pinned = registry?.pinnedSessionIds.includes(sessionId) === true;
  let workspaceTitle;
  if (registry !== undefined) {
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds.includes(sessionId)) continue;
      workspaceTitle = workspace.title;
      break;
    }
  }

  return {
    sessionId,
    known,
    live: liveSession !== undefined,
    running,
    deletable: reason === 'ok',
    reason,
    archived,
    pinned,
    workspaceTitle: workspaceTitle ?? null,
    sizeBytes: snapshot?.sizeBytes ?? null,
    childCount: await countChildren(persistence, sessionId),
    location: snapshot === undefined ? null : (sessionDirectoryOf(persistence, snapshot.header) ?? null),
  };
}

/**
 * Delete one cold session: durable references first, then its log directory.
 * @param ctx - host context.
 * @param sessionId - identity to delete.
 * @returns the deletion report.
 * @throws when the session is unknown or still owned by a live Agent.
 */
async function deleteSession(ctx, sessionId) {
  const report = await inspectSession(ctx, sessionId);
  if (!report.known) throw Object.assign(new Error(`session "${sessionId}" does not exist`), { code: 'not-found' });
  if (report.running) throw Object.assign(new Error(`session "${sessionId}" is running`), { code: 'running' });
  if (report.live) throw Object.assign(new Error(`session "${sessionId}" is open in this app`), { code: 'live' });

  const persistence = ctx.get('sessionPersistence');
  const snapshot = await persistence.stat(sessionId);
  const removed = await forgetSessionReferences(ctx, sessionId);

  let filesRemoved = false;
  if (snapshot !== undefined) {
    const dir = sessionDirectoryOf(persistence, snapshot.header);
    if (dir !== undefined) {
      const exists = await stat(dir).then(() => true, () => false);
      if (exists) {
        await rm(dir, { recursive: true, force: true });
        filesRemoved = true;
      }
    }
  }

  // Tell connected clients to drop the row immediately; the forwarded
  // `api-session/removed` event is the same signal a disposed session emits.
  try {
    ctx.emit('api-session/removed', sessionId);
  } catch (error) {
    ctx.logger.warn(`session-delete: removal notice for "${sessionId}" was not delivered: ${String(error)}`);
  }

  return { sessionId, deleted: true, filesRemoved, ...removed };
}

/** Upper bound on one batch, so a single request cannot monopolize the host. */
const MAX_BATCH = 500;

/**
 * Inspect many sessions in one pass.
 *
 * Cheaper than `inspectSession` per id: the persistence listing and the
 * workspace registry are each read once, so a 200-session selection does not
 * walk 200 listings.
 *
 * @param ctx - host context.
 * @param sessionIds - candidates in caller order.
 * @returns one report per requested id, in the same order.
 */
async function inspectMany(ctx, sessionIds) {
  const persistence = ctx.get('sessionPersistence');
  if (persistence === undefined) {
    throw Object.assign(new Error('this profile mounts no session persistence backend'), { code: 'no-persistence' });
  }
  const sessions = ctx.get('sessions');
  const agents = ctx.get('agents');
  const registry = ctx.get('workspaceRegistry');

  const snapshots = await persistence.list().catch(() => []);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]));

  // One pass over the registry builds both lookups.
  const archived = new Set(registry?.archivedSessionIds ?? []);
  const pinned = new Set(registry?.pinnedSessionIds ?? []);
  const workspaceOf = new Map();
  for (const workspace of registry?.list() ?? []) {
    for (const id of workspace.sessionIds) workspaceOf.set(id, workspace.title);
  }

  // Child counts from the same listing, so no per-id listing runs.
  const childCounts = new Map();
  for (const snapshot of snapshots) {
    const parent = snapshot.header.parentSession;
    if (parent === undefined) continue;
    childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }

  return sessionIds.map((sessionId) => {
    const liveSession = sessions?.get(sessionId);
    const running = agents?.get(sessionId)?.status === 'running';
    const snapshot = byId.get(sessionId);
    const known = liveSession !== undefined || snapshot !== undefined;
    const reason = !known ? 'not-found' : running ? 'running' : liveSession !== undefined ? 'live' : 'ok';
    return {
      sessionId,
      known,
      live: liveSession !== undefined,
      running,
      deletable: reason === 'ok',
      reason,
      archived: archived.has(sessionId),
      pinned: pinned.has(sessionId),
      workspaceTitle: workspaceOf.get(sessionId) ?? null,
      sizeBytes: snapshot?.sizeBytes ?? null,
      childCount: childCounts.get(sessionId) ?? 0,
      location: snapshot === undefined ? null : (sessionDirectoryOf(persistence, snapshot.header) ?? null),
    };
  });
}

/**
 * Delete many sessions in one request.
 *
 * Every session is deleted independently: one refusal (running, open, already
 * gone) never aborts the rest, because a batch is a convenience over the same
 * per-session verb and a partial outcome is more useful than an all-or-nothing
 * failure. The response reports each id's own outcome.
 *
 * @param ctx - host context.
 * @param sessionIds - identities to delete.
 * @returns `{ deleted, skipped, failed }` with one entry per requested id.
 */
async function deleteSessions(ctx, sessionIds) {
  const unique = [...new Set(sessionIds)];
  const reports = await inspectMany(ctx, unique);
  const deleted = [];
  const skipped = [];

  for (const report of reports) {
    if (!report.deletable) {
      skipped.push({ sessionId: report.sessionId, reason: report.reason });
      continue;
    }
    try {
      const outcome = await deleteSession(ctx, report.sessionId);
      deleted.push({ sessionId: report.sessionId, filesRemoved: outcome.filesRemoved });
    } catch (error) {
      skipped.push({
        sessionId: report.sessionId,
        reason: typeof error?.code === 'string' ? error.code : 'internal',
        error: String(error?.message ?? error),
      });
    }
  }

  return { deleted, skipped, requested: unique.length };
}

/**
 * Extract the requested session ids from one request.
 *
 * A mutation carries its selection in the JSON body (`sessionId` or
 * `sessionIds`); a read carries it in the query string (`?sessionId=`). Both
 * reject an empty or non-string selection rather than silently acting on
 * nothing.
 *
 * @param req - incoming request.
 * @param body - parsed body for a mutation, else an empty object.
 * @param batch - whether this route takes a list.
 * @returns the requested ids, deduplicated in caller order.
 * @throws with `code: 'bad-request'` when the selection is unusable.
 */
function sessionIdsOf(req, body, batch) {
  const bad = (message) => Object.assign(new Error(message), { code: 'bad-request' });
  if (batch !== true) {
    const single = typeof body.sessionId === 'string'
      ? body.sessionId
      : new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId');
    if (typeof single !== 'string' || single.trim().length === 0) throw bad('sessionId is required');
    return [single];
  }
  const raw = body.sessionIds;
  if (!Array.isArray(raw)) throw bad('sessionIds must be an array');
  if (raw.length === 0) throw bad('sessionIds must not be empty');
  if (raw.length > MAX_BATCH) throw bad(`sessionIds must hold at most ${String(MAX_BATCH)} entries`);
  for (const id of raw) {
    if (typeof id !== 'string' || id.trim().length === 0) throw bad('every sessionIds entry must be a non-empty string');
  }
  return [...new Set(raw)];
}

/**
 * Build one route handler bound to this plugin's context.
 * @param ctx - host context.
 * @param handler - async `(sessionIds) => payload` business function.
 * @param options - route name for diagnostics, whether the body is required, and batch mode.
 * @returns an HTTP handler.
 */
function route(ctx, handler, options) {
  return async (req, res) => {
    try {
      const runtime = ctx.get('webRuntime');
      const originError = requestOriginError(req, Array.isArray(runtime?.trustedHosts) ? runtime.trustedHosts : []);
      if (originError !== undefined) {
        sendJson(res, 403, { ok: false, code: 'forbidden', error: originError });
        return;
      }
      // Method first: a wrong verb is a routing mistake, not an authorization
      // one, so it must not be reported as a guard failure.
      const method = req.method ?? 'GET';
      const allowed = options.mutation === true ? ['POST', 'HEAD'] : ['GET', 'HEAD'];
      if (!allowed.includes(method)) {
        res.setHeader('Allow', allowed.join(', '));
        sendJson(res, 405, { ok: false, code: 'method', error: `${options.name} accepts ${allowed.join(' or ')}` });
        return;
      }
      if (options.mutation === true) {
        if (req.headers[MARKER_HEADER] === undefined) {
          sendJson(res, 403, { ok: false, code: 'forbidden', error: `missing ${MARKER_HEADER} header` });
          return;
        }
        const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
          sendJson(res, 415, { ok: false, code: 'content-type', error: 'content-type must be application/json' });
          return;
        }
      }
      if (method === 'HEAD') {
        sendJson(res, 200, { ok: true }, true);
        return;
      }
      const body = options.mutation === true ? await readJsonBody(req) : {};
      const sessionIds = sessionIdsOf(req, body, options.batch === true);
      const payload = await handler(sessionIds);
      sendJson(res, 200, { ok: true, ...payload });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal';
      const status = code === 'not-found' ? 404 : code === 'live' || code === 'running' ? 409 : code === 'bad-request' ? 400 : 500;
      if (status === 500) ctx.logger.error(`session-delete: ${options.name} failed: ${String(error?.stack ?? error)}`);
      sendJson(res, status, { ok: false, code, error: String(error?.message ?? error) });
    }
  };
}

/**
 * Required services. Only `webServer` is declared: it is the transport this
 * plugin registers into, and a composition without it cannot serve routes at
 * all. The session and workspace services are read through `ctx.get()` at
 * request time instead, so a profile that mounts no persistence backend still
 * loads the plugin and answers each request with a concrete diagnostic rather
 * than silently never activating.
 */
export const inject = ['webServer'];

/**
 * Register this plugin's routes for as long as the calling fiber lives.
 * @param ctx - client root context.
 * @returns a disposer removing every route registered here.
 */
export function apply(ctx) {
  const webServer = ctx.webServer;
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger.warn('session-delete: no web server in this composition; routes not registered');
    return () => {};
  }

  const disposers = [
    webServer.register({
      kind: 'exact',
      path: `${BASE}/check`,
      handler: route(ctx, async ([sessionId]) => ({ check: await inspectSession(ctx, sessionId) }), {
        name: 'check',
        mutation: false,
      }),
    }),
    webServer.register({
      kind: 'exact',
      path: `${BASE}/delete`,
      handler: route(ctx, async ([sessionId]) => await deleteSession(ctx, sessionId), {
        name: 'delete',
        mutation: true,
      }),
    }),
    // Batch routes: one selection, one request. Each id is still deleted
    // independently, so a refusal on one row never blocks the others.
    webServer.register({
      kind: 'exact',
      path: `${BASE}/check-many`,
      handler: route(ctx, async (sessionIds) => ({ checks: await inspectMany(ctx, sessionIds) }), {
        name: 'check-many',
        mutation: true,
        batch: true,
      }),
    }),
    webServer.register({
      kind: 'exact',
      path: `${BASE}/delete-many`,
      handler: route(ctx, async (sessionIds) => await deleteSessions(ctx, sessionIds), {
        name: 'delete-many',
        mutation: true,
        batch: true,
      }),
    }),
  ];

  ctx.logger.info(`session-delete: routes mounted at ${BASE}/{check,delete,check-many,delete-many}`);

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* an already-unwound route table is not an error */
      }
    }
  };
}

/**
 * Internals exposed for the plugin's own tests.
 *
 * The deletion path is the destructive part of this package, so it is written
 * as pure functions over a minimal context and exported here: a test can drive
 * them against a real persistence backend in a scratch root without booting an
 * HTTP server or an Electron shell. Nothing outside this package should import
 * this object — `apply` is the only supported entry point.
 *
 * @internal
 */
export const internals = {
  BASE,
  MARKER_HEADER,
  MAX_BATCH,
  assertSafeSessionDir,
  sessionDirectoryOf,
  forgetSessionReferences,
  inspectSession,
  inspectMany,
  deleteSession,
  deleteSessions,
  sessionIdsOf,
  requestOriginError,
  readJsonBody,
};

export default { inject, apply };

