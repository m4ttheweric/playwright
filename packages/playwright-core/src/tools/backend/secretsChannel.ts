/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import crypto from 'crypto';
import net from 'net';

export type SecretReply =
  | { id: string, name: string, origin: string, kind: 'email' | 'password', value: string }
  | { id: string, name: string, refused: 'unknown' | 'mismatch' | 'limited' | 'unavailable', until?: number };

export type SavedLoginFields = { email: string, password: string };

type SavedLoginReply = { id: string, type: 'saved-login', origin: string, fields?: { email?: unknown, password?: unknown }, none?: true };

const REPLY_TIMEOUT_MS = 10_000;
const SAVED_LOGIN_TIMEOUT_MS = 1000;

type Pending = {
  matches: (reply: any) => boolean;
  resolve: (reply: any) => void;
  timer: NodeJS.Timeout;
};

export class SecretsChannel {
  private _socket: net.Socket | undefined;
  private _buffer = '';
  private _pending = new Map<string, Pending>();

  constructor(fd: number) {
    const socket = new net.Socket({ fd, readable: true, writable: true });
    socket.setEncoding('utf8');
    socket.on('data', chunk => this._onData(String(chunk)));
    const closed = () => this._close();
    socket.on('end', closed);
    socket.on('close', closed);
    socket.on('error', closed);
    socket.unref();
    this._socket = socket;
  }

  request(name: string, frameOrigin: string, elementKind: 'password' | 'text'): Promise<SecretReply | 'timeout' | 'no-channel'> {
    return this._send<SecretReply>({ name, frameOrigin, elementKind }, reply => reply.name === name, REPLY_TIMEOUT_MS);
  }

  async savedLogin(origin: string, timeoutMs = SAVED_LOGIN_TIMEOUT_MS): Promise<SavedLoginFields | undefined> {
    const reply = await this._send<SavedLoginReply>({ type: 'saved-login', origin }, reply => reply.type === 'saved-login' && reply.origin === origin, timeoutMs);
    if (reply === 'timeout' || reply === 'no-channel' || reply.none)
      return undefined;
    const email = reply.fields?.email;
    const password = reply.fields?.password;
    if (typeof email !== 'string' || !email || typeof password !== 'string' || !password)
      return undefined;
    return { email, password };
  }

  private _send<T>(message: object, matches: (reply: any) => boolean, timeoutMs: number): Promise<T | 'timeout' | 'no-channel'> {
    const socket = this._socket;
    if (!socket || socket.destroyed || !socket.writable)
      return Promise.resolve('no-channel');
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve('timeout');
      }, timeoutMs);
      this._pending.set(id, { matches, resolve, timer });
      socket.write(JSON.stringify({ id, ...message }) + '\n');
    });
  }

  private _onData(chunk: string) {
    this._buffer += chunk;
    let newline: number;
    while ((newline = this._buffer.indexOf('\n')) !== -1) {
      const line = this._buffer.slice(0, newline);
      this._buffer = this._buffer.slice(newline + 1);
      let reply: any;
      try {
        reply = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = typeof reply?.id === 'string' ? this._pending.get(reply.id) : undefined;
      if (!pending || !pending.matches(reply))
        continue;
      this._pending.delete(reply.id);
      clearTimeout(pending.timer);
      pending.resolve(reply);
    }
  }

  private _close() {
    this._socket = undefined;
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve('no-channel');
    }
    this._pending.clear();
  }
}

let shared: SecretsChannel | undefined;

export function secretsChannel(fd: number | undefined): SecretsChannel | undefined {
  if (fd === undefined)
    return undefined;
  shared ??= new SecretsChannel(fd);
  return shared;
}
