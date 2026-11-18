import { createServer } from 'node:http';
import { repos, viewer, bindOwner, createRepo, getRepo, repoView, resolve, commitInfo, editContents, contents, issueCreate, issueView, listIssues, commentCreate, pullCreate, pullView, pullFiles, mergePull, error, stamp } from './store.ts';
import { serveGit } from './git.ts';
import { graphql } from './graphql.ts';

function json(res, status, body, headers = {}) {
  const text = status === 204 ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
function page(items, url, res) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 30));
  const number = Math.max(1, Number(url.searchParams.get('page')) || 1);
  if (number * limit < items.length) {
    const next = new URL(url); next.searchParams.set('page', String(number + 1));
    res.setHeader('link', `<${next}>; rel="next"`);
  }
  return items.slice((number - 1) * limit, number * limit);
}
function required(value) { if (!value) error(404, 'Not Found'); return value; }
function rest(method, url, body, res) {
  const path = url.pathname.replace(/^\/api\/v3\/?/, '').replace(/\/$/, '');
  const parts = path.split('/').map(decodeURIComponent);
  const query = Object.fromEntries(url.searchParams);
  if (method === 'GET' && !path) return [200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' }];
  if (method === 'GET' && path === 'meta') return [200, { installed_version: 'SmallForge/1.0' }];
  if (method === 'GET' && path === 'user') return [200, viewer()];
  if (path === 'user/repos') {
    if (method === 'POST') return [201, repoView(createRepo(body))];
    if (method === 'GET') return [200, page([...repos.values()].map(repoView), url, res)];
  }
  if (parts[0] !== 'repos' || !parts[1] || !parts[2]) error(404, 'Not Found');
  const repo = getRepo(parts[1], parts[2]);
  const tail = parts.slice(3), [section, number, action] = tail;
  if (!section) {
    if (method === 'GET') return [200, repoView(repo)];
    if (method === 'PATCH') {
      for (const key of ['description', 'default_branch', 'private']) if (key in body) repo[key] = body[key];
      return [200, repoView(repo)];
    }
    if (method === 'DELETE') { repos.delete(repo.name); return [204, null]; }
  }
  if (section === 'git') {
    if (number === 'refs' && method === 'POST') {
      if (typeof body.ref !== 'string' || !body.ref.startsWith('refs/') || !repo.objects.has(body.sha)) error(422, 'Invalid reference');
      if (repo.refs.has(body.ref)) error(422, 'Reference already exists');
      repo.refs.set(body.ref, body.sha);
      return [201, { ref: body.ref, object: { sha: body.sha, type: repo.objects.get(body.sha).type } }];
    }
    if (['ref', 'refs'].includes(number)) {
      const ref = 'refs/' + tail.slice(2).join('/');
      if (method === 'GET') return [200, { ref, object: { sha: required(repo.refs.get(ref)), type: 'commit' } }];
      if (method === 'DELETE') { required(repo.refs.get(ref)); repo.refs.delete(ref); return [204, null]; }
    }
  }
  if (section === 'branches' && method === 'GET') {
    const branches = [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha }, protected: false }));
    return [200, number ? required(branches.find(b => b.name === tail.slice(1).join('/'))) : page(branches, url, res)];
  }
  if (section === 'commits' && method === 'GET') {
    const tip = resolve(repo, number || query.sha), result = [], seen = new Set(), queue = [tip];
    for (let i = 0; i < queue.length; ++i) {
      const commit = commitInfo(repo, queue[i]);
      if (!commit || seen.has(commit.sha)) continue;
      seen.add(commit.sha);
      result.push({ sha: commit.sha, commit: { message: commit.message, tree: { sha: commit.tree }, author: { name: viewer().login, date: stamp } }, parents: commit.parents.map(sha => ({ sha })) });
      queue.push(...commit.parents);
    }
    if (number) return [200, required(result[0])];
    return [200, page(result, url, res)];
  }
  if (section === 'contents') {
    const file = tail.slice(1).join('/');
    if (method === 'GET') return [200, contents(repo, file, query.ref)];
    if (method === 'PUT' || method === 'DELETE') {
      const result = editContents(repo, file, body, method === 'DELETE');
      return [method === 'PUT' && result.created ? 201 : 200, { content: result.content, commit: result.commit }];
    }
  }
  if (section === 'labels') {
    if (method === 'GET') return [200, [...repo.labels.values()]];
    if (method === 'POST' && typeof body.name === 'string') {
      const label = { name: body.name, color: body.color || 'ededed', description: body.description || '', default: false };
      repo.labels.set(body.name, label); return [201, label];
    }
  }
  if (section === 'issues') {
    if (!number) {
      if (method === 'POST') return [201, issueView(issueCreate(repo, body))];
      if (method === 'GET') return [200, page(listIssues(repo, query).map(issueView), url, res)];
    } else {
      const issue = required(repo.issues.get(Number(number)));
      if (!action) {
        if (method === 'GET') return [200, issueView(issue)];
        if (method === 'PATCH') {
          if (body.state && !['open', 'closed'].includes(body.state)) error(422, 'Invalid state');
          for (const key of ['state', 'title', 'body']) if (key in body) issue[key] = body[key];
          issue.closed_at = issue.state === 'closed' ? stamp : null;
          return [200, issueView(issue)];
        }
      }
      if (action === 'comments') {
        if (method === 'POST') return [201, commentCreate(issue, body.body)];
        if (method === 'GET') return [200, page(issue.comments, url, res)];
      }
    }
  }
  if (section === 'pulls') {
    if (!number) {
      if (method === 'POST') return [201, pullView(pullCreate(repo, body))];
      if (method === 'GET') return [200, page([...repo.pulls.values()].filter(p => query.state === 'all' || p.state === (query.state || 'open')).map(pullView), url, res)];
    } else {
      const pull = required(repo.pulls.get(Number(number)));
      if (!action && method === 'GET') return [200, pullView(pull)];
      if (action === 'files' && method === 'GET') return [200, page(pullFiles(pull), url, res)];
      if (action === 'merge' && method === 'PUT') return [200, mergePull(pull, body)];
    }
  }
  error(404, 'Not Found');
}

const string = { type: 'string' }, integer = { type: 'integer' };
const specs = [
  ['create_repo', 'Create a repository owned by the authenticated user.', { name: string, description: string, private: { type: 'boolean' } }, ['name']],
  ['get_repo', 'Read a repository and its stable identifier.', { owner: string, repo: string }, ['owner', 'repo']],
  ['create_issue', 'Create an issue in a repository.', { owner: string, repo: string, title: string, body: string }, ['owner', 'repo', 'title']],
  ['list_issues', 'List repository issues, filtered by state.', { owner: string, repo: string, state: string }, ['owner', 'repo']],
  ['create_pull_request', 'Open a pull request between existing branches.', { owner: string, repo: string, title: string, body: string, head: string, base: string }, ['owner', 'repo', 'title', 'head', 'base']],
  ['merge_pull_request', 'Squash merge a pull request without conflicts.', { owner: string, repo: string, pull_number: integer }, ['owner', 'repo', 'pull_number']],
];
const tools = specs.map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required } }));
function rpc(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  const reply = value => ({ jsonrpc: '2.0', id: message.id, result: value });
  const failure = (code, text) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  if (message.id === undefined) return null;
  const params = message.params || {};
  if (message.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28', '2025-11-25', '2025-03-26', '2024-11-05'], serverInfo: { name: 'SmallForge', version: '1.0.0' }, capabilities: { tools: { listChanged: false } } });
  if (message.method === 'initialize') return reply({ protocolVersion: params.protocolVersion || '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'SmallForge', version: '1.0.0' } });
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools });
  if (message.method !== 'tools/call') return failure(-32601, 'Method not found');
  const tool = tools.find(t => t.name === params.name);
  if (!tool) return failure(-32602, 'Unknown tool');
  const args = params.arguments || {};
  if (tool.inputSchema.required.some(key => args[key] === undefined || args[key] === null || args[key] === '')) return failure(-32602, 'Missing required argument');
  try {
    let result;
    if (tool.name === 'create_repo') result = repoView(createRepo(args));
    else {
      const repo = getRepo(args.owner, args.repo);
      if (tool.name === 'get_repo') result = repoView(repo);
      if (tool.name === 'create_issue') result = issueView(issueCreate(repo, args));
      if (tool.name === 'list_issues') result = listIssues(repo, args).map(issueView);
      if (tool.name === 'create_pull_request') result = pullView(pullCreate(repo, args));
      if (tool.name === 'merge_pull_request') result = mergePull(required(repo.pulls.get(Number(args.pull_number))));
    }
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
  } catch (err) { return reply({ content: [{ type: 'text', text: err.message }], isError: true }); }
}

export function createApp() {
  return createServer(async (req, res) => {
    res.setHeader('x-github-request-id', 'SmallForge');
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true });
      if (!process.env.MAKEFUN_SHOP_TOKEN || req.headers.authorization !== `Bearer ${process.env.MAKEFUN_SHOP_TOKEN}`) return json(res, 401, { message: 'Bad credentials' });
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 64 * 1024 * 1024) error(413, 'Request too large');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      const gitPath = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(url.pathname);
      if (gitPath) return serveGit(getRepo(decodeURIComponent(gitPath[1]), decodeURIComponent(gitPath[2])), req, res, url, raw);
      if (url.pathname === '/mcp' && req.method === 'DELETE') return json(res, 204, null);
      if (url.pathname === '/mcp' && req.method === 'GET') return json(res, 405, { message: 'Use POST' });
      let body = {};
      if (raw.length) {
        try { body = JSON.parse(raw.toString()); }
        catch {
          if (url.pathname === '/mcp') return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          error(400, 'Malformed JSON');
        }
      }
      if (url.pathname === '/mcp' && req.method === 'POST') {
        const result = Array.isArray(body) ? body.map(rpc).filter(Boolean) : rpc(body);
        return json(res, result === null ? 202 : 200, result);
      }
      if (url.pathname === '/api/graphql' && req.method === 'POST') return json(res, 200, Array.isArray(body) ? body.map(graphql) : graphql(body));
      if (url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/')) {
        const [status, data, headers] = rest(req.method, url, body, res);
        return json(res, status, data, headers);
      }
      error(404, 'Not Found');
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, { message: err.message });
      else res.end();
    }
  });
}
