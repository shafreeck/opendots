import { initialDocument, isProductDocument, MobilePolicyError, validateEndpoint } from './policy.ts';
export type ConnectionError = 'invalid_endpoint' | 'phone_loopback' | 'unreachable' | 'authentication_required' | 'invalid_server' | 'navigation_blocked' | 'webview_failed';
export interface ConnectionState { phase: 'disconnected' | 'checking' | 'loading' | 'connected' | 'offline' | 'suspended'; epoch: number; origin: string | null; source: string | null; error: ConnectionError | null; }
export interface ProbeResponse { status: number; url: string; redirected: boolean; headers: Pick<Headers, 'get'>; body: ReadableStream<Uint8Array> | null; }
export type ProbeTransport = (url: string, init: {method:'GET';headers:Record<string,string>;credentials:'omit';redirect:'error';signal:AbortSignal}) => Promise<ProbeResponse>;
class ProbeError extends Error { readonly code:ConnectionError;constructor(code:ConnectionError){super(code);this.code=code;} }
async function authEnabled(response: ProbeResponse, expected: string, signal:AbortSignal): Promise<void> {
  if (response.status !== 200 || response.redirected || response.url !== expected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new ProbeError('invalid_server');
  const declared = response.headers.get('content-length'); if (declared && (!/^\d+$/.test(declared) || Number(declared) > 16384)) throw new ProbeError('invalid_server');
  const reader = response.body?.getReader(); if (!reader) throw new ProbeError('invalid_server');
  const stop=()=>{void reader.cancel().catch(()=>undefined);};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 16384) throw new ProbeError('invalid_server'); chunks.push(part.value); } }
  finally { signal.removeEventListener('abort',stop);void reader.cancel().catch(() => undefined);reader.releaseLock(); }
  const data = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(data)); } catch { throw new ProbeError('invalid_server'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProbeError('invalid_server');
  const result = value as Record<string, unknown>;
  if (result.enabled !== true) throw new ProbeError('authentication_required');
  if (result.authenticated !== false || result.session !== null || !['password','connection_token'].includes(String(result.credentialKind))) throw new ProbeError('invalid_server');
  // Discard the complete response; keep no session/credential fields.
}
export class ConnectionController {
  private state: ConnectionState = {phase:'disconnected',epoch:0,origin:null,source:null,error:null};
  private abort?: AbortController; private disposed = false;
  private readonly transport:ProbeTransport;private readonly publish:(state:ConnectionState)=>void;private readonly timeoutMs:number;
  constructor(transport:ProbeTransport,publish:(state:ConnectionState)=>void,timeoutMs=8000){this.transport=transport;this.publish=publish;this.timeoutMs=timeoutMs;}
  snapshot(): ConnectionState { return {...this.state}; }
  private update(patch: Partial<ConnectionState>) { if(this.disposed)return; this.state={...this.state,...patch};this.publish(this.snapshot()); }
  private invalidate() { this.abort?.abort();this.abort=undefined;this.update({epoch:this.state.epoch+1,source:null}); }
  async connect(raw: unknown): Promise<void> {
    if(this.disposed)return;this.invalidate();const epoch=this.state.epoch;let origin:string;
    try { origin=validateEndpoint(raw); } catch(error) { this.update({phase:'disconnected',origin:null,error:error instanceof MobilePolicyError?error.code:'invalid_endpoint'});return; }
    let response:ProbeResponse|undefined;const controller=new AbortController();this.abort=controller;this.update({phase:'checking',origin,error:null});const timer=setTimeout(()=>{controller.abort();if(!this.disposed&&epoch===this.state.epoch)this.update({phase:'offline',source:null,error:'unreachable'});},this.timeoutMs);
    try { const endpoint=`${origin}/api/auth`;response=await this.transport(endpoint,{method:'GET',headers:{accept:'application/json'},credentials:'omit',redirect:'error',signal:controller.signal});await authEnabled(response,endpoint,controller.signal);if(this.disposed||epoch!==this.state.epoch||controller.signal.aborted)return;this.update({phase:'loading',source:initialDocument(origin),error:null}); }
    catch(error) { if(!this.disposed&&epoch===this.state.epoch)this.update({phase:'offline',source:null,error:controller.signal.aborted?'unreachable':error instanceof ProbeError?error.code:'unreachable'}); }
    finally { clearTimeout(timer);controller.abort();if(response?.body)void response.body.cancel().catch(()=>undefined);if(this.abort===controller)this.abort=undefined; }
  }
  loaded(epoch:number,url:string) { if(this.disposed||epoch!==this.state.epoch||!['loading','connected'].includes(this.state.phase))return;if(!this.state.origin||!isProductDocument(this.state.origin,url)){this.failed(epoch,'navigation_blocked');return;}this.update({phase:'connected'}); }
  failed(epoch:number,error:ConnectionError='webview_failed') { if(this.disposed||epoch!==this.state.epoch||!this.state.source)return;this.invalidate();this.update({phase:'offline',error}); }
  suspend() { if(this.disposed||!['checking','loading','connected'].includes(this.state.phase))return;this.invalidate();this.update({phase:'suspended',error:null}); }
  disconnect(expectedEpoch?:number) { if(this.disposed||(expectedEpoch!==undefined&&expectedEpoch!==this.state.epoch))return;this.invalidate();this.update({phase:'disconnected',origin:null,error:null}); }
  dispose() { this.abort?.abort();this.abort=undefined;this.disposed=true; }
}
