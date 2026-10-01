// Copyright 2026 Newvar and the Morphz contributors. Apache-2.0.
// Vendored from Morphz 7e8f7d81f8b00fd45544d94d5b9a321214633df1.
// See vendor/app-speech/README.md for provenance and local adaptations.
// Adapted: bounded one-shot/streaming operations; local validation/error type; injectable ASR transport.
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import WebSocket from "ws";
import {
  maxTtsSegmentCharacters,
  readSpeechWav,
  wavFromPCM,
} from "./audio.ts";

export class SpeechProviderError extends Error {}
function ttsText(text: string): string {
  if (typeof text !== "string" || !text.trim() || text.trim().length > maxTtsSegmentCharacters)
    throw failure("朗读文字须为 1 至 2000 字符。");
  return text.trim();
}
const audioLimit = 8 * 1024 * 1024;
const maxSpeechFrameBytes = 6400; // Pinned core speech-stream.ts: 200 ms PCM16 at 16 kHz, mono.
const maxSpeechBufferedBytes = 160000;
const speechCloseTimeout = 2000;
function failure(message: string) {
  return new SpeechProviderError(message);
}
/** A terminate request does not prove the underlying socket has closed. */
function socketLifetime(ws: WebSocket, release: () => void) {
  let observedClose = false, terminating = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void, rejectClosed!: (error: Error) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // The caller may cancel while still awaiting ready, then inspect closed later.
  void closed.catch(() => {});
  ws.on("close", () => {
    if (observedClose) return;
    observedClose = true;
    clearTimeout(timer);
    release();
    resolveClosed();
  });
  return {
    closed,
    close() {
      if (observedClose || terminating) return;
      terminating = true;
      timer = setTimeout(() => {
        rejectClosed(failure("语音连接关闭未确认，请稍后重试。"));
      }, speechCloseTimeout);
      timer.unref();
      try { ws.terminate(); }
      catch { rejectClosed(failure("语音连接关闭未确认，请稍后重试。")); }
      // Keep the principal reserved until an actual close, including on timeout.
    },
  };
}
export function asrFrame(
  payload: Uint8Array,
  sequence: number,
  audio: boolean,
  last = false,
): Buffer {
  const compressed = gzipSync(payload),
    b = Buffer.alloc(12 + compressed.length);
  b[0] = 0x11;
  b[1] = (audio ? 0x20 : 0x10) | (last ? 3 : 1);
  b[2] = (audio ? 0 : 0x10) | 1;
  b.writeInt32BE(last ? -sequence : sequence, 4);
  b.writeUInt32BE(compressed.length, 8);
  compressed.copy(b, 12);
  return b;
}
export function asrResponse(raw: Uint8Array) {
  const b = Buffer.from(raw);
  if (b.length < 8 || b[0]! >> 4 !== 1) throw failure("语音服务响应格式无效。");
  const type = b[1]! >> 4,
    flags = b[1]! & 15,
    serialization = b[2]! >> 4,
    compression = b[2]! & 15;
  let cursor = (b[0]! & 15) * 4;
  if (cursor < 4) throw failure("语音响应头无效。");
  const integer = () => {
    if (cursor + 4 > b.length) throw failure("语音响应不完整。");
    const v = b.readInt32BE(cursor);
    cursor += 4;
    return v;
  };
  if (flags & 1) integer();
  if (flags & 4) integer();
  if (type === 15) {
    const code = integer();
    if (code === 45000002) {
      const length = integer();
      if (length < 0 || length > audioLimit || cursor + length !== b.length)
        throw failure("语音响应大小无效。");
      return { last: true, text: "" };
    }
    throw failure(
      `语音识别服务拒绝请求（${code}）。请检查语音模型权限及额度。`,
    );
  }
  if (type !== 9) throw failure("语音服务返回了不支持的消息。");
  const length = integer();
  if (length < 0 || length > audioLimit || cursor + length !== b.length)
    throw failure("语音响应大小无效。");
  let payload = b.subarray(cursor);
  if (compression === 1)
    payload = gunzipSync(payload, { maxOutputLength: 1000000 });
  else if (compression !== 0) throw failure("不支持的语音压缩格式。");
  if (serialization !== 1) throw failure("语音响应不是 JSON。");
  const decoded = JSON.parse(payload.toString("utf8"));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)
      || (decoded.result !== undefined && (!decoded.result || typeof decoded.result !== "object" || Array.isArray(decoded.result)))
      || (decoded.result?.text !== undefined && (typeof decoded.result.text !== "string" || decoded.result.text.length > 30000)))
    throw failure("语音服务响应格式无效。");
  return { last: !!(flags & 2), text: decoded.result?.text ?? "" };
}
/** The host depends on speech capability, not a vendor SDK or client-side key. */
export interface SpeechProvider {
  readonly provider: { id: string; label: string };
  configured(): boolean;
  synthesize(
    principal: string,
    text: string,
    signal: AbortSignal,
  ): Promise<Buffer>;
  transcribe(
    principal: string,
    wav: Uint8Array,
    signal: AbortSignal,
  ): Promise<string>;
  openStream?(
    principal: string,
    result: (text: string, final: boolean) => void,
    error: (message: string) => void,
  ): SpeechDuplex;
}

export interface SpeechDuplex {
  /** Resolves after the PCM request is sent; the provider need not acknowledge it. */
  ready: Promise<void>;
  /** Resolves only after transport closure; rejects if closure is not confirmed. */
  closed: Promise<void>;
  write(pcm: Uint8Array): void;
  finish(): void;
  close(): void;
}

/** Current Doubao adapter. Credentials and transport stay in the center process. */
export class DoubaoSpeechProvider implements SpeechProvider {
  readonly provider = { id: "doubao", label: "豆包" };
  private active = new Map<string, { transport: boolean }>();
  private key: string | undefined;
  private fetcher: typeof fetch;
  private socket: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  constructor(key: string | undefined, fetcher: typeof fetch = fetch,
    socket: (url: string, options: WebSocket.ClientOptions) => WebSocket = (url, options) => new WebSocket(url, options)) {
    this.key = key; this.fetcher = fetcher; this.socket = socket;
  }
  configured() {
    return !!this.key?.trim();
  }
  openStream(
    principal: string,
    result: (text: string, final: boolean) => void,
    error: (message: string) => void,
  ): SpeechDuplex {
    if (!this.configured()) throw failure("尚未配置语音服务。");
    if (this.active.has(principal))
      throw failure("已有语音请求正在处理，请等待完成或取消。");
    const reservation = { transport: true };
    this.active.set(principal, reservation);
    let ws: WebSocket;
    try {
      ws = this.socket(
        "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async",
        {
          headers: {
            "X-Api-Key": this.key!,
            "X-Api-Resource-Id": "volc.seedasr.sauc.duration",
            "X-Api-Request-Id": randomUUID(),
            "X-Api-Connect-Id": randomUUID(),
            "X-Api-Sequence": "-1",
          },
          followRedirects: false,
          maxPayload: 1000000,
          handshakeTimeout: 10000,
        },
      );
    } catch {
      this.active.delete(principal);
      throw failure("无法连接语音识别服务。");
    }
    const lifetime = socketLifetime(ws, () => {
      if (this.active.get(principal) === reservation) this.active.delete(principal);
    });
    let done = false, opened = false, ending = false, sequence = 2, latest = "";
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => {});
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      if (done) return;
      done = true;
      clearTimeout(handshakeTimer);
      clearTimeout(finishTimer);
      rejectReady(failure("语音连接已关闭。"));
      lifetime.close();
    };
    const fail = (message: string) => {
      if (done) return;
      close();
      // A consumer callback must not escape through socket events or leak errors.
      try { error(message); } catch { /* Transport teardown has already started. */ }
    };
    const handshakeTimer = setTimeout(
      () => fail("语音连接超时，未自动重试。"), 10000,
    );
    handshakeTimer.unref();
    const send = (frame: Buffer, message: string): boolean => {
      if (done) return false;
      if (!Number.isFinite(ws.bufferedAmount) || ws.bufferedAmount < 0
          || ws.bufferedAmount + frame.byteLength > maxSpeechBufferedBytes) {
        fail("语音网络传输跟不上，已停止听写；已识别文字保留。");
        return false;
      }
      try {
        let sendFailed = false;
        ws.send(frame, (sendError) => {
          if (sendError) { sendFailed = true; fail(message); }
        });
        return !sendFailed;
      } catch {
        fail(message);
        return false;
      }
    };
    ws.on("open", () => {
      if (done || opened) return;
      opened = true;
      const sent = send(asrFrame(Buffer.from(JSON.stringify({
        user: { uid: randomUUID() },
        audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
        request: {
          model_name: "bigmodel", enable_itn: true, enable_punc: true,
          enable_ddc: true, show_utterances: true, enable_nonstream: false,
          result_type: "full",
        },
      })), 1, false), "无法发送语音识别请求。");
      if (!sent) return;
      clearTimeout(handshakeTimer);
      // Optimized duplex may not answer until audio arrives. Never wait for an ACK.
      resolveReady();
    });
    ws.on("message", (data) => {
      if (done) return;
      try {
        if (!opened) throw failure("语音连接尚未就绪。");
        const response = asrResponse(Buffer.from(data as Buffer));
        if (response.text) latest = response.text;
        if (response.last) close();
        if (response.text || response.last) result(latest, response.last);
      } catch {
        fail("语音服务返回异常，已识别文字保留；未自动重试。");
      }
    });
    ws.on("error", () => fail("语音连接中断，已识别文字保留；请重新开始。"));
    ws.on("close", () => fail("语音连接提前关闭，已识别文字保留；请重新开始。"));
    ws.on("unexpected-response", (_request, response) => {
      try { response.resume(); } catch { /* Never expose transport errors. */ }
      if (done) return;
      const status = Number.isInteger(response.statusCode) && response.statusCode! >= 100
        && response.statusCode! <= 599 ? `（HTTP ${response.statusCode}）` : "";
      fail(`语音连接失败${status}，请检查语音模型权限与额度。`);
    });
    return {
      ready,
      closed: lifetime.closed,
      write: (pcm) => {
        if (done || ending || !opened || ws.readyState !== WebSocket.OPEN)
          throw failure("语音连接已停止，请重新开始。");
        if (!(pcm instanceof Uint8Array) || !pcm.byteLength
            || pcm.byteLength > maxSpeechFrameBytes || pcm.byteLength % 2)
          throw failure("语音帧格式无效。");
        if (!send(asrFrame(pcm, sequence++, true), "语音发送中断，未自动重试。"))
          throw failure("语音发送中断，未自动重试。");
      },
      finish: () => {
        if (done || ending) return;
        if (!opened || ws.readyState !== WebSocket.OPEN)
          throw failure("语音连接尚未就绪。");
        ending = true;
        finishTimer = setTimeout(
          () => fail("语音收尾超时，已识别文字保留；请检查后继续。"), 12000,
        );
        finishTimer.unref();
        if (!send(asrFrame(new Uint8Array(), sequence++, true, true), "语音发送中断，未自动重试。"))
          throw failure("语音发送中断，未自动重试。");
      },
      close,
    };
  }
  private async run<T>(
    principal: string,
    signal: AbortSignal,
    work: () => Promise<T>,
  ) {
    if (!this.configured())
      throw failure("尚未配置语音服务，请先完成服务配置。");
    if (this.active.has(principal))
      throw failure("已有语音请求正在处理，请等待完成或取消。");
    signal.throwIfAborted();
    const reservation = { transport: false };
    this.active.set(principal, reservation);
    try {
      return await work();
    } catch (e) {
      if (signal.aborted) throw failure("语音操作已取消。");
      if (e instanceof SpeechProviderError) throw e;
      throw failure("语音连接失败，未自动重试。请检查网络、模型权限与额度。");
    } finally {
      if (!reservation.transport && this.active.get(principal) === reservation)
        this.active.delete(principal);
    }
  }
  synthesize(principal: string, text: string, signal: AbortSignal) {
    const textToRead = ttsText(text);
    return this.run(principal, signal, async () => {
      const response = await this.fetcher(
        // The supplied credential is an Agent Plan key, like the ASR route below.
        // The general speech endpoint uses a different credential scope.
        "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional",
        {
          method: "POST",
          redirect: "error",
          headers: {
            "X-Api-Key": this.key!,
            "X-Api-Resource-Id": "seed-tts-2.0",
            "X-Api-Request-Id": randomUUID(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            req_params: {
              text: textToRead,
              speaker: "zh_female_vv_uranus_bigtts",
              audio_params: { format: "pcm", sample_rate: 16000 },
            },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(
          response.status === 401
            ? "语音服务鉴权未通过（HTTP 401）。请检查 API Key 是否有效且适用于语音服务。"
            : `语音合成请求未成功（HTTP ${response.status}）。请检查语音模型权限与额度。`,
        );
      }
      if (!response.body) throw failure("语音合成未返回音频。");
      let finished = false;
      let pending = "",
        total = 0,
        depth = 0,
        inString = false,
        escape = false,
        start = -1,
        scan = 0;
      const audio: Buffer[] = [];
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > audioLimit) throw failure("语音响应超过长度限制。");
        pending += decoder.decode(chunk, { stream: true });
        for (; scan < pending.length; scan++) {
          const c = pending[scan];
          if (start < 0) {
            if (/\s/.test(c!)) continue;
            if (c !== "{") throw failure("语音响应格式无效。");
            start = scan;
            depth = 1;
            continue;
          }
          if (inString) {
            if (escape) escape = false;
            else if (c === "\\") escape = true;
            else if (c === '"') inString = false;
            continue;
          }
          if (c === '"') inString = true;
          else if (c === "{") depth++;
          else if (c === "}") depth--;
          if (depth === 0) {
            const data = JSON.parse(pending.slice(start, scan + 1));
            if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.code !== "number"
              || (data.data != null && typeof data.data !== "string")) throw failure("语音服务响应格式无效。");
            if (![0, 20000000].includes(data.code))
              throw failure(
                `语音合成服务拒绝请求（${data.code}）。请检查语音模型权限与额度。`,
              );
            if (data.code === 20000000) finished = true;
            if (data.data) {
              if (
                !/^[A-Za-z0-9+/]*={0,2}$/.test(data.data) ||
                data.data.length % 4
              )
                throw failure("语音音频编码无效。");
              audio.push(Buffer.from(data.data, "base64"));
            }
            pending = pending.slice(scan + 1);
            scan = -1;
            start = -1;
          }
        }
        if (finished) break;
      }
      if (!finished || pending.trim())
        throw failure("语音响应中断，未返回完整内容。");
      const pcm = Buffer.concat(audio);
      if (!pcm.length || pcm.length % 2)
        throw failure("语音合成未返回有效音频。");
      return Buffer.from(wavFromPCM(pcm));
    });
  }
  transcribe(principal: string, wav: Uint8Array, signal: AbortSignal) {
    try {
      readSpeechWav(wav);
    } catch (e) {
      throw failure(e instanceof Error ? e.message : "录音无效。");
    }
    return this.run(
      principal,
      signal,
      () =>
        new Promise<string>((resolve, reject) => {
          const connection = randomUUID();
          let done = false,
            sent = false,
            latest = "";
          let sendTimer: ReturnType<typeof setTimeout> | undefined;
          const ws = this.socket(
            "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async",
            {
              headers: {
                "X-Api-Key": this.key!,
                "X-Api-Resource-Id": "volc.seedasr.sauc.duration",
                "X-Api-Request-Id": connection,
                "X-Api-Connect-Id": connection,
                "X-Api-Sequence": "-1",
              },
              followRedirects: false,
              handshakeTimeout: 10000,
              maxPayload: 1000000,
            },
          );
          const reservation = this.active.get(principal)!;
          reservation.transport = true;
          const lifetime = socketLifetime(ws, () => {
            if (this.active.get(principal) === reservation) this.active.delete(principal);
          });
          const finish = (error?: Error) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearTimeout(sendTimer);
            signal.removeEventListener("abort", abort);
            lifetime.close();
            error ? reject(error) : resolve(latest);
          };
          const abort = () => finish(failure("语音识别已取消。"));
          const timer = setTimeout(
            () => finish(failure("语音识别超时，未自动重试。")),
            90000,
          );
          ws.on("error", () => finish(failure("无法连接语音识别服务。")));
          ws.on("close", () => {
            if (!done) finish(failure("语音识别连接提前关闭，结果未确认。"));
          });
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) {
            abort();
            return;
          }
          ws.on("open", () => {
            if (done) return;
            try { ws.send(
              asrFrame(
                Buffer.from(
                  JSON.stringify({
                    user: { uid: connection },
                    audio: {
                      format: "wav",
                      codec: "raw",
                      rate: 16000,
                      bits: 16,
                      channel: 1,
                    },
                    request: {
                      model_name: "bigmodel",
                      enable_itn: true,
                      enable_punc: true,
                      enable_ddc: true,
                      show_utterances: true,
                      enable_nonstream: false,
                    },
                  }),
                ),
                1,
                false,
              ),
            ); } catch { finish(failure("无法发送语音识别请求。")); }
          });
          ws.on("message", (data) => {
            if (done) return;
            try {
              const response = asrResponse(Buffer.from(data as Buffer));
              if (response.text) latest = response.text;
              if (response.last) {
                if (!latest.trim())
                  finish(failure("没有识别到语音，请重试或直接输入。"));
                else finish();
                return;
              }
              if (!sent) {
                sent = true;
                let sequence = 2,
                  offset = 0;
                const bytes = Buffer.from(wav);
                const send = () => {
                  if (done) return;
                  const last = offset + 6400 >= bytes.length;
                  try { ws.send(
                    asrFrame(
                      bytes.subarray(offset, offset + 6400),
                      sequence++,
                      true,
                      last,
                    ),
                  ); } catch { finish(failure("语音发送中断，未自动重试。")); return; }
                  offset += 6400;
                  if (!last) sendTimer = setTimeout(send, 200);
                };
                send();
              }
            } catch (e) {
              finish(
                e instanceof SpeechProviderError ? e : failure("语音服务响应无效。"),
              );
            }
          });
          ws.on("unexpected-response", (_req, res) => {
            try { res.resume(); } catch { /* Never expose transport errors. */ }
            if (done) return;
            const status = Number.isInteger(res.statusCode) && res.statusCode! >= 100
              && res.statusCode! <= 599 ? `（HTTP ${res.statusCode}）` : "";
            finish(
              failure(
                `语音识别鉴权或连接失败${status}。请检查语音模型权限与额度。`,
              ),
            );
          });
        }),
    );
  }
}
