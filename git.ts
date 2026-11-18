import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { ZERO, object, commitInfo, treeEntries, resolve, ancestor, error } from './store.ts';

const types = ['', 'commit', 'tree', 'blob', 'tag'];
const flush = Buffer.from('0000'), delim = Buffer.from('0001');
export function packet(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (data.length > 65516) error(400, 'Packet exceeds Git limit');
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0')), data]);
}
function packets(data) {
  let offset = 0;
  const lines = [];
  while (offset + 4 <= data.length) {
    const hex = data.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/i.test(hex)) error(400, 'Invalid packet header');
    const size = parseInt(hex, 16);
    offset += 4;
    if (size === 0) { lines.push(null); continue; }
    if (size <= 2) { lines.push(''); continue; }
    if (size < 4 || offset + size - 4 > data.length) error(400, 'Incomplete packet');
    lines.push(data.toString('utf8', offset, offset + size - 4));
    offset += size - 4;
  }
  if (offset !== data.length) error(400, 'Trailing packet data');
  return lines;
}
function band(data) {
  const chunks = [];
  for (let i = 0; i < data.length; i += 65515) chunks.push(packet(Buffer.concat([Buffer.from([1]), data.subarray(i, i + 65515)])));
  return chunks;
}
function peel(repo, sha) {
  const seen = new Set();
  while (repo.objects.get(sha)?.type === 'tag' && !seen.has(sha)) {
    seen.add(sha);
    sha = /^object ([0-9a-f]{40})/m.exec(repo.objects.get(sha).data.toString())?.[1] || sha;
  }
  return sha;
}
function refs(repo) {
  const entries = [...repo.refs].map(([name, sha]) => ({ name, sha }));
  const head = resolve(repo, repo.default_branch);
  if (head) entries.unshift({ name: 'HEAD', sha: head });
  return entries;
}
function advertisement(repo, service, v2) {
  if (service === 'git-upload-pack' && v2) return Buffer.concat(['version 2\n', 'agent=SmallForge/1\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(packet).concat(flush));
  const push = service === 'git-receive-pack';
  const caps = push ? 'report-status side-band-64k delete-refs ofs-delta' : `multi_ack_detailed side-band-64k shallow ofs-delta symref=HEAD:refs/heads/${repo.default_branch}`;
  const list = refs(repo), out = [packet(`# service=${service}\n`), flush];
  if (!list.length) out.push(packet(`${ZERO} capabilities^{}\0${caps}\n`));
  for (let i = 0; i < list.length; ++i) {
    const item = list[i];
    out.push(packet(`${item.sha} ${item.name}${i === 0 ? '\0' + caps : ''}\n`));
    if (item.name.startsWith('refs/tags/') && peel(repo, item.sha) !== item.sha) out.push(packet(`${peel(repo, item.sha)} ${item.name}^{}\n`));
  }
  return Buffer.concat([...out, flush]);
}
function reachable(repo, roots, depth = Infinity, stop = new Set()) {
  const objects = new Set(), shallow = new Set(), commitDepth = new Map();
  const queue = roots.map(sha => [sha, 1]);
  for (let i = 0; i < queue.length; ++i) {
    const [sha, level] = queue[i];
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    if (objects.has(sha) && (obj.type !== 'commit' || commitDepth.get(sha) <= level)) continue;
    objects.add(sha);
    if (obj.type === 'commit') {
      commitDepth.set(sha, level);
      const commit = commitInfo(repo, sha);
      queue.push([commit.tree, level]);
      if (level >= depth || stop.has(sha)) {
        if (commit.parents.length) shallow.add(sha);
      } else {
        shallow.delete(sha);
        queue.push(...commit.parents.map(p => [p, level + 1]));
      }
    } else if (obj.type === 'tree') {
      for (const entry of treeEntries(repo, sha)) if (entry.mode !== '160000') queue.push([entry.sha, level]);
    } else if (obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})/m.exec(obj.data.toString())?.[1];
      if (target) queue.push([target, level]);
    }
  }
  return { objects, shallow };
}
function packedObject(obj) {
  if (obj.packed) return obj.packed;
  let length = obj.data.length;
  let byte = (types.indexOf(obj.type) << 4) | (length & 15);
  length = Math.floor(length / 16);
  const header = [];
  while (length) {
    header.push(byte | 128);
    byte = length & 127;
    length = Math.floor(length / 128);
  }
  header.push(byte);
  obj.packed = Buffer.concat([Buffer.from(header), deflateSync(obj.data, { level: 1 })]);
  return obj.packed;
}
function pack(repo, ids) {
  const header = Buffer.alloc(12);
  header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(ids.length, 8);
  const pieces = [header, ...ids.map(id => packedObject(repo.objects.get(id)))];
  const hash = createHash('sha1');
  for (const piece of pieces) hash.update(piece);
  pieces.push(hash.digest());
  return Buffer.concat(pieces);
}
function delta(base, data) {
  let pos = 0;
  const readInt = () => {
    let value = 0, shift = 0, byte;
    do { if (pos >= data.length || shift > 49) error(400, 'Invalid delta'); byte = data[pos++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
    return value;
  };
  if (readInt() !== base.length) error(400, 'Invalid delta base size');
  const size = readInt(), output = Buffer.alloc(size);
  let written = 0;
  while (pos < data.length) {
    const op = data[pos++];
    if (op & 128) {
      let start = 0, count = 0;
      for (let i = 0; i < 4; ++i) if (op & (1 << i)) start += data[pos++] * 2 ** (8 * i);
      for (let i = 0; i < 3; ++i) if (op & (16 << i)) count += data[pos++] * 2 ** (8 * i);
      count = count || 65536;
      if (start + count > base.length || written + count > size) error(400, 'Invalid delta copy');
      base.copy(output, written, start, start + count); written += count;
    } else {
      if (!op || pos + op > data.length || written + op > size) error(400, 'Invalid delta insertion');
      data.copy(output, written, pos, pos + op); pos += op; written += op;
    }
  }
  if (written !== size) error(400, 'Invalid delta output');
  return output;
}
function readPack(repo, buffer) {
  if (buffer.length < 32 || buffer.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(buffer.readUInt32BE(4))) error(400, 'Invalid pack');
  const digest = createHash('sha1').update(buffer.subarray(0, -20)).digest();
  if (!digest.equals(buffer.subarray(-20))) error(400, 'Pack checksum mismatch');
  const count = buffer.readUInt32BE(8), pending = [], byOffset = new Map();
  let pos = 12;
  for (let i = 0; i < count; ++i) {
    const start = pos;
    let byte = buffer[pos++], size = byte & 15, shift = 4;
    const kind = (byte >> 4) & 7;
    while (byte & 128) { byte = buffer[pos++]; size += (byte & 127) * 2 ** shift; shift += 7; if (shift > 49) error(400, 'Invalid pack size'); }
    let baseOffset, baseSha;
    if (kind === 6) {
      byte = buffer[pos++]; let distance = byte & 127;
      while (byte & 128) { byte = buffer[pos++]; distance = (distance + 1) * 128 + (byte & 127); }
      baseOffset = start - distance;
    } else if (kind === 7) { baseSha = buffer.subarray(pos, pos + 20).toString('hex'); pos += 20; }
    else if (!types[kind]) error(400, 'Invalid pack object type');
    const result = inflateSync(buffer.subarray(pos, -20), { info: true, maxOutputLength: 64 * 1024 * 1024 });
    pos += result.engine.bytesWritten;
    if (result.buffer.length !== size) error(400, 'Pack object size mismatch');
    const item = { start, kind, data: result.buffer, baseOffset, baseSha, result: null };
    if (types[kind]) {
      const sha = object(repo, types[kind], item.data);
      item.result = repo.objects.get(sha);
    }
    byOffset.set(start, item); pending.push(item);
  }
  if (pos !== buffer.length - 20) error(400, 'Pack trailing bytes');
  let unresolved = pending.filter(x => !x.result);
  while (unresolved.length) {
    const left = [];
    for (const item of unresolved) {
      const base = item.baseSha ? repo.objects.get(item.baseSha) : byOffset.get(item.baseOffset)?.result;
      if (!base) { left.push(item); continue; }
      const sha = object(repo, base.type, delta(base.data, item.data));
      item.result = repo.objects.get(sha);
    }
    if (left.length === unresolved.length) error(400, 'Missing delta base');
    unresolved = left;
  }
}
function receive(repo, data) {
  let pos = 0, capabilities = '', commands = [];
  while (pos + 4 <= data.length) {
    const size = parseInt(data.toString('ascii', pos, pos + 4), 16);
    pos += 4;
    if (!size) break;
    if (!Number.isFinite(size) || size < 4 || pos + size - 4 > data.length) error(400, 'Invalid receive packet');
    const line = data.toString('utf8', pos, pos + size - 4).replace(/\n$/, '');
    pos += size - 4;
    const [command, caps] = line.split('\0');
    if (caps) capabilities = caps;
    const [old, next, ref] = command.split(' ');
    if (!/^[0-9a-f]{40}$/.test(old) || !/^[0-9a-f]{40}$/.test(next) || !ref?.startsWith('refs/')) error(400, 'Invalid ref command');
    commands.push({ old, next, ref });
  }
  let unpack = 'ok';
  try { if (pos < data.length) readPack(repo, data.subarray(pos)); } catch (err) { unpack = err.message; }
  const reports = [packet(`unpack ${unpack}\n`)];
  for (const { old, next, ref } of commands) {
    let reason = unpack === 'ok' ? '' : 'unpacker error';
    const current = repo.refs.get(ref) || ZERO;
    if (!reason && current !== old) reason = 'stale ref';
    if (!reason && next !== ZERO && !repo.objects.has(next)) reason = 'missing object';
    if (!reason && old !== ZERO && next !== ZERO && !ancestor(repo, old, next)) reason = 'non-fast-forward';
    if (!reason) { if (next === ZERO) repo.refs.delete(ref); else repo.refs.set(ref, next); }
    reports.push(packet(reason ? `ng ${ref} ${reason}\n` : `ok ${ref}\n`));
  }
  const report = Buffer.concat([...reports, flush]);
  return capabilities.includes('side-band-64k') ? Buffer.concat([...band(report), flush]) : report;
}
function upload(repo, data, v2) {
  const lines = packets(data).filter(x => typeof x === 'string').map(x => x.replace(/\n$/, ''));
  if (lines.includes('command=ls-refs')) {
    const prefixes = lines.filter(x => x.startsWith('ref-prefix ')).map(x => x.slice(11));
    const result = [];
    for (const ref of refs(repo)) {
      if (prefixes.length && !prefixes.some(p => ref.name.startsWith(p))) continue;
      const attributes = [];
      if (ref.name === 'HEAD' && lines.includes('symrefs')) attributes.push(`symref-target:refs/heads/${repo.default_branch}`);
      const target = peel(repo, ref.sha);
      if (target !== ref.sha && lines.includes('peel')) attributes.push(`peeled:${target}`);
      result.push(packet(`${ref.sha} ${ref.name}${attributes.length ? ' ' + attributes.join(' ') : ''}\n`));
    }
    if (!repo.refs.size && lines.includes('unborn') && (!prefixes.length || prefixes.some(p => 'HEAD'.startsWith(p)))) result.push(packet(`unborn HEAD symref-target:refs/heads/${repo.default_branch}\n`));
    return Buffer.concat([...result, flush]);
  }
  const wants = lines.filter(x => x.startsWith('want ')).map(x => x.split(' ')[1]);
  const haves = lines.filter(x => x.startsWith('have ')).map(x => x.split(' ')[1]);
  const shallows = lines.filter(x => x.startsWith('shallow ')).map(x => x.split(' ')[1]);
  const deepen = lines.find(x => x.startsWith('deepen '));
  const depth = deepen ? Math.max(1, Number(deepen.slice(7))) : Infinity;
  for (const sha of wants) if (!repo.objects.has(sha)) error(400, 'Unknown wanted object');
  const cacheKey = JSON.stringify([wants, haves, shallows, depth, v2]);
  repo.fetchCache ||= new Map();
  if (repo.fetchCache.has(cacheKey)) return repo.fetchCache.get(cacheKey);
  const needed = reachable(repo, wants, depth);
  const known = reachable(repo, haves, Infinity, new Set(shallows)).objects;
  const ids = [...needed.objects].filter(sha => !known.has(sha));
  const pieces = [];
  if (v2) {
    if (needed.shallow.size || shallows.length) {
      pieces.push(packet('shallow-info\n'));
      for (const sha of needed.shallow) pieces.push(packet(`shallow ${sha}\n`));
      for (const sha of shallows) if (!needed.shallow.has(sha)) pieces.push(packet(`unshallow ${sha}\n`));
      pieces.push(delim);
    }
    pieces.push(packet('packfile\n'), ...band(pack(repo, ids)), flush);
  } else {
    for (const sha of needed.shallow) pieces.push(packet(`shallow ${sha}\n`));
    for (const sha of shallows) if (!needed.shallow.has(sha)) pieces.push(packet(`unshallow ${sha}\n`));
    if (deepen) pieces.push(flush);
    pieces.push(packet('NAK\n'), ...band(pack(repo, ids)), flush);
  }
  const result = Buffer.concat(pieces);
  if (repo.fetchCache.size >= 16) repo.fetchCache.delete(repo.fetchCache.keys().next().value);
  repo.fetchCache.set(cacheKey, result);
  return result;
}
export function serveGit(repo, req, res, url, body) {
  const service = url.pathname.endsWith('/info/refs') ? url.searchParams.get('service') : url.pathname.split('/').at(-1);
  if (!['git-upload-pack', 'git-receive-pack'].includes(service)) error(404, 'Not Found');
  const v2 = String(req.headers['git-protocol'] || '').includes('version=2');
  const advertise = req.method === 'GET' && url.pathname.endsWith('/info/refs');
  if (!advertise && req.method !== 'POST') error(405, 'Method Not Allowed');
  const result = advertise ? advertisement(repo, service, v2) : service === 'git-receive-pack' ? receive(repo, body) : upload(repo, body, v2);
  res.writeHead(200, { 'content-type': `application/x-${service}-${advertise ? 'advertisement' : 'result'}`, 'cache-control': 'no-cache', 'content-length': result.length });
  res.end(result);
}
