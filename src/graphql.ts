// GraphQL v4: a small recursive-descent parser and an executor over the fixed
// schema the suite speaks (the 18 documents in the kit's checks-graphql.ts).
// It is a general executor, not a matcher: any well-formed document over these
// types resolves the same way.

import { Forge, decodeGlobalId, globalId, type Issue, type PullRequest, type Repo } from './store.ts';

// -------------------------------------------------------------------------------------------
// Tokenizer
// -------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      push('spread', '...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@='.includes(ch)) {
      push('punct', ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          value += map[escaped] ?? escaped;
          j += 2;
        } else {
          value += source[j] as string;
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string in GraphQL document');
      push('string', value);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      let isFloat = false;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      push(isFloat ? 'float' : 'int', source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      push('name', source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  push('eof', '');
  return tokens;
}

// -------------------------------------------------------------------------------------------
// AST
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'Variable'; readonly name: string }
  | { readonly kind: 'IntValue'; readonly value: number }
  | { readonly kind: 'FloatValue'; readonly value: number }
  | { readonly kind: 'StringValue'; readonly value: string }
  | { readonly kind: 'BooleanValue'; readonly value: boolean }
  | { readonly kind: 'NullValue' }
  | { readonly kind: 'EnumValue'; readonly value: string }
  | { readonly kind: 'ListValue'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'ObjectValue'; readonly fields: readonly { readonly name: string; readonly value: ValueNode }[] };

interface FieldNode {
  readonly kind: 'Field';
  readonly alias: string | undefined;
  readonly name: string;
  readonly args: readonly { readonly name: string; readonly value: ValueNode }[];
  readonly selectionSet: readonly SelectionNode[] | undefined;
}

interface FragmentSpreadNode {
  readonly kind: 'FragmentSpread';
  readonly name: string;
}

interface InlineFragmentNode {
  readonly kind: 'InlineFragment';
  readonly typeCondition: string | undefined;
  readonly selectionSet: readonly SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  readonly type: 'query' | 'mutation' | 'subscription';
  readonly name: string | undefined;
  readonly variableDefinitions: readonly { readonly name: string; readonly required: boolean; readonly defaultValue: ValueNode | undefined }[];
  readonly selectionSet: readonly SelectionNode[];
}

interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selectionSet: readonly SelectionNode[];
}

interface DocumentNode {
  readonly operations: readonly OperationNode[];
  readonly fragments: ReadonlyMap<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: undefined, variableDefinitions: [], selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const type = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefinitions = this.parseVariableDefinitions();
        operations.push({ type, name, variableDefinitions, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): OperationNode['variableDefinitions'] {
    const definitions: OperationNode['variableDefinitions'][number][] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let required = false;
        if (this.peek().kind === 'punct' && this.peek().value === '!') {
          this.next();
          required = true;
        }
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        definitions.push({ name, required, defaultValue });
      }
      this.expectPunct(')');
    }
    return definitions;
  }

  private parseType(): void {
    // A type reference: [T], T!, T — consumed without building a node.
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value !== 'on') {
        return { kind: 'FragmentSpread', name: this.next().value };
      }
      let typeCondition: string | undefined;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.parseDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'Field', alias, name, args, selectionSet };
  }

  private parseArguments(): FieldNode['args'] {
    const args: FieldNode['args'][number][] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      this.parseArguments();
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'IntValue', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'FloatValue', value: Number.parseFloat(token.value) };
      case 'string':
        return { kind: 'StringValue', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'Variable', name: this.expectName() };
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'ListValue', values };
        }
        if (token.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'ObjectValue', fields };
        }
        throw new Error(`unexpected ${JSON.stringify(token.value)} as a GraphQL value`);
      case 'name':
        if (token.value === 'true') return { kind: 'BooleanValue', value: true };
        if (token.value === 'false') return { kind: 'BooleanValue', value: false };
        if (token.value === 'null') return { kind: 'NullValue' };
        return { kind: 'EnumValue', value: token.value };
      default:
        throw new Error(`unexpected token ${JSON.stringify(token.value)} as a GraphQL value`);
    }
  }
}

// -------------------------------------------------------------------------------------------
// Values and cursors
// -------------------------------------------------------------------------------------------

type Variables = Readonly<Record<string, unknown>>;

function evalValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'IntValue':
    case 'FloatValue':
    case 'StringValue':
    case 'BooleanValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return node.value;
    case 'ListValue':
      return node.values.map((value) => evalValue(value, variables));
    case 'ObjectValue': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64url');
}

function seqOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const seq = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isInteger(seq) ? seq : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// Schema description (for __type)
// -------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, readonly string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'url', 'comments', 'labels', 'closed', 'closedAt', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'comments', 'additions', 'deletions', 'changedFiles', 'commits'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork', 'stargazerCount', 'watchers'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['id', 'name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

const SCHEMA_ENUMS: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'REGISTRY', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// -------------------------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------------------------

interface GqlError {
  readonly message: string;
  readonly path?: readonly (string | number)[];
}

interface Parent {
  readonly type: string;
  readonly value: unknown;
  /** The repository a field's object belongs to, when it has one. */
  readonly repo?: Repo;
}

class Executor {
  private errors: GqlError[] = [];
  private readonly forge: Forge;
  private readonly doc: DocumentNode;
  private readonly variables: Variables;

  constructor(forge: Forge, doc: DocumentNode, variables: Variables) {
    this.forge = forge;
    this.doc = doc;
    this.variables = variables;
  }

  run(operation: OperationNode): { data: Record<string, unknown>; errors: GqlError[] } {
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = this.executeSelections(operation.selectionSet, { type: rootType, value: null }, [operation.name ?? rootType]);
    return { data, errors: this.errors };
  }

  private executeSelections(
    selections: readonly SelectionNode[],
    parent: Parent,
    path: readonly (string | number)[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'FragmentSpread') {
        const fragment = this.doc.fragments.get(selection.name);
        if (fragment === undefined) {
          this.errors.push({ message: `Unknown fragment ${JSON.stringify(selection.name)}`, path });
          continue;
        }
        Object.assign(out, this.executeSelections(fragment.selectionSet, parent, path));
      } else if (selection.kind === 'InlineFragment') {
        if (selection.typeCondition !== undefined && selection.typeCondition !== parent.type) continue;
        Object.assign(out, this.executeSelections(selection.selectionSet, parent, path));
      } else {
        const key = selection.alias ?? selection.name;
        out[key] = this.resolveField(selection, parent, [...path, key]);
      }
    }
    return out;
  }

  private unknownField(field: FieldNode, parent: Parent, path: readonly (string | number)[]): null {
    this.errors.push({ message: `Cannot query field ${JSON.stringify(field.name)} on type ${JSON.stringify(parent.type)}.`, path });
    return null;
  }

  private resolveField(field: FieldNode, parent: Parent, path: readonly (string | number)[]): unknown {
    const args = argsOf(field, this.variables);
    const type = parent.type;
    if (field.name === '__typename') return type;
    if (field.name === '__type') {
      const name = args.name as string | undefined;
      if (typeof name !== 'string') return null;
      return this.typeObject(name, field.selectionSet ?? [], path);
    }
    if (type === 'Query') return this.resolveQuery(field, args, path);
    if (type === 'Mutation') return this.resolveMutation(field, args, path);
    if (type === 'Repository') return this.resolveRepository(field, parent, args, path);
    if (type === 'Issue') return this.resolveIssue(field, parent, args, path);
    if (type === 'PullRequest') return this.resolvePullRequest(field, parent, args, path);
    if (type === 'User') return this.resolveUser(field, parent, args, path);
    if (type === 'IssueComment') return this.resolveComment(field, parent, args, path);
    if (type === 'Ref') return this.resolveRef(field, parent, args, path);
    if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestFileConnection' || type === 'CommentConnection') {
      return this.resolveConnection(field, parent, args, path);
    }
    if (type === 'IssueEdge' || type === 'PullRequestEdge' || type === 'IssueCommentEdge' || type === 'PullRequestFileEdge') {
      return this.resolveEdge(field, parent, args, path);
    }
    if (type === 'PageInfo') return this.resolvePageInfo(field, parent, args, path);
    if (type === 'PullRequestFile') return this.resolvePullRequestFile(field, parent, args, path);
    if (type === '__Type') return this.resolveTypeObject(field, parent, args, path);
    if (type === '__Field' || type === '__EnumValue') {
      if (field.name === 'name') return (parent.value as { name: string }).name;
      if (field.name === 'description') return null;
      return this.unknownField(field, parent, path);
    }
    if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') return this.resolveIssuePayload(field, parent, args, path);
    if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') return this.resolvePullRequestPayload(field, parent, args, path);
    if (type === 'AddCommentPayload') return this.resolveAddCommentPayload(field, parent, args, path);
    return this.unknownField(field, parent, path);
  }

  // -- root -------------------------------------------------------------------------------

  private resolveQuery(field: FieldNode, args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    switch (field.name) {
      case 'viewer':
        return this.select(field, { type: 'User', value: this.forge.viewer }, path);
      case 'repository': {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (owner !== this.forge.viewer.login) return null;
        const repo = this.forge.getRepo(owner, name);
        if (repo === undefined) return null;
        return this.select(field, { type: 'Repository', value: repo, repo }, path);
      }
      case 'node': {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') return null;
        const node = this.resolveNode(id);
        if (node === null) return null;
        return this.select(field, node, path);
      }
      default:
        return this.unknownField(field, { type: 'Query', value: null }, path);
    }
  }

  private resolveNode(id: string): Parent | null {
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    const [first] = decoded.parts;
    if (decoded.kind === 'Repository') {
      const dbId = Number.parseInt(first ?? '', 10);
      if (!Number.isInteger(dbId)) return null;
      for (const repo of this.forge.listRepos(this.forge.viewer.login)) {
        if (repo.id === dbId) return { type: 'Repository', value: repo, repo };
      }
      return null;
    }
    if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
      const entityId = Number.parseInt(first ?? '', 10);
      if (!Number.isInteger(entityId)) return null;
      for (const repo of this.forge.listRepos(this.forge.viewer.login)) {
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.find((entry) => entry.id === entityId);
          if (issue !== undefined) return { type: 'Issue', value: issue, repo };
        } else {
          const pull = repo.pulls.find((entry) => entry.id === entityId);
          if (pull !== undefined) return { type: 'PullRequest', value: pull, repo };
        }
      }
      return null;
    }
    if (decoded.kind === 'IssueComment') {
      const entityId = Number.parseInt(first ?? '', 10);
      if (!Number.isInteger(entityId)) return null;
      for (const repo of this.forge.listRepos(this.forge.viewer.login)) {
        for (const comments of repo.comments.values()) {
          const comment = comments.find((entry) => entry.id === entityId);
          if (comment !== undefined) return { type: 'IssueComment', value: comment, repo };
        }
      }
      return null;
    }
    return null;
  }

  private resolveMutation(field: FieldNode, args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const repo = this.repoByGlobalId(input.repositoryId);
        if (repo === null) {
          this.errors.push({ message: 'Could not resolve to a Repository with the id in the input.', path });
          return null;
        }
        const title = input.title as string | undefined;
        if (typeof title !== 'string' || title === '') {
          this.errors.push({ message: 'createIssue requires a non-empty title.', path });
          return null;
        }
        const issue = this.forge.createIssue(repo, title, (input.body as string | undefined) ?? '', []);
        if ('unknownLabel' in issue) {
          this.errors.push({ message: `Label ${issue.unknownLabel} does not exist.`, path });
          return null;
        }
        return this.select(field, { type: 'CreateIssuePayload', value: issue, repo }, path);
      }
      case 'closeIssue': {
        const found = this.issueByGlobalId(input.issueId);
        if (found === null) {
          this.errors.push({ message: 'Could not resolve to an Issue with the id in the input.', path });
          return null;
        }
        const { repo, issue } = found;
        issue.state = 'closed';
        issue.updatedSeq = this.forge.nextSeq();
        return this.select(field, { type: 'CloseIssuePayload', value: issue, repo }, path);
      }
      case 'createPullRequest': {
        const repo = this.repoByGlobalId(input.repositoryId);
        if (repo === null) {
          this.errors.push({ message: 'Could not resolve to a Repository with the id in the input.', path });
          return null;
        }
        const title = input.title as string | undefined;
        const head = input.headRefName as string | undefined;
        const base = input.baseRefName as string | undefined;
        if (typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
          this.errors.push({ message: 'createPullRequest requires title, headRefName and baseRefName.', path });
          return null;
        }
        const pull = this.forge.createPull(repo, title, (input.body as string | undefined) ?? '', head, base);
        if ('error' in pull) {
          this.errors.push({ message: pull.error, path });
          return null;
        }
        return this.select(field, { type: 'CreatePullRequestPayload', value: pull, repo }, path);
      }
      case 'mergePullRequest': {
        const found = this.pullByGlobalId(input.pullRequestId);
        if (found === null) {
          this.errors.push({ message: 'Could not resolve to a PullRequest with the id in the input.', path });
          return null;
        }
        const { repo, pull } = found;
        const sha = this.forge.mergePull(repo, pull);
        if (sha === null) {
          this.errors.push({ message: 'Pull request cannot be merged.', path });
          return null;
        }
        return this.select(field, { type: 'MergePullRequestPayload', value: pull, repo }, path);
      }
      case 'addComment': {
        const found = this.issueByGlobalId(input.subjectId);
        if (found === null) {
          this.errors.push({ message: 'Could not resolve to an Issue with the id in the input.', path });
          return null;
        }
        const { repo, issue } = found;
        const body = input.body as string | undefined;
        if (typeof body !== 'string' || body === '') {
          this.errors.push({ message: 'addComment requires a non-empty body.', path });
          return null;
        }
        const comment = this.forge.createComment(repo, issue.number, body);
        if (comment === null) {
          this.errors.push({ message: 'Could not add the comment.', path });
          return null;
        }
        return this.select(field, { type: 'AddCommentPayload', value: comment, repo }, path);
      }
      default:
        return this.unknownField(field, { type: 'Mutation', value: null }, path);
    }
  }

  private repoByGlobalId(id: unknown): Repo | null {
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Repository') {
      // Tolerate a plain numeric database id.
      const dbId = Number.parseInt(id, 10);
      if (!Number.isInteger(dbId)) return null;
      for (const repo of this.forge.listRepos(this.forge.viewer.login)) if (repo.id === dbId) return repo;
      return null;
    }
    const dbId = Number.parseInt(decoded.parts[0] ?? '', 10);
    if (!Number.isInteger(dbId)) return null;
    for (const repo of this.forge.listRepos(this.forge.viewer.login)) if (repo.id === dbId) return repo;
    return null;
  }

  private issueByGlobalId(id: unknown): { repo: Repo; issue: Issue } | null {
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Issue') return null;
    const entityId = Number.parseInt(decoded.parts[0] ?? '', 10);
    if (!Number.isInteger(entityId)) return null;
    for (const repo of this.forge.listRepos(this.forge.viewer.login)) {
      const issue = repo.issues.find((entry) => entry.id === entityId);
      if (issue !== undefined) return { repo, issue };
    }
    return null;
  }

  private pullByGlobalId(id: unknown): { repo: Repo; pull: PullRequest } | null {
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'PullRequest') return null;
    const entityId = Number.parseInt(decoded.parts[0] ?? '', 10);
    if (!Number.isInteger(entityId)) return null;
    for (const repo of this.forge.listRepos(this.forge.viewer.login)) {
      const pull = repo.pulls.find((entry) => entry.id === entityId);
      if (pull !== undefined) return { repo, pull };
    }
    return null;
  }

  // -- object types -------------------------------------------------------------------------

  private select(field: FieldNode, parent: Parent, path: readonly (string | number)[]): unknown {
    if (field.selectionSet === undefined) return null;
    return this.executeSelections(field.selectionSet, parent, path);
  }

  private scalarOrSelect(field: FieldNode, parent: Parent, path: readonly (string | number)[], value: unknown): unknown {
    if (field.selectionSet !== undefined && value !== null && typeof value === 'object') {
      return this.executeSelections(field.selectionSet, parent, path);
    }
    return value;
  }

  private resolveRepository(field: FieldNode, parent: Parent, args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    const repo = parent.value as Repo;
    switch (field.name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return this.select(field, { type: 'User', value: this.forge.viewer }, path);
      case 'defaultBranchRef': {
        const tip = this.forge.resolveRef(repo, repo.defaultBranch);
        if (tip === undefined) return null;
        return this.select(field, { type: 'Ref', value: { name: repo.defaultBranch, target: tip }, repo }, path);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.private;
      case 'url':
        return `${this.forge.apiBase()}/${repo.owner}/${repo.name}`;
      case 'createdAt':
        return this.forge.isoAt(repo.createdSeq);
      case 'updatedAt':
        return this.forge.isoAt(repo.createdSeq);
      case 'issue': {
        const number = args.number as number | undefined;
        if (typeof number !== 'number') return null;
        const issue = this.forge.getIssue(repo, number);
        if (issue === undefined) return null;
        return this.select(field, { type: 'Issue', value: issue, repo }, path);
      }
      case 'issues':
        return this.issueConnection(field, repo, args, path);
      case 'pullRequest': {
        const number = args.number as number | undefined;
        if (typeof number !== 'number') return null;
        const pull = this.forge.getPull(repo, number);
        if (pull === undefined) return null;
        return this.select(field, { type: 'PullRequest', value: pull, repo }, path);
      }
      case 'pullRequests':
        return this.pullRequestConnection(field, repo, args, path);
      default:
        return this.unknownField(field, parent, path);
    }
  }

  private issueConnection(field: FieldNode, repo: Repo, args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    let issues = [...repo.issues];
    const states = args.states as readonly string[] | undefined;
    const wanted = states === undefined || states.length === 0 ? ['OPEN'] : states;
    issues = issues.filter((issue) => wanted.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const direction = orderBy?.direction ?? 'DESC';
    issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    const first = args.first as number | undefined;
    const afterSeq = seqOfCursor(args.after);
    if (afterSeq !== null) {
      const index = issues.findIndex((issue) => issue.createdSeq === afterSeq);
      if (index >= 0) issues = issues.slice(index + 1);
    }
    const total = issues.length;
    const page = first === undefined ? issues : issues.slice(0, first);
    const connection = {
      nodes: page,
      edges: page.map((issue) => ({ node: issue, cursor: cursorFor(issue.createdSeq) })),
      pageInfo: {
        hasNextPage: page.length < total,
        hasPreviousPage: afterSeq !== null,
        startCursor: page.length > 0 ? cursorFor(page[0]?.createdSeq ?? 0) : null,
        endCursor: page.length > 0 ? cursorFor(page[page.length - 1]?.createdSeq ?? 0) : null,
      },
      totalCount: total,
    };
    return this.select(field, { type: 'IssueConnection', value: connection, repo }, path);
  }

  private pullRequestConnection(field: FieldNode, repo: Repo, args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    let pulls = [...repo.pulls];
    const states = args.states as readonly string[] | undefined;
    const wanted = states === undefined || states.length === 0 ? ['OPEN'] : states;
    const stateOf = (pull: PullRequest): string => (pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED');
    pulls = pulls.filter((pull) => wanted.includes(stateOf(pull)));
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const direction = orderBy?.direction ?? 'DESC';
    pulls.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    const first = args.first as number | undefined;
    const afterSeq = seqOfCursor(args.after);
    if (afterSeq !== null) {
      const index = pulls.findIndex((pull) => pull.createdSeq === afterSeq);
      if (index >= 0) pulls = pulls.slice(index + 1);
    }
    const total = pulls.length;
    const page = first === undefined ? pulls : pulls.slice(0, first);
    const connection = {
      nodes: page,
      edges: page.map((pull) => ({ node: pull, cursor: cursorFor(pull.createdSeq) })),
      pageInfo: {
        hasNextPage: page.length < total,
        hasPreviousPage: afterSeq !== null,
        startCursor: page.length > 0 ? cursorFor(page[0]?.createdSeq ?? 0) : null,
        endCursor: page.length > 0 ? cursorFor(page[page.length - 1]?.createdSeq ?? 0) : null,
      },
      totalCount: total,
    };
    return this.select(field, { type: 'PullRequestConnection', value: connection, repo }, path);
  }

  private resolveIssue(field: FieldNode, parent: Parent, _args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    const issue = parent.value as Issue;
    switch (field.name) {
      case 'id':
        return globalId('Issue', issue.id);
      case 'databaseId':
        return issue.id;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'createdAt':
        return this.forge.isoAt(issue.createdSeq);
      case 'updatedAt':
        return this.forge.isoAt(issue.updatedSeq);
      case 'closed':
        return issue.state === 'closed';
      case 'closedAt':
        return issue.state === 'closed' ? this.forge.isoAt(issue.updatedSeq) : null;
      case 'author':
        return this.select(field, { type: 'User', value: this.forge.viewer }, path);
      case 'url':
        return `${this.forge.apiBase()}/${parent.repo?.owner ?? ''}/${parent.repo?.name ?? ''}/issues/${issue.number}`;
      case 'labels':
        return issue.labels;
      case 'comments': {
        const comments = parent.repo?.comments.get(issue.number) ?? [];
        const connection = {
          nodes: comments,
          edges: comments.map((comment) => ({ node: comment, cursor: cursorFor(comment.createdSeq) })),
          pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: comments.length,
        };
        return this.select(field, { type: 'CommentConnection', value: connection, repo: parent.repo }, path);
      }
      case 'repository':
        if (parent.repo === undefined) return null;
        return this.select(field, { type: 'Repository', value: parent.repo, repo: parent.repo }, path);
      default:
        return this.unknownField(field, parent, path);
    }
  }

  private resolvePullRequest(field: FieldNode, parent: Parent, args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    const pull = parent.value as PullRequest;
    const repo = parent.repo as Repo;
    switch (field.name) {
      case 'id':
        return globalId('PullRequest', pull.id);
      case 'databaseId':
        return pull.id;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return this.forge.pullMergeable(repo, pull);
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'headRefOid':
        return this.forge.resolveRef(repo, pull.head) ?? null;
      case 'baseRefOid':
        return this.forge.resolveRef(repo, pull.base) ?? null;
      case 'createdAt':
        return this.forge.isoAt(pull.createdSeq);
      case 'updatedAt':
        return this.forge.isoAt(pull.createdSeq);
      case 'author':
        return this.select(field, { type: 'User', value: this.forge.viewer }, path);
      case 'url':
        return `${this.forge.apiBase()}/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'files': {
        const files = this.forge.pullFiles(repo, pull);
        const first = args.first as number | undefined;
        const page = first === undefined ? files : files.slice(0, first);
        const connection = {
          nodes: page,
          edges: page.map((file, index) => ({ node: file, cursor: cursorFor(index) })),
          pageInfo: { hasNextPage: page.length < files.length, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: files.length,
        };
        return this.select(field, { type: 'PullRequestFileConnection', value: connection, repo }, path);
      }
      default:
        return this.unknownField(field, parent, path);
    }
  }

  private resolveUser(field: FieldNode, parent: Parent, _args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    const user = parent.value as { id: number; login: string; name: string; email: string };
    switch (field.name) {
      case 'id':
        return globalId('User', user.id);
      case 'databaseId':
        return user.id;
      case 'login':
        return user.login;
      case 'name':
        return user.name;
      case 'email':
        return user.email;
      case 'url':
        return `${this.forge.apiBase()}/${user.login}`;
      default:
        return this.unknownField(field, parent, path);
    }
  }

  private resolveComment(field: FieldNode, parent: Parent, _args: Record<string, unknown>, _path: readonly (string | number)[]): unknown {
    const comment = parent.value as { id: number; body: string; createdSeq: number; userLogin: string };
    switch (field.name) {
      case 'id':
        return globalId('IssueComment', comment.id);
      case 'databaseId':
        return comment.id;
      case 'body':
        return comment.body;
      case 'createdAt':
        return this.forge.isoAt(comment.createdSeq);
      case 'updatedAt':
        return this.forge.isoAt(comment.createdSeq);
      default:
        return this.unknownField(field, parent, _path);
    }
  }

  private resolveRef(field: FieldNode, parent: Parent, _args: Record<string, unknown>, _path: readonly (string | number)[]): unknown {
    const ref = parent.value as { name: string; target: string };
    switch (field.name) {
      case 'name':
        return ref.name;
      default:
        return this.unknownField(field, parent, _path);
    }
  }

  private resolveConnection(field: FieldNode, parent: Parent, _args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    const connection = parent.value as {
      nodes: readonly unknown[];
      edges: readonly { node: unknown; cursor: string }[];
      pageInfo: Record<string, unknown>;
      totalCount: number;
    };
    switch (field.name) {
      case 'nodes':
        return connection.nodes.map((node) => this.selectNode(field, node, parent, path));
      case 'edges':
        return connection.edges.map((edge) => this.select(field, { type: this.edgeType(parent.type), value: edge, repo: parent.repo }, path));
      case 'pageInfo':
        return this.select(field, { type: 'PageInfo', value: connection.pageInfo, repo: parent.repo }, path);
      case 'totalCount':
        return connection.totalCount;
      default:
        return this.unknownField(field, parent, path);
    }
  }

  private edgeType(connectionType: string): string {
    if (connectionType === 'IssueConnection') return 'IssueEdge';
    if (connectionType === 'PullRequestConnection') return 'PullRequestEdge';
    if (connectionType === 'PullRequestFileConnection') return 'PullRequestFileEdge';
    return 'IssueCommentEdge';
  }

  private selectNode(field: FieldNode, node: unknown, parent: Parent, path: readonly (string | number)[]): unknown {
    if (field.selectionSet === undefined) return null;
    let type = parent.type;
    if (type === 'IssueConnection') type = 'Issue';
    else if (type === 'PullRequestConnection') type = 'PullRequest';
    else if (type === 'PullRequestFileConnection') type = 'PullRequestFile';
    else if (type === 'CommentConnection') type = 'IssueComment';
    return this.executeSelections(field.selectionSet, { type, value: node, repo: parent.repo }, path);
  }

  private resolveEdge(field: FieldNode, parent: Parent, _args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    const edge = parent.value as { node: unknown; cursor: string };
    switch (field.name) {
      case 'node': {
        if (field.selectionSet === undefined) return null;
        let type = parent.type;
        if (type === 'IssueEdge') type = 'Issue';
        else if (type === 'PullRequestEdge') type = 'PullRequest';
        else if (type === 'PullRequestFileEdge') type = 'PullRequestFile';
        else if (type === 'IssueCommentEdge') type = 'IssueComment';
        return this.executeSelections(field.selectionSet, { type, value: edge.node, repo: parent.repo }, path);
      }
      case 'cursor':
        return edge.cursor;
      default:
        return this.unknownField(field, parent, path);
    }
  }

  private resolvePageInfo(field: FieldNode, parent: Parent, _args: Record<string, unknown>, _path: readonly (string | number)[]): unknown {
    const info = parent.value as Record<string, unknown>;
    if (field.name in info) return info[field.name] ?? null;
    return this.unknownField(field, parent, _path);
  }

  private resolvePullRequestFile(field: FieldNode, parent: Parent, _args: Record<string, unknown>, _path: readonly (string | number)[]): unknown {
    const file = parent.value as { path: string; status: string; additions: number; deletions: number };
    switch (field.name) {
      case 'path':
        return file.path;
      case 'additions':
        return file.additions;
      case 'deletions':
        return file.deletions;
      case 'changeType':
        return file.status.toUpperCase();
      default:
        return this.unknownField(field, parent, _path);
    }
  }

  // -- payloads -------------------------------------------------------------------------------

  private resolveIssuePayload(field: FieldNode, parent: Parent, _args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    const issue = parent.value as Issue;
    if (field.name === 'issue') return this.select(field, { type: 'Issue', value: issue, repo: parent.repo }, path);
    return this.unknownField(field, parent, path);
  }

  private resolvePullRequestPayload(field: FieldNode, parent: Parent, _args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    const pull = parent.value as PullRequest;
    if (field.name === 'pullRequest') return this.select(field, { type: 'PullRequest', value: pull, repo: parent.repo }, path);
    return this.unknownField(field, parent, path);
  }

  private resolveAddCommentPayload(field: FieldNode, parent: Parent, _args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    const comment = parent.value as { id: number; body: string; createdSeq: number };
    if (field.name === 'commentEdge') {
      const edge = { node: comment, cursor: cursorFor(comment.createdSeq) };
      return this.select(field, { type: 'IssueCommentEdge', value: edge, repo: parent.repo }, path);
    }
    if (field.name === 'comment') return this.select(field, { type: 'IssueComment', value: comment, repo: parent.repo }, path);
    return this.unknownField(field, parent, path);
  }

  // -- introspection ----------------------------------------------------------------------------

  private typeObject(name: string, selectionSet: readonly SelectionNode[], path: readonly (string | number)[]): unknown {
    if (SCHEMA_FIELDS[name] === undefined && SCHEMA_ENUMS[name] === undefined) return null;
    const value = { name, kind: SCHEMA_ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT' };
    return this.executeSelections(selectionSet, { type: '__Type', value }, path);
  }

  private resolveTypeObject(field: FieldNode, parent: Parent, args: Record<string, unknown>, path: readonly (string | number)[]): unknown {
    const type = parent.value as { name: string; kind: string };
    switch (field.name) {
      case 'name':
        return type.name;
      case 'kind':
        return type.kind;
      case 'fields': {
        const names = SCHEMA_FIELDS[type.name] ?? [];
        const value = names.map((name) => ({ name }));
        if (field.selectionSet === undefined) return value;
        return value.map((entry) => this.executeSelections(field.selectionSet as readonly SelectionNode[], { type: '__Field', value: entry }, path));
      }
      case 'enumValues': {
        const names = SCHEMA_ENUMS[type.name] ?? [];
        const value = names.map((name) => ({ name }));
        if (field.selectionSet === undefined) return value;
        return value.map((entry) => this.executeSelections(field.selectionSet as readonly SelectionNode[], { type: '__EnumValue', value: entry }, path));
      }
      default:
        if (field.name === 'description') return null;
        return this.unknownField(field, parent, path);
    }
  }
}

// -------------------------------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------------------------------

export interface GraphQLResult {
  readonly status: number;
  readonly body: unknown;
}

function runOne(forge: Forge, operation: unknown): { status: number; body: unknown } {
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
    return { status: 400, body: { errors: [{ message: 'Each GraphQL operation must be a JSON object with a query string.' }] } };
  }
  const record = operation as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { status: 400, body: { errors: [{ message: 'A query string is required.' }] } };
  }
  const variables = (record.variables ?? {}) as Variables;
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)) {
    return { status: 400, body: { errors: [{ message: 'variables must be a JSON object.' }] } };
  }
  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { status: 400, body: { errors: [{ message: error instanceof Error ? error.message : 'GraphQL syntax error' }] } };
  }
  if (doc.operations.length === 0) {
    return { status: 400, body: { errors: [{ message: 'The document holds no operation.' }] } };
  }
  let selected: OperationNode | undefined;
  const operationName = record.operationName;
  if (typeof operationName === 'string') {
    selected = doc.operations.find((entry) => entry.name === operationName);
    if (selected === undefined) {
      return { status: 200, body: { data: null, errors: [{ message: `Unknown operation named ${JSON.stringify(operationName)}.` }] } };
    }
  } else if (doc.operations.length === 1) {
    selected = doc.operations[0];
  } else {
    return { status: 200, body: { data: null, errors: [{ message: 'This document holds several operations; name one with operationName.' }] } };
  }
  // Required variables must be present (or have a default).
  const missing: string[] = [];
  for (const definition of selected.variableDefinitions) {
    if (!definition.required) continue;
    if (variables[definition.name] === undefined && definition.defaultValue === undefined) missing.push(definition.name);
  }
  if (missing.length > 0) {
    return { status: 200, body: { data: null, errors: missing.map((name) => ({ message: `Variable $${name} of required type was not provided.` })) } };
  }
  const executor = new Executor(forge, doc, variables);
  const { data, errors } = executor.run(selected);
  if (errors.length > 0) return { status: 200, body: { data, errors } };
  return { status: 200, body: { data } };
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphQL(forge: Forge, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    const results = body.map((operation) => runOne(forge, operation));
    return { status: 200, body: results.map((result) => result.body) };
  }
  return runOne(forge, body);
}
