import { repos, nodes, viewer, bindOwner, resolve, issueCreate, commentCreate, pullCreate, pullFiles, mergePull, mergePlan } from './store.ts';

// Parse GraphQL selections, arguments, variables, aliases and fragments without evaluating code.
function parse(query, variables) {
  const tokens = query.match(/\.\.\.|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|[_A-Za-z][_0-9A-Za-z]*|[^\s,]/g) || [];
  let i = 0;
  const fragments = new Map(), operations = [];
  const take = expected => {
    const token = tokens[i++];
    if (expected && token !== expected) throw new Error(`Expected ${expected}, found ${token}`);
    return token;
  };
  function value() {
    const token = take();
    if (token === '$') return variables[take()];
    if (token === '[') { const out = []; while (tokens[i] !== ']') out.push(value()); take(']'); return out; }
    if (token === '{') {
      const out = {};
      while (tokens[i] !== '}') { const key = take(); take(':'); out[key] = value(); }
      take('}'); return out;
    }
    if (token?.startsWith('"')) return JSON.parse(token);
    if (token === 'true' || token === 'false') return token === 'true';
    if (token === 'null') return null;
    if (/^-?\d/.test(token || '')) return Number(token);
    if (!token) throw new Error('Unexpected end of GraphQL document');
    return token;
  }
  function args() {
    const out = {};
    if (tokens[i] !== '(') return out;
    take('(');
    while (tokens[i] !== ')') { const key = take(); take(':'); out[key] = value(); }
    take(')'); return out;
  }
  function selection() {
    take('{');
    const fields = [];
    while (tokens[i] !== '}') {
      if (!tokens[i]) throw new Error('Unclosed selection set');
      if (tokens[i] === '...') {
        take(); const name = take();
        fields.push(name === 'on' ? { condition: take(), selection: selection() } : { fragment: name });
        continue;
      }
      const first = take();
      const name = tokens[i] === ':' ? (take(':'), take()) : first;
      const field = { alias: first, name, args: args(), selection: null, omit: false };
      while (tokens[i] === '@') {
        take(); const directive = take(), input = args();
        if (directive === 'skip' && input.if === true || directive === 'include' && input.if === false) field.omit = true;
      }
      if (tokens[i] === '{') field.selection = selection();
      fields.push(field);
    }
    take('}'); return fields;
  }
  while (i < tokens.length) {
    if (tokens[i] === '#') { throw new Error('Comments must be removed before parsing'); }
    if (tokens[i] === 'fragment') { take(); const name = take(); take('on'); const condition = take(); fragments.set(name, { condition, selection: selection() }); continue; }
    let name = null, kind = 'query';
    if (tokens[i] !== '{') {
      kind = take();
      if (!['query', 'mutation'].includes(kind)) throw new Error(`Unknown operation ${kind}`);
      if (tokens[i] !== '(' && tokens[i] !== '{') name = take();
      if (tokens[i] === '(') {
        let level = 0;
        do { const token = take(); if (token === '(') ++level; if (token === ')') --level; if (!token) throw new Error('Unclosed variable definitions'); } while (level);
      }
    }
    operations.push({ name, kind, selection: selection() });
  }
  return { fragments, operations };
}
const wrap = (type, data) => data ? { _type: type, _value: data } : null;
function connection(items, args = {}) {
  const decoded = args.after ? Number(Buffer.from(args.after, 'base64').toString()) : 0;
  const offset = Number.isInteger(decoded) && decoded >= 0 ? decoded : 0;
  const count = Math.max(0, Math.min(100, args.first ?? 30));
  const list = items.slice(offset, offset + count);
  const cursor = index => Buffer.from(String(index)).toString('base64');
  return { _type: 'Connection', nodes: list, totalCount: items.length, edges: list.map((node, index) => ({ _type: 'Edge', node, cursor: cursor(offset + index + 1) })), pageInfo: { _type: 'PageInfo', hasNextPage: offset + list.length < items.length, hasPreviousPage: offset > 0, endCursor: list.length ? cursor(offset + list.length) : null, startCursor: list.length ? cursor(offset + 1) : null } };
}
const schema = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['id', 'login'],
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
function byId(id, kind) {
  const node = nodes.get(id);
  if (!node || kind && node.kind !== kind) throw new Error('Unknown node id');
  return node.value;
}
function field(source, name, args) {
  const type = source._type, item = source._value;
  if (name === '__typename') return type;
  if (type === 'Query') {
    if (name === 'viewer') return wrap('User', viewer());
    if (name === 'repository') return repos.has(args.name) && bindOwner(args.owner) ? wrap('Repository', repos.get(args.name)) : null;
    if (name === 'node') { const node = nodes.get(args.id); return node ? wrap(node.kind, node.value) : null; }
    if (name === '__type') {
      if (args.name === 'SearchType') return { _type: '__Type', name: args.name, kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'].map(name => ({ _type: '__EnumValue', name })) };
      if (schema[args.name]) return { _type: '__Type', name: args.name, kind: 'OBJECT', fields: schema[args.name].map(name => ({ _type: '__Field', name })) };
      return null;
    }
  }
  if (type === 'Mutation') {
    const input = args.input || {};
    if (name === 'createIssue') return { _type: 'CreateIssuePayload', issue: wrap('Issue', issueCreate(byId(input.repositoryId, 'Repository'), input)) };
    if (name === 'closeIssue') {
      const issue = byId(input.issueId, 'Issue'); issue.state = 'closed';
      return { _type: 'CloseIssuePayload', issue: wrap('Issue', issue) };
    }
    if (name === 'createPullRequest') return { _type: 'CreatePullRequestPayload', pullRequest: wrap('PullRequest', pullCreate(byId(input.repositoryId, 'Repository'), { ...input, head: input.headRefName, base: input.baseRefName })) };
    if (name === 'mergePullRequest') {
      const pull = byId(input.pullRequestId, 'PullRequest'); mergePull(pull, { commit_title: input.commitHeadline });
      return { _type: 'MergePullRequestPayload', pullRequest: wrap('PullRequest', pull) };
    }
    if (name === 'addComment') return { _type: 'AddCommentPayload', commentEdge: { _type: 'Edge', node: wrap('IssueComment', commentCreate(byId(input.subjectId), input.body)) } };
  }
  if (type === 'User') {
    if (name === 'login') return viewer().login;
    if (name === 'id') return Buffer.from('User:1').toString('base64');
  }
  if (type === 'Repository') {
    if (name === 'id') return item.node_id;
    if (name === 'databaseId') return item.id;
    if (name === 'name') return item.name;
    if (name === 'nameWithOwner') return `${viewer().login}/${item.name}`;
    if (name === 'owner') return wrap('User', viewer());
    if (name === 'defaultBranchRef') return { _type: 'Ref', name: item.default_branch, target: { _type: 'Commit', oid: resolve(item, item.default_branch) } };
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'issue') return wrap('Issue', item.issues.get(Number(args.number)));
    if (name === 'pullRequest') return wrap('PullRequest', item.pulls.get(Number(args.number)));
    if (name === 'issues' || name === 'pullRequests') {
      const kind = name === 'issues' ? 'Issue' : 'PullRequest';
      let list = [...(name === 'issues' ? item.issues : item.pulls).values()];
      if (args.states?.length) list = list.filter(x => args.states.includes(x.merged ? 'MERGED' : x.state.toUpperCase()));
      list.sort((a, b) => (args.orderBy?.direction === 'ASC' ? 1 : -1) * (a.number - b.number));
      return connection(list.map(x => wrap(kind, x)), args);
    }
  }
  if (type === 'Issue' || type === 'PullRequest' || type === 'IssueComment') {
    if (name === 'id') return item.node_id;
    if (['number', 'title', 'body'].includes(name)) return item[name];
    if (name === 'state') return item.merged ? 'MERGED' : item.state.toUpperCase();
    if (name === 'url') return `/${viewer().login}/${item.repo?.name}/issues/${item.number}`;
    if (name === 'comments') return connection(item.comments.map(x => wrap('IssueComment', x)), args);
    if (type === 'PullRequest') {
      if (name === 'headRefName') return item.head.ref;
      if (name === 'baseRefName') return item.base.ref;
      if (name === 'merged') return item.merged;
      if (name === 'mergeable') return mergePlan(item).conflicts.length ? 'CONFLICTING' : 'MERGEABLE';
      if (name === 'files') return connection(pullFiles(item).map(x => ({ _type: 'PullRequestChangedFile', path: x.filename, additions: x.additions, deletions: x.deletions })), args);
    }
  }
  if (Object.hasOwn(source, name) && !name.startsWith('_')) return source[name];
  throw new Error(`Cannot query field "${name}" on type "${type}"`);
}
export function graphql(body) {
  try {
    if (typeof body.query !== 'string') throw new Error('Query is required');
    // A hash starts a comment only outside a quoted GraphQL string.
    const query = body.query.replace(/"(?:\\.|[^"\\])*"|#[^\n]*/g, part => part.startsWith('#') ? '' : part);
    const document = parse(query, body.variables || {});
    const operation = body.operationName ? document.operations.find(op => op.name === body.operationName) : document.operations[0];
    if (!operation) throw new Error('Operation not found');
    const errors = [];
    function execute(source, selections) {
      if (source === null || source === undefined) return null;
      if (Array.isArray(source)) return source.map(item => execute(item, selections));
      const result = {};
      for (const selection of selections || []) {
        if (selection.omit) continue;
        if (selection.fragment || selection.condition) {
          const fragment = selection.fragment ? document.fragments.get(selection.fragment) : selection;
          if (!fragment) throw new Error('Unknown fragment');
          if (!fragment.condition || fragment.condition === source._type) Object.assign(result, execute(source, fragment.selection));
          continue;
        }
        try {
          const value = field(source, selection.name, selection.args);
          result[selection.alias] = selection.selection ? execute(value, selection.selection) : value;
        } catch (err) { errors.push({ message: err.message }); result[selection.alias] = null; }
      }
      return result;
    }
    const data = execute({ _type: operation.kind === 'mutation' ? 'Mutation' : 'Query' }, operation.selection);
    return errors.length ? { data, errors } : { data };
  } catch (err) { return { errors: [{ message: err.message }] }; }
}
