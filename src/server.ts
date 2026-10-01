import { configuredLinuxComputer } from './linux-computer.ts';
import { ApplicationOriginError, canonicalPublicOrigin, createApplicationOrigin, type ApplicationOrigin } from './application-origin.ts';
import { AuthError, authDigest, readOwnerAuthConfig } from './auth-config.ts';
import { readHostToolsConfig } from './host-tools-config.ts';
import { ConfiguredHostTools } from './host-tools-service.ts';
import { ConnectorError } from './connector-types.ts';
import { OwnerAuth, assertAuthenticationMode, type AuthSession } from './auth-sessions.ts';
import { ComputerHost, type ComputerHostOptions } from './computer-host.ts';
import { ComputerApprovalError } from './computer-approvals.ts';
import { ObjectiveInputError } from './objective-input.ts';
import { AttachmentUploadError, attachmentUploadLimits, type AttachmentUploadInput } from './attachment-upload.ts';
import { VoiceService, VoiceError, type VoiceServiceOptions } from './voice-service.ts';
import { VoiceStreamService, VoiceStreamError } from './voice-stream.ts';
import { configuredVoiceProvider } from './voice-provider.ts';
import { NotificationError } from './notification-outbox.ts';
import { AuthoredDocumentError } from './authored-documents.ts';
import { ArtifactError } from './artifacts.ts';
import { ArtifactVersionError, type CreateArtifactDocumentInput, type AppendArtifactVersionInput } from './artifact-versions.ts';
import { MemoryViewError } from './memory-view.ts';
import { ReminderError, type ReminderInput } from './reminders.ts';
import { CalendarReminderError, type CalendarControlInput } from './calendar-reminders.ts';
import { CalendarProposalError } from './calendar-proposals.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Worker } from 'node:worker_threads';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputerGateway, ComputerGatewayError, type ComputerGatewayOptions } from './computer-gateway.ts';
import { ControlConflict } from './computer-control.ts';
import { ProductStore, ConflictError, MissingError } from './store.ts';
import { RuntimeService, RuntimeUnavailableError, type RuntimeServiceOptions } from './runtime-service.ts';
import { ModelSettingsError } from './model-settings.ts';
import { MorphzError } from './morphz-adapter.ts';

const assets = new Map([
  ['/login', { body: readFileSync(new URL('../public/login.html', import.meta.url)), type: 'text/html; charset=utf-8' }],
  ['/login.js', { body: readFileSync(new URL('../public/login.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ...['voice-capture.js', 'voice-processor.js', 'voice-stream-capture.js'].map(name => [`/${name}`, { body: readFileSync(new URL(`../public/${name}`, import.meta.url)), type: 'text/javascript; charset=utf-8' }] as const),
  ['/', { body: readFileSync(new URL('../public/index.html', import.meta.url)), type: 'text/html; charset=utf-8' }],
  ['/app.js', { body: readFileSync(new URL('../public/app.js', import.meta.url)), type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { body: readFileSync(new URL('../public/styles.css', import.meta.url)), type: 'text/css; charset=utf-8' }],
]);
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
async function body(request: IncomingMessage, maximum = 16_384): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'Use application/json');
  let size = 0; const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length; if (size > maximum) { request.resume(); throw new HttpError(413, 'Request is too large'); } chunks.push(chunk);
  }
  let parsed; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Expected a JSON object'); return parsed;
}
function textField(value: unknown, label: string, maximum = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new HttpError(400, `${label} must contain 1–${maximum} characters`); return value.trim();
}
function requestKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw new HttpError(400, 'A stable idempotencyKey (8–128 letters, digits, hyphens or underscores) is required'); return value;
}
function revision(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new HttpError(400, 'expectedRevision must be a nonnegative integer'); return Number(value); }
function fields(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unexpected request fields; identity and execution scope are owned by the server'); }
function sendJson(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); }
export interface ApplicationOptions extends RuntimeServiceOptions { mode?: 'runtime' | 'demo'; startWorker?: boolean; simulationMs?: number; computer?: Omit<ComputerGatewayOptions, 'dbPath' | 'authentication' | 'publicOrigin'>; voice?: Omit<VoiceServiceOptions, 'context'>; computerHost?: ComputerHostOptions; authConfigPath?: string; authNow?: () => number; publicOrigin?: string; hostToolsConfigPath?:string; connectorConfigPath?: string; connectorGithubFetch?: typeof globalThis.fetch }

export function createApplication(options: ApplicationOptions) {
  // Read only the explicitly selected private file before opening any worker.
  const authConfig = options.authConfigPath === undefined ? undefined : readOwnerAuthConfig(options.authConfigPath);
  // An explicit browser entry point only; never forwarded-header or Runtime authority.
  const publicOrigin = options.publicOrigin === undefined ? undefined : canonicalPublicOrigin(options.publicOrigin);
  if (publicOrigin && !authConfig) throw new ApplicationOriginError('application_origin_owner_auth_required');
  if(options.hostToolsConfigPath!==undefined&&options.connectorConfigPath!==undefined)throw new ConnectorError('host_tools_config_ambiguous');
  const hostToolsConfigPath=options.hostToolsConfigPath??options.connectorConfigPath;
  const hostToolsConfig=hostToolsConfigPath===undefined?undefined:readHostToolsConfig(hostToolsConfigPath);
  if(hostToolsConfig&&options.mode==='demo')throw new ConnectorError('connector_runtime_mode_required');
  if(hostToolsConfig?.tools.authoredDocuments&&!authConfig)throw new ConnectorError('authored_owner_authentication_required');
  if(hostToolsConfig?.tools.calendarProposals&&!authConfig)throw new ConnectorError('calendar_owner_authentication_required');
  for(const tool of Object.values(hostToolsConfig?.tools??{}))if(authConfig?.credential.kind==='morphz_login_token_sha256'&&authDigest(tool!.callbackToken)===authConfig.credential.hashHex)throw new ConnectorError('connector_separate_callback_token_required');
  mkdirSync(dirname(resolve(options.dbPath)), { recursive: true, mode: 0o700 });
  const mode = options.mode ?? 'runtime';
  const runtime = mode === 'runtime' ? new RuntimeService({ ...options, autoStart: false, streamEnabled: options.streamEnabled ?? options.autoStart !== false }) : null;
  const demo = mode === 'demo' ? new ProductStore(options.dbPath) : null;
  const store = (runtime?.store ?? demo)!;
  let hostTools:ConfiguredHostTools|undefined;
  try {
    assertAuthenticationMode(store.db, Boolean(authConfig));
    if (authConfig && !runtime?.store.binding()?.userId) throw new AuthError('authentication_saved_owner_required', 503);
    if (hostToolsConfig) {
      if (!runtime?.adapter) throw new ConnectorError('connector_runtime_configuration_required');
      hostTools=new ConfiguredHostTools({configPath:hostToolsConfigPath!,config:hostToolsConfig,runtimeOrigin:runtime.adapter.baseUrl,operatorToken:options.operatorToken,store:runtime.store,runtimeFetch:options.fetch,githubFetch:options.connectorGithubFetch,ownerAuthenticationConfigured:Boolean(authConfig),calendarFactory:(authority,authorize)=>runtime.createCalendarProposalHost(authority,authorize),authoredFactory:(authority,authorize)=>runtime.createAuthoredDocumentHost(authority,authorize)});
    }
  } catch (error) { if (runtime) void runtime.close(); else demo!.close(); throw error; }
  const connectors=hostToolsConfig?.tools.githubPublic?hostTools:undefined;
  let auth: OwnerAuth | undefined;
  let applicationOrigin: ApplicationOrigin | undefined;
  const computer = new ComputerGateway({ ...options.computer, publicOrigin, dbPath: options.dbPath === ':memory:' ? ':memory:' : `${options.dbPath}.computer`, authentication: authConfig ? { authenticate: cookie => auth?.authenticate(cookie) ?? null, isCurrentSession: id => auth?.isCurrentSession(id) ?? false } : undefined });
  const computerHost = options.computerHost && runtime ? new ComputerHost(runtime, computer, options.computerHost) : null;
  const voice = new VoiceService({ ...(options.voice ?? { enabled: false }), context: async () => { if (!runtime) throw new Error('Runtime required'); return runtime.voiceContext(); } });
  const voiceStreams = new VoiceStreamService({ ...(options.voice ?? { enabled: false }), enabled:Boolean(authConfig && runtime && options.voice?.enabled), context:async()=>{if(!runtime)throw new Error('Runtime required');return runtime.voiceContext();} });
  const voiceCapabilities=()=>{const stream={...voiceStreams.capabilities(),requiresOwnerAuthentication:true,...(!authConfig?{unavailableReason:'owner_authentication_required'}:{})};const basic=voice.capabilities();return{...basic,stream,operations:{...basic.operations,streamingDictation:stream.available}};};
  const csrfToken = randomBytes(32).toString('hex');
  let workerStatus = mode === 'runtime' ? 'not_applicable' : options.startWorker === false ? 'disabled' : 'starting';
  let worker: Worker | null = null;
  let closing = false;
  let startupError: AuthError | undefined;
  let started = false;
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {}); // Caller may await readiness; startup never emits an unhandled rejection.
  const disabledConnectors = { status: 'disabled', access: 'public_data', accountConnected: false, probePerformed: false, message: 'No public connector configuration supplied', connectors: [] };
  const snapshot = (session?: AuthSession | null) => ({ ...(runtime ? runtime.snapshot() : { mode: 'demo', disclaimer: 'Simulation only. No model calls or real Morphz execution.', sessionId: 'local-demo', workerStatus, ...demo!.snapshot() }), csrfToken: session?.csrfToken ?? csrfToken, authentication: { enabled: Boolean(authConfig), session: session ?? null }, connectors: connectors?.snapshot() ?? disabledConnectors, authoring:hostTools?.authoringSnapshot()??{enabled:false,status:'disabled',source:'opendots_authored'},calendarProposals:{enabled:Boolean(authConfig&&hostToolsConfig?.tools.calendarProposals),pendingCount:authConfig?runtime?.calendarProposalCount()??0:0}, computerPendingApprovals: computerHost?.approvals?.pendingCount() ?? 0, computerExecutor: computerHost?.snapshot() ?? { status: 'disabled', message: 'No computer Edge executor configured' } });
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('referrer-policy', 'no-referrer');
    // Explicit matching WSS source: some browser engines do not map 'self' to WS.
    const publicWebSocket = applicationOrigin?.mode === 'https-proxy' ? ` ${applicationOrigin.webSocketOrigin}` : '';
    response.setHeader('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${publicWebSocket}; media-src 'self' blob:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`);
    let session: AuthSession | null = null;
    let privateResponse = false;
    const assertCurrent = () => { if (authConfig && (!auth || !session || !auth.isCurrentSession(session.id))) throw new AuthError('authentication_required', 401); };
    const json = (r: ServerResponse, status: number, value: unknown) => { if (privateResponse && status < 400) assertCurrent(); sendJson(r, status, value); };
    try {
      const address = server.address(); const port = address && typeof address !== 'string' ? address.port : 0;
      if (closing) throw new HttpError(503, 'The local application is shutting down; no new request was accepted');
      if (startupError) throw startupError;
      if (!started) throw new AuthError('authentication_initializing', 503);
      let expectedOrigin: string;
      if (authConfig) {
        // Missing Origin is permitted only for reads, never login/mutations.
        if (!applicationOrigin?.matchesRequest(request, request.method === 'GET' || request.method === 'HEAD' ? 'read' : 'mutation')) throw new AuthError('authentication_request_rejected', 403);
        expectedOrigin = applicationOrigin.origin;
      } else {
        // Preserve the existing unauthenticated local-development contract only.
        // Its CSRF gate below remains required; HTTPS mode can never enter here.
        if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host ?? '')) throw new HttpError(403, 'Only the local opendots host is allowed');
        expectedOrigin = `http://${request.headers.host}`;
        if (request.headers.origin && request.headers.origin !== expectedOrigin) throw new HttpError(403, 'Cross-origin requests are not allowed');
        const fetchSite = request.headers['sec-fetch-site']; if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw new HttpError(403, 'Cross-origin requests are not allowed');
      }
      const url = new URL(request.url ?? '/', expectedOrigin);
      if (authConfig && (url.origin !== expectedOrigin || !request.url?.startsWith('/') || request.url.startsWith('//'))) throw new HttpError(400, 'Use an origin-relative product route');
      if (url.search) throw new HttpError(400, 'Query parameters are not accepted on product routes');
      if (request.method === 'GET' && ['/login', '/login.js', '/styles.css'].includes(url.pathname)) { const asset = assets.get(url.pathname)!; response.writeHead(200, { 'content-type': asset.type }); response.end(asset.body); return; }
      if (request.method === 'GET' && url.pathname === '/api/auth') {
        session = auth?.authenticate(request.headers.cookie) ?? null;
        json(response, 200, { enabled: Boolean(authConfig), authenticated: Boolean(session), credentialKind: authConfig?.credential.kind === 'scrypt' ? 'password' : authConfig ? 'connection_token' : null, session }); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/login') {
        if (!auth || request.headers.origin !== expectedOrigin) throw new AuthError('authentication_request_rejected', 403);
        const abort = new AbortController(); const disconnected = () => { if (!response.writableEnded) abort.abort(); };
        request.once('aborted', disconnected); response.once('close', disconnected);
        let input: Record<string, unknown> | undefined;
        try {
          input = await body(request, 4096); fields(input, ['credential', 'deviceLabel']);
          const result = await auth.login({ credential: input.credential, deviceLabel: input.deviceLabel }, { origin: request.headers.origin, remoteAddress: request.socket.remoteAddress, signal: abort.signal });
          if (abort.signal.aborted || closing) throw new AuthError('authentication_failed', 401);
          response.setHeader('set-cookie', result.setCookie); json(response, 200, { authenticated: true, session: result.session });
        } finally { if (input) input.credential = undefined; request.off('aborted', disconnected); response.off('close', disconnected); }
        return;
      }
      if (authConfig) {
        session = auth?.authenticate(request.headers.cookie) ?? null;
        if (!session) {
          if (request.method === 'GET' && url.pathname === '/') { response.writeHead(303, { location: '/login' }); response.end(); return; }
          throw new AuthError('authentication_required', 401);
        }
        privateResponse = true;
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/devices') { if (!auth) throw new AuthError('authentication_not_configured', 409); json(response, 200, auth.listDevices(request.headers.cookie)); return; }
      const performRequest = async () => {
      if (request.method === 'GET' && assets.has(url.pathname)) { const asset = assets.get(url.pathname)!; response.writeHead(200, { 'content-type': asset.type }); response.end(asset.body); return; }
      if (request.method === 'GET' && /^\/vendor\/novnc\/(core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(url.pathname)) {
        const root = fileURLToPath(new URL('../node_modules/@novnc/novnc/', import.meta.url));
        const local = resolve(root, url.pathname.slice('/vendor/novnc/'.length));
        if (!local.startsWith(root.endsWith(sep) ? root : root + sep)) throw new HttpError(404, 'Not found');
        let asset; try { asset = readFileSync(local); } catch { throw new HttpError(404, 'Not found'); }
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); response.end(asset); return;
      }
      const taskDetail = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]{1,200})\/detail$/);
      if (request.method === 'GET' && taskDetail && runtime) { json(response, 200, await runtime.taskDetail(taskDetail[1])); return; }
      const commandLookup = url.pathname.match(/^\/api\/commands\/([a-zA-Z0-9_-]{8,128})$/);
      if (request.method === 'GET' && commandLookup && runtime) { json(response, 200, runtime.commandLookup(commandLookup[1])); return; }
      const taskInputTarget = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]{1,200})\/input-target$/);
      if (request.method === 'GET' && taskInputTarget && runtime) { json(response, 200, await runtime.objectiveInputTarget(taskInputTarget[1])); return; }
      if (request.method === 'GET' && url.pathname === '/api/uploads') { if (!runtime) throw new HttpError(409, 'Uploads require Runtime mode'); json(response, 200, await runtime.listUploads()); return; }
      if (request.method === 'GET' && url.pathname === '/api/voice') { json(response, 200, voiceCapabilities()); return; }
      if (request.method === 'GET' && url.pathname === '/api/connectors') { json(response, 200, connectors?.catalogue() ?? disabledConnectors); return; }
      if (request.method === 'GET' && url.pathname === '/api/connectors/native') {
        if (!connectors) throw new ConnectorError('connector_not_configured', 409);
        const abort = new AbortController(); const disconnected = () => { if (!response.writableEnded) abort.abort(); };
        request.once('aborted', disconnected); response.once('close', disconnected);
        try { json(response, 200, await connectors.nativeCatalogue(abort.signal)); }
        finally { request.off('aborted', disconnected); response.off('close', disconnected); }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/computer') { const snapshot=computer.snapshot();json(response, 200, { ...snapshot, executor: computerHost?.snapshot() ?? null, capabilities:{...snapshot.capabilities,aiControl:snapshot.capabilities.aiControl&&(!computerHost||computerHost.snapshot().status==='ready')} }); return; }
      if (request.method === 'GET' && url.pathname === '/api/computer/approvals') { json(response,200,computerHost?.approvals?{available:true,...await computerHost.approvals.list()}:{available:false,approvals:[]});return; }
      const computerImage=url.pathname.match(/^\/api\/computer\/approvals\/([a-f0-9-]{36})\/image$/);
      if (request.method === 'GET' && computerImage && computerHost?.approvals) { const png=await computerHost.approvals.image(computerImage[1]);if(authConfig)assertCurrent();response.writeHead(200,{'content-type':'image/png','content-length':png.byteLength});response.end(png);return; }
      if (request.method === 'GET' && url.pathname === '/api/state') { json(response, 200, snapshot(session)); return; }
      if (request.method === 'GET' && url.pathname === '/api/notifications') { if(!runtime)throw new HttpError(409,'Notifications require Runtime mode');json(response,200,runtime.listNotifications());return; }
      if (request.method === 'GET' && url.pathname === '/api/reminders') { if (!runtime) throw new HttpError(409, 'Reminders require Runtime mode'); json(response, 200, { reminders: await runtime.listReminders() }); return; }
      if (request.method === 'GET' && url.pathname === '/api/calendar-reminders') { if(!runtime)throw new HttpError(409,'Calendar reminders require Runtime mode');json(response,200,await runtime.listCalendarReminders());return; }
      if(request.method==='GET'&&url.pathname==='/api/calendar-proposals'){json(response,200,authConfig&&runtime?{enabled:Boolean(hostToolsConfig?.tools.calendarProposals),...await runtime.listCalendarProposals()}:{enabled:false,pendingCount:0,proposals:[],nextCursor:null});return;}
      const proposalStatus=url.pathname.match(/^\/api\/calendar-proposals\/(calprop-[a-f0-9]{64})$/);
      if(request.method==='GET'&&proposalStatus){if(!authConfig||!runtime)throw new CalendarProposalError('calendar_owner_authentication_required',403);json(response,200,await runtime.calendarProposalStatus(proposalStatus[1]!));return;}
      const calendarHistory=url.pathname.match(/^\/api\/calendar-reminders\/(cal-[a-f0-9]{64})\/occurrences$/);
      if(request.method==='GET'&&calendarHistory&&runtime){json(response,200,await runtime.calendarReminderHistory(calendarHistory[1]!));return;}
      const authoredDocument = url.pathname.match(/^\/api\/authored-documents\/(pdoc-[a-f0-9-]{36})$/);
      const authoredContent = url.pathname.match(/^\/api\/authored-documents\/(pdoc-[a-f0-9-]{36})\/versions\/(pver-[a-f0-9-]{36})\/content$/);
      if(request.method==='GET'&&(url.pathname==='/api/authored-documents'||authoredDocument||authoredContent)){
        if(!authConfig||!runtime)throw new AuthoredDocumentError('authored_owner_authentication_required',403);
        if(authoredContent){const {version,bytes}=runtime.downloadAuthoredVersion(authoredContent[1],authoredContent[2]);assertCurrent();response.setHeader('content-security-policy',"sandbox; default-src 'none'");const encoded=encodeURIComponent(version.name).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);response.writeHead(200,{'content-type':'application/octet-stream','content-disposition':`attachment; filename="download"; filename*=UTF-8''${encoded}`,'content-length':bytes.byteLength,'x-content-type-options':'nosniff','cache-control':'no-store'});response.end(bytes);return;}
        json(response,200,authoredDocument?runtime.authoredDocumentHistory(authoredDocument[1]):runtime.listAuthoredDocuments());return;
      }
      const documentRoute = url.pathname.match(/^\/api\/artifact-documents\/(doc-[a-f0-9-]{36})$/);
      const versionContent = url.pathname.match(/^\/api\/artifact-documents\/(doc-[a-f0-9-]{36})\/versions\/(ver-[a-f0-9-]{36})\/content$/);
      const artifactCommand = url.pathname.match(/^\/api\/artifact-commands\/([a-zA-Z0-9_-]{8,128})$/);
      if (request.method === 'GET' && url.pathname === '/api/artifact-documents' && runtime) { json(response,200,runtime.listArtifactDocuments()); return; }
      if (request.method === 'GET' && documentRoute && runtime) { json(response,200,runtime.artifactDocumentHistory(documentRoute[1])); return; }
      if (request.method === 'GET' && artifactCommand && runtime) { json(response,200,runtime.artifactCommandReceipt(artifactCommand[1])); return; }
      if (request.method === 'GET' && versionContent && runtime) {
        const {artifact,bytes} = await runtime.downloadArtifactVersion(versionContent[1],versionContent[2]);
        const encodedName=encodeURIComponent(artifact.name).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        if(authConfig)assertCurrent();
        response.writeHead(200,{'content-type':'application/octet-stream','content-disposition':`attachment; filename="download"; filename*=UTF-8''${encodedName}`,'content-length':bytes.byteLength,'x-content-type-options':'nosniff','cache-control':'no-store'});response.end(bytes);return;
      }
      if (request.method === 'GET' && url.pathname === '/api/artifacts') { if (!runtime) throw new HttpError(409, 'Registered resources require Runtime mode'); json(response, 200, await runtime.listArtifacts()); return; }
      const artifactContent = url.pathname.match(/^\/api\/artifacts\/([a-f0-9]{64})\/content$/);
      if (request.method === 'GET' && artifactContent && runtime) {
        const { artifact, bytes } = await runtime.downloadArtifact(artifactContent[1]);
        // Always force attachment and an inert MIME type; never render active HTML/SVG inline.
        const encodedName = encodeURIComponent(artifact.name).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
        if(authConfig)assertCurrent();
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodedName}`, 'content-length': bytes.byteLength, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }); response.end(bytes); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/models') { if (!runtime) throw new HttpError(409, 'Model settings require Runtime mode'); json(response, 200, await runtime.modelSettings()); return; }
      if (request.method !== 'POST') throw new HttpError(404, 'Not found');
      const provided = request.headers['x-opendots-csrf'];
      const assertMutation = () => {
        if (auth) session = auth.requireMutation(request.headers.cookie, provided, request.headers.origin);
        else if (typeof provided !== 'string' || Buffer.byteLength(provided) !== Buffer.byteLength(csrfToken) || !timingSafeEqual(Buffer.from(provided), Buffer.from(csrfToken))) throw new HttpError(403, 'Refresh this page before submitting again');
      };
      assertMutation();
      const chunkRoute = url.pathname.match(/^\/api\/uploads\/(upload-[a-f0-9-]{36})\/content$/);
      if (chunkRoute && runtime) {
        if (request.headers['content-type'] !== 'application/octet-stream') throw new HttpError(415, 'Use application/octet-stream');
        const rawOffset = request.headers['x-opendots-upload-offset'];
        if (typeof rawOffset !== 'string' || !/^(0|[1-9][0-9]{0,8})$/.test(rawOffset)) throw new HttpError(400, 'Exact upload offset required');
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          size += chunk.length; if (size > attachmentUploadLimits.maximumChunkBytes) { request.resume(); throw new HttpError(413, 'Upload chunk exceeds limit'); } chunks.push(chunk);
        }
        assertMutation(); json(response, 200, await runtime.uploadChunk(chunkRoute[1], Number(rawOffset), Buffer.concat(chunks))); return;
      }
      if (url.pathname === '/api/voice/transcribe' || url.pathname === '/api/voice/read-aloud') {
        const abort = new AbortController();
        const disconnected = () => { if (!response.writableEnded) abort.abort(); };
        request.once('aborted', disconnected); response.once('close', disconnected);
        try {
          if (url.pathname.endsWith('/transcribe')) {
            if (request.headers['content-type']?.split(';')[0].trim() !== 'audio/wav') throw new HttpError(415, 'Use audio/wav');
            if (request.headers['x-opendots-voice-consent'] !== 'transcribe') throw new HttpError(400, 'Explicit voice transmission consent required');
            let size = 0; const chunks: Buffer[] = [];
            for await (const chunk of request.iterator({ destroyOnReturn: false })) {
              size += chunk.length; if (size > voice.capabilities().capture.maximumBytes) { request.resume(); throw new HttpError(413, 'Recording exceeds voice limit'); } chunks.push(chunk);
            }
            assertMutation(); json(response, 200, await voice.transcribe(Buffer.concat(chunks), true, abort.signal));
          } else {
            const input = await body(request); fields(input, ['messageId', 'consent']);
            assertMutation();
            const audio = await voice.readAloud({ messageId: textField(input.messageId, 'Message', 2048), consent: input.consent === true }, abort.signal);
            if(authConfig)assertCurrent();
            response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(audio);
          }
        } finally { request.off('aborted', disconnected); response.off('close', disconnected); }
        return;
      }
      const input = await body(request,url.pathname==='/api/voice/stream'?40000:16384);
      assertMutation();
      if (url.pathname === '/api/voice/stream') {
        if(!authConfig||!session||!runtime)throw new VoiceStreamError('voice_stream_owner_authentication_required',403);
        const binding=runtime.store.binding();if(!binding)throw new VoiceStreamError('voice_stream_identity_unavailable',503);
        const abort=new AbortController(),disconnected=()=>{if(!response.writableEnded)abort.abort();};
        request.once('aborted',disconnected);response.once('close',disconnected);
        try{const result=await voiceStreams.call(input,{ownerId:binding.userId,deviceSessionId:session.id,assertAuthorized:assertCurrent},abort.signal);assertCurrent();json(response,200,result);}
        finally{request.off('aborted',disconnected);response.off('close',disconnected);}return;
      }
      if (url.pathname === '/api/auth/logout' || url.pathname === '/api/auth/revoke-all' || /^\/api\/auth\/devices\/[a-f0-9-]{36}\/revoke$/.test(url.pathname)) {
        if (!auth) throw new AuthError('authentication_not_configured', 409); fields(input, []);
        const result = url.pathname === '/api/auth/logout' ? auth.logout(request.headers.cookie, provided, request.headers.origin) : url.pathname === '/api/auth/revoke-all' ? auth.revokeAll(request.headers.cookie, provided, request.headers.origin) : auth.revokeDevice(request.headers.cookie, provided, request.headers.origin, url.pathname.split('/')[4]);
        if (result.setCookie) response.setHeader('set-cookie', result.setCookie);
        const { setCookie: _cookie, ...safe } = result;
        // Successful logout deliberately invalidates this request's session.
        privateResponse = false; json(response, 200, safe); return;
      }
      const computerDecision=url.pathname.match(/^\/api\/computer\/approvals\/([a-f0-9-]{36})\/decision$/);
      if (computerDecision && computerHost?.approvals) { fields(input,['decision','expectedRevision']);if(!['allow_once','deny'].includes(String(input.decision)))throw new HttpError(400,'Decision must be allow_once or deny');json(response,200,await computerHost.approvals.decide(computerDecision[1],input.decision as 'allow_once'|'deny',revision(input.expectedRevision), authConfig ? assertCurrent : undefined));return; }
      if (url.pathname === '/api/computer/preview') { fields(input, []); json(response, 200, computer.preview(expectedOrigin, session?.id)); return; }
      if (url.pathname === '/api/computer/takeover') { fields(input, ['expectedEpoch']); json(response, 200, await computer.takeover(revision(input.expectedEpoch), expectedOrigin, session?.id)); return; }
      if (url.pathname === '/api/computer/renew') { fields(input, ['epoch']); json(response, 200, computer.renew(revision(input.epoch))); return; }
      if (url.pathname === '/api/computer/pause') { fields(input, ['expectedEpoch']); json(response, 200, computer.pause(revision(input.expectedEpoch))); return; }
      if (url.pathname === '/api/computer/return') { if(computerHost&&computerHost.snapshot().status!=='ready')throw new HttpError(503,'Computer Edge executor is not connected; no AI authority granted');fields(input, ['expectedEpoch','acknowledgeUncertainty']); if (input.acknowledgeUncertainty !== undefined && typeof input.acknowledgeUncertainty !== 'boolean') throw new HttpError(400, 'Explicit uncertainty acknowledgment must be boolean'); json(response, 200, await computer.returnToAi(revision(input.expectedEpoch), input.acknowledgeUncertainty === true, authConfig ? assertCurrent : undefined)); return; }
      if (url.pathname === '/api/artifact-documents' && runtime) { fields(input,['title','artifactId','note','idempotencyKey']);json(response,200,await runtime.createArtifactDocument(input as unknown as CreateArtifactDocumentInput));return; }
      if (url.pathname === '/api/artifact-documents/page' && runtime) { fields(input,['limit','after']);json(response,200,runtime.listArtifactDocuments(input as {limit?:number;after?:string}));return; }
      const appendVersion=url.pathname.match(/^\/api\/artifact-documents\/(doc-[a-f0-9-]{36})\/versions$/);
      const versionPage=url.pathname.match(/^\/api\/artifact-documents\/(doc-[a-f0-9-]{36})\/versions\/page$/);
      if(appendVersion&&runtime){fields(input,['artifactId','note','expectedRevision','parentVersionId','idempotencyKey']);json(response,200,await runtime.appendArtifactVersion(appendVersion[1],input as unknown as AppendArtifactVersionInput));return;}
      if(versionPage&&runtime){fields(input,['limit','after']);json(response,200,runtime.artifactDocumentHistory(versionPage[1],input as {limit?:number;after?:string}));return;}
      if (url.pathname === '/api/chat') {
        fields(input, ['text', 'idempotencyKey', 'draftKey', 'uploadIds']);
        const attachmentDraft = input.draftKey !== undefined || input.uploadIds !== undefined ? { draftKey: requestKey(input.draftKey), uploadIds: input.uploadIds as string[] } : undefined;
        if (attachmentDraft && (!Array.isArray(attachmentDraft.uploadIds) || attachmentDraft.uploadIds.length < 1 || attachmentDraft.uploadIds.length > 4 || attachmentDraft.uploadIds.some(id => typeof id !== 'string' || !/^upload-[a-f0-9-]{36}$/.test(id)))) throw new HttpError(400, 'Select one through four uploaded file identities');
        if (attachmentDraft && !runtime) throw new HttpError(409, 'Attachments require Runtime mode');
        const text = textField(input.text, 'Message'); const key = requestKey(input.idempotencyKey);
        json(response, runtime ? 202 : 200, runtime ? await runtime.sendChat(text, key, attachmentDraft) : demo!.addDemoChat(text, key)); return;
      }
      if (url.pathname === '/api/uploads' && runtime) { fields(input, ['draftKey','uploadKey','name','mediaType','sizeBytes','sha256']); json(response, 201, await runtime.createUpload(input as unknown as AttachmentUploadInput)); return; }
      const uploadControl = url.pathname.match(/^\/api\/uploads\/(upload-[a-f0-9-]{36})\/(reconcile|cancel)$/);
      if (uploadControl && runtime) { fields(input, []); json(response, 200, uploadControl[2] === 'cancel' ? await runtime.cancelUpload(uploadControl[1]) : await runtime.reconcileUpload(uploadControl[1])); return; }
      const authoredPage=url.pathname.match(/^\/api\/authored-documents\/(pdoc-[a-f0-9-]{36})\/versions\/page$/);
      if(url.pathname==='/api/authored-documents/page'||authoredPage){
        if(!authConfig||!runtime)throw new AuthoredDocumentError('authored_owner_authentication_required',403);
        fields(input,['afterId','limit']);const page={...(input.afterId!==undefined?{afterId:textField(input.afterId,'Document cursor',100)}:{}),...(input.limit!==undefined?{limit:revision(input.limit)}:{})};
        json(response,200,authoredPage?runtime.authoredDocumentHistory(authoredPage[1],page):runtime.listAuthoredDocuments(page));return;
      }
      if (url.pathname === '/api/messages/page' && runtime) {
        fields(input,['before','limit']);
        if(input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||Number(input.limit)<1||Number(input.limit)>100))throw new HttpError(400,'Page limit must be 1–100');
        json(response,200,runtime.messagesPage({...input.before!==undefined?{before:textField(input.before,'History cursor',200)}:{},...input.limit!==undefined?{limit:Number(input.limit)}:{}}));return;
      }
      if (url.pathname === '/api/jobs') {
        fields(input, runtime ? ['prompt', 'idempotencyKey'] : ['prompt', 'idempotencyKey', 'requireApproval']);
        const prompt = textField(input.prompt, 'Objective'); const key = requestKey(input.idempotencyKey);
        if (runtime) { json(response, 202, await runtime.createObjective(prompt, key)); return; }
        if (input.requireApproval !== undefined && typeof input.requireApproval !== 'boolean') throw new HttpError(400, 'requireApproval must be a boolean');
        if (!['ready', 'starting'].includes(workerStatus)) throw new HttpError(503, 'The simulated worker is unavailable. Restart the app to recover pending deliveries.');
        const job = demo!.enqueue(prompt, key, input.requireApproval === true); json(response, 202, { id: job.id, status: job.status }); return;
      }
      const decision = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/decision$/);
      if (decision && demo) {
        fields(input, ['decision']); if (input.decision !== 'approve' && input.decision !== 'deny') throw new HttpError(400, 'Decision must be approve or deny');
        const job = demo.decide(decision[1], input.decision); json(response, 200, { id: job.id, status: job.status }); return;
      }
      const taskInput = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]{1,200})\/input$/);
      if (taskInput && runtime) {
        fields(input, ['text','idempotencyKey','expectedGeneration','replyToRequestId','acknowledgeQuestionUnavailable','expectedSessionId']);
        if(input.acknowledgeQuestionUnavailable!==undefined&&input.acknowledgeQuestionUnavailable!==true)throw new HttpError(400,'Explicit acknowledgement must be true');
        json(response, 202, await runtime.sendObjectiveInput(taskInput[1], { text: textField(input.text, 'Task input'), idempotencyKey: requestKey(input.idempotencyKey), expectedGeneration: revision(input.expectedGeneration), ...(input.replyToRequestId !== undefined ? { replyToRequestId: textField(input.replyToRequestId, 'Question', 512) } : {}), ...(input.acknowledgeQuestionUnavailable===true?{acknowledgeQuestionUnavailable:true as const}:{}), ...(input.expectedSessionId!==undefined?{expectedSessionId:textField(input.expectedSessionId,'Session',200)}:{}) })); return;
      }
      const control = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]{1,200})\/control$/);
      if (control && runtime) {
        fields(input, ['action', 'expectedRevision', 'idempotencyKey','reviewedUnknownControlKey','acknowledgeUncertainOutcome']);
        if(input.acknowledgeUncertainOutcome!==undefined&&input.acknowledgeUncertainOutcome!==true)throw new HttpError(400,'Explicit uncertainty acknowledgement must be true');
        if (!['pause', 'resume', 'cancel'].includes(String(input.action))) throw new HttpError(400, 'Action must be pause, resume or cancel');
        json(response, 200, await runtime.controlObjective(control[1], input.action as 'pause' | 'resume' | 'cancel', revision(input.expectedRevision), requestKey(input.idempotencyKey), {...(input.reviewedUnknownControlKey!==undefined?{reviewedUnknownControlKey:requestKey(input.reviewedUnknownControlKey)}:{}),...(input.acknowledgeUncertainOutcome===true?{acknowledgeUncertainOutcome:true as const}:{})})); return;
      }
      const approval = url.pathname.match(/^\/api\/approvals\/([a-zA-Z0-9_-]{1,200})\/decision$/);
      if (approval && runtime) {
        fields(input, ['decision', 'expectedRevision', 'idempotencyKey']);
        if (input.decision !== 'allow_once' && input.decision !== 'deny') throw new HttpError(400, 'Decision must be allow_once or deny');
        json(response, 200, await runtime.decideApproval(approval[1], input.decision, revision(input.expectedRevision), requestKey(input.idempotencyKey))); return;
      }
      const turn = url.pathname.match(/^\/api\/turns\/([a-zA-Z0-9_-]{1,200})\/cancel$/);
      if (turn && runtime) { fields(input, ['expectedRevision', 'idempotencyKey']); json(response, 200, await runtime.cancelTurn(turn[1], revision(input.expectedRevision), requestKey(input.idempotencyKey))); return; }
      if (url.pathname === '/api/notifications/page' && runtime) { fields(input,['limit','after']);json(response,200,runtime.listNotifications(input.limit===undefined?100:Number(input.limit),input.after===undefined?undefined:String(input.after)));return; }
      if (url.pathname === '/api/notifications/ack' && runtime) { fields(input,['ids']);json(response,200,runtime.acknowledgeNotifications(input.ids as string[]));return; }
      if (url.pathname === '/api/notifications/mode' && runtime) { fields(input,['mode']);if(!['all','off'].includes(String(input.mode)))throw new HttpError(400,'Notification mode supports all or off');json(response,200,runtime.setNotificationMode(input.mode as 'all'|'off'));return; }
      if (url.pathname === '/api/memory/search' && runtime) { fields(input,['query','cursor']); json(response,200,await runtime.searchMemory(textField(input.query,'Search query',1000),input.cursor === undefined ? undefined : textField(input.cursor,'Cursor',4096))); return; }
      if (url.pathname === '/api/memory/read' && runtime) { fields(input,['frameId']); json(response,200,await runtime.readMemory(textField(input.frameId,'Frame',512))); return; }
      if (url.pathname === '/api/reminders' && runtime) { fields(input, ['intent','at','timeZone','intervalSeconds','idempotencyKey']); json(response, 202, await runtime.createReminder(input as unknown as ReminderInput)); return; }
      if(url.pathname.startsWith('/api/calendar-reminders')&&!runtime)throw new HttpError(409,'Calendar reminders require Runtime mode');
      if(url.pathname.startsWith('/api/calendar-proposals')&&(!authConfig||!runtime))throw new CalendarProposalError('calendar_owner_authentication_required',403);
      if(url.pathname==='/api/calendar-proposals/page'&&runtime){fields(input,['afterId','limit']);json(response,200,{enabled:Boolean(hostToolsConfig?.tools.calendarProposals),...await runtime.listCalendarProposals(input as {afterId?:string;limit?:number})});return;}
      const proposalAction=url.pathname.match(/^\/api\/calendar-proposals\/(calprop-[a-f0-9]{64})\/(preview|confirm|dismiss)$/);
      if(proposalAction&&runtime){
        const id=proposalAction[1]!,action=proposalAction[2]!;
        if(action==='preview'){fields(input,['expectedRevision']);json(response,200,await runtime.previewCalendarProposal(id,revision(input.expectedRevision)));return;}
        if(action==='dismiss'){fields(input,['expectedRevision']);json(response,200,await runtime.dismissCalendarProposal(id,revision(input.expectedRevision)));return;}
        fields(input,['expectedRevision','ruleFingerprint','previewFingerprint','confirmed']);if(input.confirmed!==true)throw new CalendarProposalError('calendar_confirmation_required',400);if(typeof input.ruleFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(input.ruleFingerprint))throw new CalendarProposalError('calendar_proposal_fingerprint_invalid',400);
        json(response,200,await runtime.confirmCalendarProposal(id,{expectedRevision:revision(input.expectedRevision),ruleFingerprint:input.ruleFingerprint,confirmed:true,...(input.previewFingerprint!==undefined?{previewFingerprint:String(input.previewFingerprint)}:{})}));return;
      }
      if(url.pathname==='/api/calendar-reminders/preview'&&runtime){fields(input,['rule']);json(response,200,runtime.previewCalendarReminder(input.rule));return;}
      if(url.pathname==='/api/calendar-reminders/page'&&runtime){fields(input,['limit','afterId']);json(response,200,await runtime.listCalendarReminders(input as {limit?:number;afterId?:string}));return;}
      if(url.pathname==='/api/calendar-reminders/reconcile'&&runtime){fields(input,[]);json(response,200,await runtime.reconcileCalendarReminders());return;}
      if(url.pathname==='/api/calendar-reminders'&&runtime){fields(input,['rule','idempotencyKey','confirmed','previewFingerprint']);if(input.confirmed!==true)throw new CalendarReminderError('calendar_confirmation_required');json(response,202,await runtime.createCalendarReminder({rule:input.rule,idempotencyKey:requestKey(input.idempotencyKey),confirmed:true,...(input.previewFingerprint!==undefined?{previewFingerprint:String(input.previewFingerprint)}:{})}));return;}
      const calendarControl=url.pathname.match(/^\/api\/calendar-reminders\/(cal-[a-f0-9]{64})\/control$/);
      if(calendarControl&&runtime){fields(input,['action','expectedRevision','idempotencyKey','confirmed']);if(input.confirmed!==true)throw new CalendarReminderError('calendar_confirmation_required');json(response,200,await runtime.controlCalendarReminder(calendarControl[1]!,{action:input.action as CalendarControlInput['action'],expectedRevision:revision(input.expectedRevision),idempotencyKey:requestKey(input.idempotencyKey),confirmed:true}));return;}
      const reminderControl = url.pathname.match(/^\/api\/reminders\/([a-zA-Z0-9_-]{1,200})\/control$/);
      if (reminderControl && runtime) { fields(input, ['action','expectedRevision']); if (!['pause','resume','cancel'].includes(String(input.action))) throw new HttpError(400, 'Invalid reminder control'); json(response, 200, await runtime.controlReminder(reminderControl[1], input.action as 'pause' | 'resume' | 'cancel', revision(input.expectedRevision))); return; }
      if (url.pathname === '/api/models/select' && runtime) {
        fields(input, ['model', 'expectedCurrent', 'reasoningEffort']); if (typeof input.expectedCurrent !== 'string' || input.expectedCurrent.length > 250) throw new HttpError(400, 'expectedCurrent is required'); json(response, 200, await runtime.selectModel({ model: textField(input.model, 'Model', 250), expectedCurrent: input.expectedCurrent, ...(input.reasoningEffort !== undefined ? { reasoningEffort: textField(input.reasoningEffort, 'Reasoning effort', 20) } : {}) })); return;
      }
      if (url.pathname === '/api/models/connect' && runtime) { fields(input, ['requestId','label','protocol','baseUrl','apiKey','model']); json(response, 200, await runtime.connectProvider(input)); return; }
      if (url.pathname === '/api/models/account' && runtime) { fields(input, ['accountId']); json(response, 200, await runtime.bindProvider({ accountId: textField(input.accountId, 'Account', 200) })); return; }
      if (url.pathname === '/api/refresh' && runtime) { fields(input, []); await runtime.refresh(); json(response, 200, snapshot(session)); return; }
      throw new HttpError(404, 'Not found');
      };
      return await (authConfig && runtime ? runtime.withRequestAuthorization(assertCurrent, performRequest) : performRequest());
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      if (privateResponse && authConfig && (!session || !auth?.isCurrentSession(session.id))) json(response, 401, { error: 'authentication_required', code: 'authentication_required' });
      else if (error instanceof AuthError) json(response, error.status, { error: error.code, code: error.code });
      else if(error instanceof VoiceStreamError)json(response,error.status,{error:error.code,code:error.code});
      else if (error instanceof ConnectorError) json(response, error.status, { error: error.code, code: error.code });
      else if(error instanceof CalendarReminderError){const status=/closed|authorization_unavailable/.test(error.code)?503:/invalid|required|limit|unsupported|out_of_range/.test(error.code)?400:409;json(response,status,{error:error.code,code:error.code});}
      else if(error instanceof AuthoredDocumentError)json(response,error.status,{error:error.code,code:error.code});
      else if(error instanceof ArtifactVersionError)json(response,error.status,{error:error.code,code:error.code});
      else if(error instanceof CalendarProposalError)json(response,error.status,{error:error.code,code:error.code});
      else if (error instanceof ComputerApprovalError || error instanceof ObjectiveInputError || error instanceof AttachmentUploadError || error instanceof VoiceError || error instanceof HttpError || error instanceof RuntimeUnavailableError || error instanceof ComputerGatewayError || error instanceof ArtifactError) json(response, error.status, { error: error.message });
      else if (error instanceof ModelSettingsError || error instanceof ReminderError || error instanceof MemoryViewError || error instanceof NotificationError) json(response, 409, { error: error.message });
      else if (error instanceof ConflictError || error instanceof ControlConflict) json(response, 409, { error: error.message });
      else if (error instanceof MissingError) json(response, 404, { error: error.message });
      else if (error instanceof MorphzError) json(response, error.status === 409 ? 409 : error.status >= 500 ? 503 : error.status, { error: `Morphz returned HTTP ${error.status}. Refresh current state before retrying.`, code: error.code });
      else { console.error('Local request failed:', error instanceof Error ? error.name : 'unknown'); json(response, 500, { error: 'The operation could not be confirmed. Saved data is retained; retry the same command key.' }); }
    }
  });
  computer.attach(server);
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    if (!started) rejectReady(new AuthError('authentication_startup_stopped', 503));
    const listenerClosed = server.listening ? new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())) : Promise.resolve();
    const authClosed = auth?.close(); // Revoke active browser streams immediately.
    const connectorsClosed = hostTools?.close(); // Stop callback admission and abort before waiting on other subsystems.
    voice.close();
    const voiceStreamsClosed=voiceStreams.close();
    closePromise = (async () => {
      await authClosed; await voiceStreamsClosed;
      await connectorsClosed; // All admitted callback receipts settle while SQLite remains open.
      await computerHost?.close(); await computer.close(); await listenerClosed;
      if (worker && worker.threadId !== -1) await new Promise<void>(resolveExit => { const timeout = setTimeout(() => { void worker!.terminate(); }, 3000); worker!.once('exit', () => { clearTimeout(timeout); resolveExit(); }); worker!.postMessage('stop'); });
      if (runtime) await runtime.close(); else demo!.close();
    })();
    return closePromise;
  };
  server.once('listening', () => {
    try {
      if (closing) throw new AuthError('authentication_startup_stopped', 503);
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new AuthError('authentication_loopback_listener_required', 503);
      applicationOrigin = createApplicationOrigin({ localPort: address.port, ownerAuthEnabled: Boolean(authConfig), publicOrigin });
      if (authConfig) {
        auth = new OwnerAuth({ db: store.db, ownerId: runtime!.store.binding()!.userId, origin: applicationOrigin.origin, config: authConfig, now: options.authNow });
        auth.onInvalidate(id => { computer.revokeSessions(id); void voiceStreams.revokeSessions(id ?? undefined); });
      }
      started = true;
      if (options.autoStart !== false) runtime?.start();
      computerHost?.start();
      void hostTools?.start().catch(() => {}); // Explicit config only; failures remain visible without blocking ordinary chat.
      if (mode === 'demo' && options.startWorker !== false) {
        worker = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { dbPath: options.dbPath, durationMs: options.simulationMs ?? 5000 } });
        worker.on('message', message => { if (message.status === 'ready') workerStatus = 'ready'; });
        worker.on('error', () => { workerStatus = 'failed'; console.error('The simulated worker stopped. Restart to recover durable pending deliveries.'); });
        worker.on('exit', () => { if (!closing) workerStatus = 'stopped'; });
      }
      resolveReady();
    } catch (error) {
      startupError = error instanceof AuthError ? error : new AuthError('authentication_startup_failed', 503);
      rejectReady(startupError); void close().catch(() => {});
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.maxRequestsPerSocket = 100;
  return { server, store, runtime, computer, computerHost, connectors, hostTools, voiceStreams, ready, close };
}
if (import.meta.main) {
  process.umask(0o077);
  const port = Number(process.env.PORT ?? 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const mode = process.env.OPENDOTS_MODE ?? 'runtime'; if (!['runtime', 'demo'].includes(mode)) throw new Error('OPENDOTS_MODE must be runtime or demo');
  if(process.env.OPENDOTS_COMPUTER_CONFIG&&mode!=='runtime')throw new Error('Computer Edge mode requires actual Runtime mode');
  const nativeComputer=process.env.OPENDOTS_COMPUTER_CONFIG?configuredLinuxComputer(process.env.OPENDOTS_COMPUTER_CONFIG,process.env.MORPHZ_URL??''):undefined;
  const app = createApplication({ mode: mode as 'runtime' | 'demo', authConfigPath: process.env.OPENDOTS_AUTH_CONFIG, publicOrigin: process.env.OPENDOTS_PUBLIC_ORIGIN, hostToolsConfigPath: process.env.OPENDOTS_HOST_TOOLS_CONFIG, connectorConfigPath: process.env.OPENDOTS_CONNECTOR_CONFIG, voice: configuredVoiceProvider(), dbPath: resolve(process.env.OPENDOTS_DB_PATH ?? (mode === 'demo' ? '.data/demo.sqlite' : '.data/opendots.sqlite')), baseUrl: process.env.MORPHZ_URL, operatorToken: process.env.MORPHZ_OPERATOR_TOKEN, computerHost:nativeComputer?.computerHost, computer: nativeComputer?.computer ?? (process.env.OPENDOTS_COMPUTER_ENABLED === '1' ? { previewPort: Number(process.env.OPENDOTS_VNC_PREVIEW_PORT), controlPort: Number(process.env.OPENDOTS_VNC_CONTROL_PORT), previewReadOnlyEnforced: process.env.OPENDOTS_VNC_PREVIEW_READ_ONLY === '1' } : undefined) });
  app.server.on('error', async () => { console.error('Could not start the local server. Check whether the port is in use.'); await app.close(); process.exitCode = 1; });
  app.server.listen(port, '127.0.0.1');
  void app.ready.then(() => console.log(`opendots ${mode}: ${process.env.OPENDOTS_PUBLIC_ORIGIN === undefined ? `http://127.0.0.1:${port}` : canonicalPublicOrigin(process.env.OPENDOTS_PUBLIC_ORIGIN)}\n${mode === 'demo' ? 'Simulation only; no model calls or Morphz execution.' : process.env.OPENDOTS_PUBLIC_ORIGIN === undefined ? 'Local single-user mode. Morphz credentials stay server-side.' : 'Canonical HTTPS mode; listener stays on 127.0.0.1. A separately configured TLS proxy is required.'}`), async () => { console.error('Local startup authentication checks failed. Verify the explicit private configuration and saved origin.'); await app.close(); process.exitCode = 1; });
  const shutdown = async () => { await app.close(); process.exitCode = 0; }; process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
