// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies the edits AI
// models write, in four formats (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON
// text-editor tool calls), to a tree of text files, changing every file or none. Node 22 and its
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** origin.get(p) is the path before the patch whose content p now holds, when p arrived by a move. */
  readonly origin = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
      tree.origin.delete(p);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Files as lines (SPEC.md section 3) and line matching (section 5) ---- */

interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where O occurs in the file at this tier. */
function occurrencesFrom(file: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const n = o.length;
  for (let i = Math.max(0, from); i + n <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normLine(file[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least once. */
function findTier(file: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesFrom(file, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface LineEntry {
  text: string;
  ctx: boolean;
}

/**
 * The lines that replace a matched occurrence. A context line is written as the file's own matched
 * line, never the patch's. At tier 2 every other line of N is re-indented: P, the leading spaces
 * and tabs of O's first line, is replaced by F, those of the file's first matched line.
 */
function buildReplacement(n: LineEntry[], o: LineEntry[], file: string[], pos: number, tier: number): string[] {
  const oCtx: number[] = [];
  o.forEach((e, i) => {
    if (e.ctx) oCtx.push(i);
  });
  let seen = 0;
  const out: string[] = [];
  const p = o.length > 0 ? leadingWs(o[0]!.text) : '';
  const f = o.length > 0 ? leadingWs(file[pos]!) : '';
  for (const e of n) {
    if (e.ctx) {
      out.push(file[pos + oCtx[seen]!]!);
      seen += 1;
    } else if (tier === 2 && o.length > 0 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(p)) {
      out.push(f + e.text.slice(p.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface Hunk {
  a: number;
  o: LineEntry[];
  n: LineEntry[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

interface UniSection {
  dashOld?: string | null;
  dashNew?: string | null;
  renFrom?: string | null;
  renTo?: string | null;
  diffOld?: string | null;
  diffNew?: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/;

/** The path of a `--- ` / `+++ ` line: text after the four characters, up to the first tab, trimmed. */
function dashPath(line: string): string | null {
  let s = line.slice(4).split('\t')[0]!.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s === '/dev/null' ? null : s;
}

function cleanRename(rest: string): string | null {
  let s = rest.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s === '/dev/null' ? null : s;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let hunk: { a: number; body: string[] } | null = null;
  const isDiffLine = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  const isBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
  const finishHunk = (): void => {
    if (hunk === null || cur === null) return;
    const body = hunk.body;
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    let noEol = false;
    let plusNoEol = false;
    let lastCtx = -1;
    let lastPlus = -1;
    for (let i = 0; i < body.length; i++) {
      const b = body[i]!;
      if (b === '' || b[0] === ' ' || b[0] === '+') lastCtx = i;
      if (b[0] === '+') lastPlus = i;
    }
    if (lastCtx >= 0 && lastCtx + 1 < body.length && body[lastCtx + 1]![0] === '\\') noEol = true;
    if (lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]![0] === '\\') plusNoEol = true;
    const o: LineEntry[] = [];
    const n: LineEntry[] = [];
    for (const b of body) {
      if (b === '' || b[0] === ' ') {
        const t = b === '' ? '' : b.slice(1);
        o.push({ text: t, ctx: true });
        n.push({ text: t, ctx: true });
      } else if (b[0] === '-') {
        o.push({ text: b.slice(1), ctx: false });
      } else if (b[0] === '+') {
        n.push({ text: b.slice(1), ctx: false });
      }
      // `\` lines add no line of their own.
    }
    cur.hunks.push({ a: hunk.a, o, n, noEol, plusNoEol });
    hunk = null;
  };
  const newSection = (): UniSection => ({ isNew: false, isDeleted: false, hunks: [] });
  const startSection = (s: UniSection): void => {
    if (cur !== null) sections.push(cur);
    cur = s;
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      // A `--- ` line followed by a `+++ ` line ends the body even though it starts with `-`.
      if (line.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1]!.startsWith('+++ ')) {
        finishHunk();
        continue; // re-process this line outside the body
      }
      if (isBodyLine(line)) {
        hunk.body.push(line);
        i++;
        continue;
      }
      finishHunk();
      continue; // re-process this line outside the body
    }
    if (isDiffLine(line)) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1] === '/dev/null' ? null : m[1]!;
      s.diffNew = m[2] === '/dev/null' ? null : m[2]!;
      startSection(s);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (inHeader && cur !== null) {
          cur.dashOld = dashPath(line);
          cur.dashNew = dashPath(next);
        } else {
          const s = newSection();
          s.dashOld = dashPath(line);
          s.dashNew = dashPath(next);
          startSection(s);
        }
        i += 2;
        continue;
      }
      if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), body: [] };
      inHeader = false;
      i++;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('+++ ')) {
        cur.dashNew = dashPath(line);
      } else if (line === 'rename from' || line.startsWith('rename from ')) {
        cur.renFrom = cleanRename(line.slice('rename from'.length));
      } else if (line === 'rename to' || line.startsWith('rename to ')) {
        cur.renTo = cleanRename(line.slice('rename to'.length));
      } else if (line === 'new file mode' || line.startsWith('new file mode ') || line.startsWith('new file mode\t')) {
        cur.isNew = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ') || line.startsWith('deleted file mode\t')) {
        cur.isDeleted = true;
      }
      // Every other header line is ignored.
      i++;
      continue;
    }
    // Outside bodies and headers: ignored prose.
    i++;
  }
  finishHunk();
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function applyHunks(st: FileState, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > st.lines.length) pos = st.lines.length;
      const atEnd = pos === st.lines.length;
      st.lines.splice(pos, 0, ...h.n.map((e) => e.text));
      if (atEnd) st.finalBreak = !h.noEol;
    } else {
      const oTexts = h.o.map((e) => e.text);
      const found = findTier(st.lines, oTexts, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const q of found.occ) {
        const dist = Math.abs(q - target);
        if (dist < bestDist) {
          best = q;
          bestDist = dist;
        }
      }
      const atEnd = best + h.o.length === st.lines.length;
      const rep = buildReplacement(h.n, h.o, st.lines, best, found.tier);
      st.lines.splice(best, h.o.length, ...rep);
      if (atEnd) st.finalBreak = !h.noEol;
    }
    d += h.n.length - h.o.length;
  }
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  const oldP: string | null = s.dashOld !== undefined ? s.dashOld : (s.renFrom !== undefined ? s.renFrom : (s.diffOld ?? null));
  const newP: string | null = s.dashNew !== undefined ? s.dashNew : (s.renTo !== undefined ? s.renTo : (s.diffNew ?? null));
  const hunks = s.hunks;
  if (oldP === null && newP === null) {
    return () => {
      throw new Fail('unsafe', '');
    };
  }
  if (oldP === null || s.isNew) {
    const p = newP;
    return (tree) => {
      if (p === null) throw new Fail('unsafe', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of hunks) for (const e of h.n) if (!e.ctx) plus.push(e.text);
      let finalBreak = true;
      for (let k = hunks.length - 1; k >= 0; k--) {
        const h = hunks[k]!;
        if (h.n.some((e) => !e.ctx)) {
          finalBreak = !h.plusNoEol;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      tree.origin.delete(p);
    };
  }
  if (newP === null || s.isDeleted) {
    const p = oldP;
    return (tree) => {
      if (p === null) throw new Fail('unsafe', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      tree.origin.delete(p);
    };
  }
  if (oldP !== newP) {
    const op = oldP;
    const np = newP;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const st = splitFile(before);
      applyHunks(st, hunks, op, strict);
      const out = joinFile(st);
      const org = tree.origin.get(op);
      tree.now.set(op, null);
      tree.origin.delete(op);
      tree.now.set(np, out);
      tree.origin.set(np, org !== undefined ? org : op);
    };
  }
  const p = oldP;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const st = splitFile(before);
    applyHunks(st, hunks, p, strict);
    tree.now.set(p, joinFile(st));
  };
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isSearch(lines[i]!)) {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      if (isSearch(lines[k]!)) break;
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      if (isSearch(lines[k]!)) break;
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, sep), newLines: lines.slice(sep + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  const { path, oldLines, newLines } = b;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      tree.origin.delete(path);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const st = splitFile(before);
    const found = findTier(st.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const oEntries: LineEntry[] = oldLines.map((t) => ({ text: t, ctx: false }));
    const nEntries: LineEntry[] = newLines.map((t) => ({ text: t, ctx: false }));
    const rep = buildReplacement(nEntries, oEntries, st.lines, pos, found.tier);
    st.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(st));
  };
}

/* ---- V4A patches (SPEC.md section 8) ---- */

const V4A_ADD = '*** Add File:';
const V4A_DEL = '*** Delete File:';
const V4A_UPD = '*** Update File:';
const V4A_MOVE = '*** Move to:';

function v4aSectionStart(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith(V4A_ADD)) return 'add';
  if (line.startsWith(V4A_DEL)) return 'delete';
  if (line.startsWith(V4A_UPD)) return 'update';
  return null;
}

interface VChunk {
  anchor: string | null;
  o: LineEntry[];
  n: LineEntry[];
  eof: boolean;
}

function findAnchor(file: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < file.length; i++) {
      if (normLine(file[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return -1;
}

function applyVChunks(st: FileState, chunks: VChunk[], path: string, strict: boolean): void {
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const at = findAnchor(st.lines, c.anchor, cursor, strict);
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    if (c.o.length === 0) {
      const pos = c.eof ? st.lines.length : cursor;
      const add = c.n.map((e) => e.text);
      st.lines.splice(pos, 0, ...add);
      cursor = pos + add.length;
    } else {
      const oTexts = c.o.map((e) => e.text);
      const found = findTier(st.lines, oTexts, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let occ = found.occ;
      if (c.eof) {
        occ = occ.filter((q) => q + oTexts.length === st.lines.length);
        if (occ.length === 0) throw new Fail('no-match', path);
      }
      const pos = occ[0]!;
      const rep = buildReplacement(c.n, c.o, st.lines, pos, found.tier);
      st.lines.splice(pos, oTexts.length, ...rep);
      cursor = pos + rep.length;
    }
  }
}

function v4aAddEdit(p: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    tree.origin.delete(p);
  };
}

function v4aDeleteEdit(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    tree.origin.delete(p);
  };
}

function v4aUpdateEdit(p: string, raw: string[], baseLine: number, updLineNo: number, strict: boolean): Edit {
  let moveTo: string | undefined;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.startsWith(V4A_MOVE)) {
    moveTo = raw[0]!.slice(V4A_MOVE.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < raw.length; idx++) {
    const l = raw[idx]!;
    const ln = baseLine + idx;
    if (l.startsWith('@@')) {
      const a = l.slice(2).trim();
      cur = { anchor: a === '' ? null : a, o: [], n: [], eof: false };
      chunks.push(cur);
    } else if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      cur = null;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, o: [], n: [], eof: false };
        chunks.push(cur);
      }
      if (l === '' || l[0] === ' ') {
        const t = l === '' ? '' : l.slice(1);
        cur.o.push({ text: t, ctx: true });
        cur.n.push({ text: t, ctx: true });
      } else if (l[0] === '-') {
        cur.o.push({ text: l.slice(1), ctx: false });
      } else {
        cur.n.push({ text: l.slice(1), ctx: false });
      }
    } else {
      throw new Exit2(`error: parse ${ln}`);
    }
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updLineNo}`);
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    let np: string | null = null;
    if (moveTo !== undefined) {
      np = moveTo;
      if (!safe(np)) throw new Fail('unsafe', np);
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (np !== null && tree.get(np) !== null) throw new Fail('exists', np);
    const st = splitFile(before);
    applyVChunks(st, chunks, p, strict);
    const out = joinFile(st);
    if (np !== null) {
      const org = tree.origin.get(p);
      tree.now.set(p, null);
      tree.origin.delete(p);
      tree.now.set(np, out);
      tree.origin.set(np, org !== undefined ? org : p);
    } else {
      tree.now.set(p, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = v4aSectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && v4aSectionStart(lines[j]!) === null) j++;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const p = line.slice(V4A_ADD.length).trim();
      const fileLines: string[] = [];
      raw.forEach((l, k) => {
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      });
      edits.push(v4aAddEdit(p, fileLines));
    } else if (kind === 'delete') {
      const p = line.slice(V4A_DEL.length).trim();
      if (raw.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      edits.push(v4aDeleteEdit(p));
    } else {
      const p = line.slice(V4A_UPD.length).trim();
      edits.push(v4aUpdateEdit(p, raw, i + 2, i + 1, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- Running the patch (SPEC.md sections 1, 2 and 10) ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const changed = [...tree.now.keys()].sort(byBytes).filter((p) => tree.original(p) !== tree.now.get(p));
  // A move replaces its D and A lines with one R line, sorted by the new path.
  const moved = new Map<string, string>(); // new path -> old path, for moves that read as R lines
  for (const p of changed) {
    const was = tree.original(p);
    const o = tree.origin.get(p);
    if (o !== undefined && o !== p && tree.original(o) !== null && tree.get(o) === null && was === null) {
      moved.set(p, o);
    }
  }
  const movedFrom = new Set(moved.values());
  const rows: { key: string; text: string }[] = [];
  for (const p of changed) {
    if (movedFrom.has(p)) continue; // its D line is replaced by the R line
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    const o = moved.get(p);
    if (o !== undefined) {
      rows.push({ key: p, text: `R ${o} -> ${p}` });
    } else {
      rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
  }
  rows.sort((a, b) => byBytes(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outRows = rows.map((r) => r.text);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
