import { createHash } from 'node:crypto';

export const ZERO = '0'.repeat(40);
export const stamp = '2000-01-01T00:00:00Z';
export const repos = new Map();
export const nodes = new Map();
let sequence = 0;
let login = process.env.FORGE_LOGIN || '';
export const viewer = () => ({ login: login || 'forge', id: 1, type: 'User' });
export function bindOwner(owner) {
  if (!login && owner) login = owner;
  return owner === viewer().login;
}
export function error(status, message) { throw Object.assign(new Error(message), { status }); }
export function identify(kind, value) {
  value.id = ++sequence;
  value.node_id = Buffer.from(`${kind}:${value.id}`).toString('base64');
  nodes.set(value.node_id, { kind, value });
  return value;
}
export function object(repo, type, bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const sha = createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data, sha });
  return sha;
}
export function commitInfo(repo, sha) {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  if (!obj.parsed) {
    const [headers, ...message] = obj.data.toString().split('\n\n');
    obj.parsed = { sha, tree: '', parents: [], message: message.join('\n\n').replace(/\n$/, '') };
    for (const line of headers.split('\n')) {
      if (line.startsWith('tree ')) obj.parsed.tree = line.slice(5);
      if (line.startsWith('parent ')) obj.parsed.parents.push(line.slice(7));
    }
  }
  return obj.parsed;
}
export function treeEntries(repo, sha) {
  const data = repo.objects.get(sha)?.data;
  if (!data) return [];
  const entries = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(32, i), nul = data.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) error(400, 'Invalid tree');
    entries.push({ mode: data.toString('ascii', i, space), name: data.toString('utf8', space + 1, nul), sha: data.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return entries;
}
export function filesAt(repo, ref) {
  const commit = commitInfo(repo, resolve(repo, ref));
  if (!commit) return new Map();
  const tip = repo.objects.get(commit.sha);
  if (tip.files) return new Map(tip.files);
  const files = new Map();
  function visit(sha, prefix) {
    for (const item of treeEntries(repo, sha)) {
      if (item.mode === '40000' || item.mode === '040000') visit(item.sha, prefix + item.name + '/');
      else files.set(prefix + item.name, { sha: item.sha, mode: item.mode });
    }
  }
  visit(commit.tree, '');
  tip.files = files;
  return new Map(files);
}
export function resolve(repo, ref) {
  ref = ref || repo.default_branch;
  if (ref === 'HEAD') ref = repo.default_branch;
  return repo.refs.get(ref) || repo.refs.get(`refs/heads/${ref}`) || repo.refs.get(`refs/tags/${ref}`) || (repo.objects.has(ref) ? ref : null);
}
function makeTree(repo, files) {
  const root = new Map();
  for (const [path, value] of files) {
    const names = path.split('/');
    let at = root;
    for (const name of names.slice(0, -1)) {
      if (!at.has(name)) at.set(name, new Map());
      at = at.get(name);
    }
    at.set(names.at(-1), value);
  }
  function write(dir) {
    const list = [...dir].map(([name, value]) => value instanceof Map ? { name, mode: '40000', sha: write(value) } : { name, ...value });
    list.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
    return object(repo, 'tree', Buffer.concat(list.flatMap(x => [Buffer.from(`${x.mode} ${x.name}\0`), Buffer.from(x.sha, 'hex')])));
  }
  return write(root);
}
export function makeCommit(repo, branch, files, message, parents = null) {
  const tip = resolve(repo, branch);
  parents = parents || (tip ? [tip] : []);
  const tree = makeTree(repo, files);
  const author = `${viewer().login} <forge@example.invalid> 946684800 +0000`;
  const sha = object(repo, 'commit', `tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author ${author}\ncommitter ${author}\n\n${message || 'Update'}\n`);
  repo.refs.set(branch.startsWith('refs/') ? branch : `refs/heads/${branch}`, sha);
  return sha;
}
export function ancestors(repo, sha) {
  const seen = new Set(), queue = [sha];
  while (queue.length) {
    const next = queue.pop();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    queue.push(...(commitInfo(repo, next)?.parents || []));
  }
  return seen;
}
export function ancestor(repo, old, next) { return ancestors(repo, next).has(old); }
export function repoView(repo) {
  return { id: repo.id, node_id: repo.node_id, name: repo.name, full_name: `${viewer().login}/${repo.name}`, owner: viewer(), private: repo.private, description: repo.description, default_branch: repo.default_branch, has_issues: true, archived: false, fork: false, created_at: stamp, updated_at: stamp, clone_url: `/${viewer().login}/${repo.name}.git`, html_url: `/${viewer().login}/${repo.name}` };
}
export function createRepo(input) {
  if (typeof input.name !== 'string' || !/^[\w.-]+$/.test(input.name)) error(422, 'A valid repository name is required');
  if (repos.has(input.name)) error(422, 'Repository already exists');
  const repo = identify('Repository', { name: input.name, private: !!input.private, description: input.description || '', default_branch: input.default_branch || 'main', objects: new Map(), refs: new Map(), labels: new Map(), issues: new Map(), pulls: new Map(), nextNumber: 0 });
  repos.set(repo.name, repo);
  return repo;
}
export function getRepo(owner, name) {
  if (!repos.has(name) || !bindOwner(owner)) error(404, 'Not Found');
  return repos.get(name);
}
export function issueCreate(repo, input) {
  if (typeof input.title !== 'string' || !input.title) error(422, 'Title is required');
  const labels = (input.labels || []).map(label => {
    const found = repo.labels.get(typeof label === 'string' ? label : label.name);
    if (!found) error(422, 'Label does not exist');
    return found;
  });
  const issue = identify('Issue', { repo, number: ++repo.nextNumber, title: input.title, body: input.body || '', state: 'open', labels, user: viewer(), created_at: stamp, updated_at: stamp, comments: [] });
  repo.issues.set(issue.number, issue);
  return issue;
}
export function issueView(issue) {
  const { repo, comments, ...data } = issue;
  return { ...data, comments: comments.length, url: `/api/v3/repos/${viewer().login}/${repo.name}/issues/${issue.number}`, html_url: `/${viewer().login}/${repo.name}/issues/${issue.number}` };
}
export function listIssues(repo, input = {}) {
  const state = input.state || 'open';
  const list = [...repo.issues.values()].filter(x => state === 'all' || x.state === state);
  list.sort((a, b) => (input.direction === 'asc' ? 1 : -1) * (a.number - b.number));
  return list;
}
export function commentCreate(issue, body) {
  if (typeof body !== 'string') error(422, 'Body is required');
  const comment = identify('IssueComment', { body, user: viewer(), created_at: stamp, updated_at: stamp });
  issue.comments.push(comment);
  return comment;
}
export function pullCreate(repo, input) {
  const head = (input.head || '').split(':').at(-1), base = input.base || repo.default_branch;
  if (!input.title || !head || !resolve(repo, head) || !resolve(repo, base)) error(422, 'Title and valid head and base branches are required');
  const pull = identify('PullRequest', { repo, number: ++repo.nextNumber, title: input.title, body: input.body || '', head: { ref: head, sha: resolve(repo, head) }, base: { ref: base, sha: resolve(repo, base) }, state: 'open', merged: false, merged_at: null, merge_commit_sha: null, created_at: stamp, updated_at: stamp });
  repo.pulls.set(pull.number, pull);
  return pull;
}
export function pullView(pull) {
  const { repo, ...data } = pull;
  return { ...data, head: { ...pull.head, sha: resolve(repo, pull.head.ref), repo: repoView(repo) }, base: { ...pull.base, sha: resolve(repo, pull.base.ref), repo: repoView(repo) }, user: viewer(), mergeable: mergePlan(pull).conflicts.length === 0 };
}
export function mergePlan(pull) {
  const { repo } = pull;
  const headSha = resolve(repo, pull.head.ref), baseSha = resolve(repo, pull.base.ref);
  const baseAncestors = ancestors(repo, baseSha);
  const common = [...ancestors(repo, headSha)].find(sha => baseAncestors.has(sha));
  const original = filesAt(repo, common), head = filesAt(repo, headSha), base = filesAt(repo, baseSha);
  const files = new Map(base), conflicts = [];
  for (const path of new Set([...original.keys(), ...head.keys(), ...base.keys()])) {
    const a = original.get(path), h = head.get(path), b = base.get(path);
    const same = (left, right) => left?.sha === right?.sha && left?.mode === right?.mode;
    if (same(h, a)) continue;
    if (!same(b, a) && !same(h, b)) { conflicts.push(path); continue; }
    if (h) files.set(path, h); else files.delete(path);
  }
  return { files, conflicts, headSha, baseSha };
}
export function mergePull(pull, input = {}) {
  if (pull.merged) return { sha: pull.merge_commit_sha, merged: true, message: 'Already merged' };
  const plan = mergePlan(pull);
  if (plan.conflicts.length) error(405, 'Pull request has conflicts');
  const sha = makeCommit(pull.repo, pull.base.ref, plan.files, input.commit_title || pull.title, [plan.baseSha]);
  Object.assign(pull, { merged: true, state: 'closed', merged_at: stamp, merge_commit_sha: sha });
  return { sha, merged: true, message: 'Pull request successfully merged' };
}
export function pullFiles(pull) {
  const { repo } = pull;
  const a = filesAt(repo, pull.base.sha), b = filesAt(repo, resolve(repo, pull.head.ref));
  const out = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (a.get(path)?.sha === b.get(path)?.sha) continue;
    const count = item => item ? repo.objects.get(item.sha).data.toString().split('\n').filter(Boolean).length : 0;
    out.push({ filename: path, status: !a.has(path) ? 'added' : !b.has(path) ? 'removed' : 'modified', additions: count(b.get(path)), deletions: count(a.get(path)), changes: count(a.get(path)) + count(b.get(path)), sha: b.get(path)?.sha || a.get(path).sha });
  }
  return out;
}
export function contents(repo, path, ref) {
  const files = filesAt(repo, ref);
  const entry = files.get(path);
  if (entry) {
    const data = repo.objects.get(entry.sha)?.data || Buffer.alloc(0);
    return { type: 'file', name: path.split('/').at(-1), path, sha: entry.sha, size: data.length, encoding: 'base64', content: data.toString('base64') };
  }
  const prefix = path ? path.replace(/\/$/, '') + '/' : '';
  const children = new Map();
  for (const [name, item] of files) if (name.startsWith(prefix)) {
    const tail = name.slice(prefix.length), direct = tail.split('/')[0];
    children.set(direct, { name: direct, path: prefix + direct, type: tail.includes('/') ? 'dir' : 'file', sha: item.sha, size: tail.includes('/') ? 0 : repo.objects.get(item.sha)?.data.length || 0 });
  }
  if (!children.size) error(404, 'Not Found');
  return [...children.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function editContents(repo, path, input, remove = false) {
  if (!path || path.split('/').some(p => !p || p === '.' || p === '..')) error(422, 'Invalid path');
  const branch = input.branch || repo.default_branch, files = filesAt(repo, branch), old = files.get(path);
  if (remove && !old) error(404, 'Not Found');
  if (old && old.sha !== input.sha) error(409, 'SHA does not match');
  if (!old && input.sha) error(409, 'SHA does not match');
  if (remove) files.delete(path);
  else {
    if (typeof input.content !== 'string') error(422, 'Content is required');
    files.set(path, { sha: object(repo, 'blob', Buffer.from(input.content, 'base64')), mode: old?.mode || '100644' });
  }
  const sha = makeCommit(repo, branch, files, input.message);
  return { created: !old, content: remove ? null : contents(repo, path, branch), commit: { sha, message: input.message || 'Update' } };
}
