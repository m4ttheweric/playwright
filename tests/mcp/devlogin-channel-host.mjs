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

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const fixture = JSON.parse(fs.readFileSync(process.env.DEVLOGIN_FIXTURE, 'utf8'));
const child = spawn(process.execPath, [...process.argv.slice(2), '--secrets-channel-fd=3'], {
  stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
});
child.on('exit', code => process.exit(code ?? 0));
process.on('SIGTERM', () => child.kill());

const channel = child.stdio[3];
if (fixture.closeChannel)
  channel.destroy();

let buffer = '';
channel.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    answer(JSON.parse(line));
  }
});

function answer(request) {
  fs.appendFileSync(fixture.requestLog, JSON.stringify(request) + '\n');
  const login = fixture.logins.find(l => l.name === request.name);
  let reply;
  if (!login)
    reply = { id: request.id, name: request.name, refused: fixture.refusal ?? 'unknown', until: fixture.until };
  else if (login.origin !== request.frameOrigin || (login.kind === 'password' && request.elementKind !== 'password'))
    reply = { id: request.id, name: request.name, refused: 'mismatch' };
  else
    reply = { id: request.id, name: request.name, origin: login.origin, kind: login.kind, value: login.value };
  setTimeout(() => {
    if (fixture.staleFirst)
      channel.write(JSON.stringify({ ...reply, id: `stale-${request.id}`, value: 'WRONG-VALUE' }) + '\n');
    channel.write(JSON.stringify(reply) + '\n');
  }, fixture.delayMs ?? 0);
}
