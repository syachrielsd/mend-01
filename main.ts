// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  /** Successful move edits, in order: [old path, new path]. Rolled back with `now` when a later edit fails. */
  readonly moves: [string, string][] = [];
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

/* Sections 3 and 5: a file as lines, and the three matching tiers. */

interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitText(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, final: fin };
}

function joinText(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.final ? fl.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const NORMS: ((s: string) => string)[] = [(s) => s, stripTrail, stripBoth];

function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const norm = NORMS[tier]!;
  const target = O.map(norm);
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (norm(lines[i + j]!) !== target[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const at = occurrences(lines, O, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/* A hunk or chunk body: context lines belong to both O and N, `del` to O only, `add` to N only,
   and `bs` is a `\` line, which refers to the body line before it. */
interface Item {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  emptyLine?: boolean;
}

const oldOf = (items: Item[]): string[] => items.filter((i) => i.kind === 'ctx' || i.kind === 'del').map((i) => i.text);
const newOf = (items: Item[]): string[] => items.filter((i) => i.kind === 'ctx' || i.kind === 'add').map((i) => i.text);

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** The lines a matched hunk writes at `pos`: context from the file itself, tier-2 additions re-indented. */
function applyItems(fileLines: string[], pos: number, items: Item[], tier: number): string[] {
  const O = oldOf(items);
  const F = tier === 2 && O.length > 0 ? leadWs(fileLines[pos]!) : '';
  const P = tier === 2 && O.length > 0 ? leadWs(O[0]!) : '';
  const seg: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      seg.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === 'del') {
      oi += 1;
    } else if (it.kind === 'add') {
      let s = it.text;
      if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(P)) s = F + s.slice(P.length);
      seg.push(s);
    }
  }
  return seg;
}

/** True when a `\` line immediately follows the body's last context or `+` line. */
function bsAfterLastWrite(items: Item[]): boolean {
  let last = -1;
  items.forEach((it, idx) => {
    if (it.kind === 'ctx' || it.kind === 'add') last = idx;
  });
  return last >= 0 && items[last + 1]?.kind === 'bs';
}

/* Section 6: unified diffs. */

interface UHunk {
  a: number;
  items: Item[];
}

interface USec {
  diffOld?: string;
  diffNew?: string;
  headOld?: string | null;
  headNew?: string | null;
  renFrom?: string;
  renTo?: string;
  newFile: boolean;
  delFile: boolean;
  hasPair: boolean;
  hunks: UHunk[];
}

function headerPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function diffGitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  return m === null ? null : [m[1]!, m[2]!];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USec[] = [];
  let sec: USec | null = null;
  const startSec = (): USec => {
    const s: USec = { newFile: false, delFile: false, hasPair: false, hunks: [] };
    secs.push(s);
    sec = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.startsWith('diff --git ')) {
      const p = diffGitPaths(L);
      if (p === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSec();
      s.diffOld = p[0];
      s.diffNew = p[1];
      i += 1;
      continue;
    }
    if (L.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(L);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), items: [] };
      i += 1;
      while (i < lines.length) {
        const B = lines[i]!;
        if (B.startsWith('diff --git ')) break;
        if (B.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (B === '') hunk.items.push({ kind: 'ctx', text: '', emptyLine: true });
        else if (B[0] === ' ') hunk.items.push({ kind: 'ctx', text: B.slice(1) });
        else if (B[0] === '-') hunk.items.push({ kind: 'del', text: B.slice(1) });
        else if (B[0] === '+') hunk.items.push({ kind: 'add', text: B.slice(1) });
        else if (B[0] === '\\') hunk.items.push({ kind: 'bs', text: B.slice(1) });
        else break;
        i += 1;
      }
      while (hunk.items.length > 0) {
        const tail = hunk.items[hunk.items.length - 1]!;
        if (tail.kind === 'ctx' && tail.emptyLine === true) hunk.items.pop();
        else break;
      }
      sec.hunks.push(hunk);
      continue;
    }
    const inHeader = sec !== null && sec.hunks.length === 0;
    if (L.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        const target = inHeader && !sec!.hasPair ? sec! : startSec();
        target.headOld = headerPath(L.slice(4));
        target.headNew = headerPath(next.slice(4));
        target.hasPair = true;
        i += 2;
        continue;
      }
      if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (L.startsWith('rename from ')) sec!.renFrom = L.slice('rename from '.length).split('\t')[0]!.trim();
      else if (L.startsWith('rename to ')) sec!.renTo = L.slice('rename to '.length).split('\t')[0]!.trim();
      else if (L.startsWith('new file mode')) sec!.newFile = true;
      else if (L.startsWith('deleted file mode')) sec!.delFile = true;
    }
    i += 1;
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: USec, strict: boolean): Edit {
  const oldP: string | null | undefined = sec.headOld !== undefined ? sec.headOld : sec.renFrom !== undefined ? sec.renFrom : sec.diffOld;
  const newP: string | null | undefined = sec.headNew !== undefined ? sec.headNew : sec.renTo !== undefined ? sec.renTo : sec.diffNew;
  const creation = oldP === null || sec.newFile;
  const deletion = !creation && (newP === null || sec.delFile);
  if (creation && typeof newP !== 'string' && typeof oldP !== 'string') throw new Exit2('error: parse 1');
  if (!creation && typeof oldP !== 'string' && typeof newP !== 'string') throw new Exit2('error: parse 1');
  return (tree) => {
    if (creation) {
      const p = (typeof newP === 'string' ? newP : oldP) as string;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const items = sec.hunks.flatMap((h) => h.items);
      const adds = items.filter((it) => it.kind === 'add');
      let lastAdd = -1;
      items.forEach((it, idx) => {
        if (it.kind === 'add') lastAdd = idx;
      });
      const noBreak = lastAdd >= 0 && items[lastAdd + 1]?.kind === 'bs';
      tree.now.set(p, joinText({ br: '\n', lines: adds.map((it) => it.text), final: adds.length > 0 && !noBreak }));
      return;
    }
    const src = (typeof oldP === 'string' ? oldP : newP) as string;
    const isMove = !deletion && typeof newP === 'string' && newP !== src;
    if (!safe(src)) throw new Fail('unsafe', src);
    if (isMove && !safe(newP as string)) throw new Fail('unsafe', newP as string);
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (deletion) {
      tree.now.set(src, null);
      return;
    }
    if (isMove && tree.get(newP as string) !== null) throw new Fail('exists', newP as string);
    const fl = splitText(before);
    let d = 0;
    for (const h of sec.hunks) {
      const O = oldOf(h.items);
      const N = newOf(h.items);
      if (O.length === 0) {
        const adds = h.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const pos = Math.min(Math.max(h.a + d, 0), fl.lines.length);
        const atEnd = pos === fl.lines.length;
        fl.lines.splice(pos, 0, ...adds);
        if (atEnd && adds.length > 0) fl.final = !bsAfterLastWrite(h.items);
        d += adds.length;
        continue;
      }
      const found = findTier(fl.lines, O, strict);
      if (found === null) throw new Fail('no-match', src);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      let best = Math.abs(pos - target);
      for (const cand of found.at) {
        const dist = Math.abs(cand - target);
        if (dist < best) {
          best = dist;
          pos = cand;
        }
      }
      const seg = applyItems(fl.lines, pos, h.items, found.tier);
      const runsToEnd = pos + O.length === fl.lines.length;
      fl.lines.splice(pos, O.length, ...seg);
      if (runsToEnd) fl.final = !bsAfterLastWrite(h.items);
      d += N.length - O.length;
    }
    const out = joinText(fl);
    if (isMove) {
      tree.now.set(src, null);
      tree.now.set(newP as string, out);
      tree.moves.push([src, newP as string]);
    } else {
      tree.now.set(src, out);
    }
  };
}

/* Section 7: SEARCH/REPLACE blocks. */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let p: string | null = null;
    for (let j = at - 1; j >= prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (cand.trim() === '') continue;
      if (cand.trim().startsWith('```')) continue;
      p = cand.trim();
      break;
    }
    if (p === null) {
      if (prevPath !== null) p = prevPath;
      else throw new Exit2(`error: parse ${at + 1}`);
    }
    let mid = -1;
    for (let j = at + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        mid = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (mid < 0) throw new Exit2(`error: parse ${at + 1}`);
    let end = -1;
    for (let j = mid + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${at + 1}`);
    const oldL = lines.slice(at + 1, mid);
    const newL = lines.slice(mid + 1, end);
    const path = p;
    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldL.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinText({ br: '\n', lines: [...newL], final: newL.length > 0 }));
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const fl = splitText(before);
      const found = findTier(fl.lines, oldL, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.at.length > 1) throw new Fail('ambiguous', path);
      const items: Item[] = [
        ...oldL.map((t) => ({ kind: 'del' as const, text: t })),
        ...newL.map((t) => ({ kind: 'add' as const, text: t })),
      ];
      const seg = applyItems(fl.lines, found.at[0]!, items, found.tier);
      fl.lines.splice(found.at[0]!, oldL.length, ...seg);
      tree.now.set(path, joinText(fl));
    });
    prevPath = p;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* Section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: Item[];
}

interface VSec {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  fileLines: string[];
  moveTo?: string;
  chunks: VChunk[];
}

const V_PREFIXES: [string, VSec['kind']][] = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'del'],
  ['*** Update File: ', 'upd'],
];

function vSecStart(l: string): { kind: VSec['kind']; path: string } | null {
  for (const [pre, kind] of V_PREFIXES) {
    if (l.startsWith(pre)) return { kind, path: l.slice(pre.length).trim() };
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: VSec[] = [];
  let i = first + 1;
  while (i < last) {
    const L = lines[i]!;
    if (blank(L)) {
      i += 1;
      continue;
    }
    const st = vSecStart(L);
    if (st === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    i += 1;
    const raw: { text: string; line: number }[] = [];
    while (i < last && vSecStart(lines[i]!) === null) {
      raw.push({ text: lines[i]!, line: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    secs.push(buildVSec(st.kind, st.path, secLine, raw));
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((s) => v4aEdit(s, strict));
}

function buildVSec(kind: VSec['kind'], path: string, secLine: number, raw: { text: string; line: number }[]): VSec {
  const sec: VSec = { kind, path, line: secLine, fileLines: [], chunks: [] };
  if (kind === 'add') {
    for (const r of raw) {
      if (r.text.startsWith('+')) sec.fileLines.push(r.text.slice(1));
      else if (r.text === '') sec.fileLines.push('');
      else throw new Exit2(`error: parse ${r.line}`);
    }
    return sec;
  }
  if (kind === 'del') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.line}`);
    return sec;
  }
  let idx = 0;
  const movePre = '*** Move to: ';
  // Blank lines carry no content in an Update section before its first real line: when the first
  // non-blank line is the Move to line, it is still the section's first line.
  let firstReal = 0;
  while (firstReal < raw.length && blank(raw[firstReal]!.text)) firstReal += 1;
  if (firstReal < raw.length && raw[firstReal]!.text.startsWith(movePre)) {
    sec.moveTo = raw[firstReal]!.text.slice(movePre.length).trim();
    idx = firstReal + 1;
  }
  let cur: VChunk | null = null;
  for (; idx < raw.length; idx += 1) {
    const { text: B, line: ln } = raw[idx]!;
    if (B.startsWith('@@')) {
      const anchor = B.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
      sec.chunks.push(cur);
    } else if (B.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      cur = null;
    } else if (B === '' || B[0] === ' ' || B[0] === '-' || B[0] === '+') {
      if (cur === null) {
        if (sec.chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, eof: false, items: [] };
        sec.chunks.push(cur);
      }
      if (B === '') cur.items.push({ kind: 'ctx', text: '' });
      else cur.items.push({ kind: B[0] === ' ' ? 'ctx' : B[0] === '-' ? 'del' : 'add', text: B.slice(1) });
    } else {
      throw new Exit2(`error: parse ${ln}`);
    }
  }
  if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${secLine}`);
  return sec;
}

function v4aEdit(sec: VSec, strict: boolean): Edit {
  const p = sec.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, joinText({ br: '\n', lines: [...sec.fileLines], final: sec.fileLines.length > 0 }));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const fl = splitText(before);
    const maxTier = strict ? 0 : 2;
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let hit = -1;
        for (let t = 0; t <= maxTier && hit < 0; t += 1) {
          const norm = NORMS[t]!;
          const want = norm(chunk.anchor);
          for (let k = cursor; k < fl.lines.length; k += 1) {
            if (norm(fl.lines[k]!) === want) {
              hit = k;
              break;
            }
          }
        }
        if (hit < 0) throw new Fail('no-match', p);
        cursor = hit + 1;
      }
      const O = oldOf(chunk.items);
      if (O.length === 0) {
        const adds = chunk.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const pos = chunk.eof ? fl.lines.length : Math.min(cursor, fl.lines.length);
        fl.lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
        continue;
      }
      let placed: { tier: number; pos: number } | null = null;
      for (let t = 0; t <= maxTier && placed === null; t += 1) {
        let at = occurrences(fl.lines, O, t, cursor);
        if (chunk.eof) at = at.filter((pos) => pos + O.length === fl.lines.length);
        if (at.length > 0) placed = { tier: t, pos: at[0]! };
      }
      if (placed === null) throw new Fail('no-match', p);
      const seg = applyItems(fl.lines, placed.pos, chunk.items, placed.tier);
      fl.lines.splice(placed.pos, O.length, ...seg);
      cursor = placed.pos + seg.length;
    }
    const out = joinText(fl);
    if (sec.moveTo !== undefined) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A successful move whose old path is gone and whose new path is new prints one R line, sorted by the new path,
  // in place of that pair's D and A lines.
  const movedTo = new Map<string, string>();
  const movedFrom = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (movedTo.has(n)) continue;
    if (tree.original(o) !== null && (tree.now.get(o) ?? null) === null && tree.original(n) === null && (tree.now.get(n) ?? null) !== null) {
      movedTo.set(n, o);
      movedFrom.add(o);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!check) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    if (movedFrom.has(p)) continue;
    if (movedTo.has(p)) rows.push({ key: p, line: `R ${movedTo.get(p)!} -> ${p}` });
    else rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
