import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { EMPTY_DOC, isBlankDoc } from '../doc/empty';
import { richDoc } from '../doc/fixtures';
import { validateDoc } from '../doc/validate';
import { COLLAB_COLOR, collabColor } from '../dto/collab-consts';
import {
  applyJSON,
  canonicalJSON,
  docFromState,
  jsonToYDoc,
  SEED_CLIENT_ID,
  yDocToJSON,
} from './index';

const para = (...texts: string[]): JSONContent => ({
  type: 'doc',
  content: texts.map((text) => ({
    type: 'paragraph',
    content: text ? [{ type: 'text', text }] : undefined,
  })),
});

describe('JSON <-> Yjs', () => {
  it('round-trips the document that uses every node type without loss', () => {
    const json = richDoc();
    const back = yDocToJSON(jsonToYDoc(json));
    expect(back).toEqual(canonicalJSON(json));
    // and what comes back is still a valid stored document
    const checked = validateDoc(back);
    expect(checked.ok, checked.ok ? '' : checked.error).toBe(true);
  });

  it('round-trips through the binary state (what is stored and loaded)', () => {
    const state = Y.encodeStateAsUpdate(jsonToYDoc(richDoc()));
    expect(yDocToJSON(docFromState(state))).toEqual(canonicalJSON(richDoc()));
  });

  it('round-trips an empty page and a page with marks and nesting', () => {
    expect(yDocToJSON(jsonToYDoc(EMPTY_DOC))).toEqual(canonicalJSON(EMPTY_DOC));
    const nested: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'a', marks: [{ type: 'bold' }, { type: 'italic' }] },
                { type: 'text', text: 'b', marks: [{ type: 'italic' }] },
              ],
            },
          ],
        },
        { type: 'horizontalRule' },
      ],
    };
    expect(yDocToJSON(jsonToYDoc(nested))).toEqual(canonicalJSON(nested));
  });

  it('seeds a blank page with nothing, so the first editor to open it is the only one to write its paragraph', () => {
    const doc = jsonToYDoc(EMPTY_DOC);
    expect(doc.getXmlFragment('content').length).toBe(0);
    expect(yDocToJSON(doc)).toEqual(canonicalJSON(EMPTY_DOC));
    expect(isBlankDoc(EMPTY_DOC)).toBe(true);
    expect(isBlankDoc(para('x'))).toBe(false);
    expect(
      isBlankDoc({ type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph' }] }),
    ).toBe(false);
  });

  it('builds the same state every time, so two servers racing to create it agree', () => {
    const a = Y.encodeStateAsUpdate(jsonToYDoc(richDoc()));
    const b = Y.encodeStateAsUpdate(jsonToYDoc(richDoc()));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(jsonToYDoc(richDoc()).clientID).toBe(SEED_CLIENT_ID);
  });
});

describe('collabColor', () => {
  it('is a stable six-digit colour per person, and different people mostly differ', () => {
    const ids = Array.from(
      { length: 40 },
      (_, i) => `0192f0a4-7c1e-7b3a-9d2e-${String(i).padStart(12, '0')}`,
    );
    const colours = ids.map((id) => collabColor(id));
    expect(colours.every((c) => COLLAB_COLOR.test(c))).toBe(true);
    expect(colours).toEqual(ids.map((id) => collabColor(id)));
    expect(new Set(colours).size).toBeGreaterThan(25);
    // dark enough for white text: relative luminance well under 0.4
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    expect(Math.max(...colours.map(lum))).toBeLessThan(0.2);
  });
});

describe('applyJSON', () => {
  it('turns the document into the new one as a diff that other editors keep their own changes through', () => {
    const server = jsonToYDoc(para('one', 'two', 'three'));
    const alice = new Y.Doc();
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(server));
    // Alice types at the end of the first paragraph while an old client saves a version that changed the last one.
    const aliceFragment = alice.getXmlFragment('content');
    (aliceFragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    ((aliceFragment.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(3, ' (alice)');
    expect(applyJSON(server, para('one', 'two', 'THREE'))).toBe(true);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(alice));
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(server));
    const texts = (d: Y.Doc) => (yDocToJSON(d).content ?? []).map((p) => p.content?.[0]?.text);
    expect(texts(server)).toEqual(['one (alice)', 'two', 'THREE']);
    expect(texts(alice)).toEqual(texts(server));
  });

  it('reports no change when the document already reads like that', () => {
    const doc = jsonToYDoc(richDoc());
    expect(applyJSON(doc, richDoc())).toBe(false);
  });
});

describe('two editors converge', () => {
  // A small deterministic generator, so a failure can be replayed from its seed.
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  it('ends with identical documents after random concurrent edits (250 runs)', () => {
    for (let run = 0; run < 250; run++) {
      const rand = rng(run + 1);
      const base = jsonToYDoc(para('alpha', 'beta', 'gamma'));
      const state = Y.encodeStateAsUpdate(base);
      const a = new Y.Doc();
      const b = new Y.Doc();
      Y.applyUpdate(a, state);
      Y.applyUpdate(b, state);
      const edit = (doc: Y.Doc) => {
        const f = doc.getXmlFragment('content');
        const n = f.length;
        const roll = rand();
        if (roll < 0.6 && n > 0) {
          const p = f.get(Math.floor(rand() * n)) as Y.XmlElement;
          const t = p.get(0) as Y.XmlText | undefined;
          if (t)
            t.insert(
              Math.floor(rand() * (t.length + 1)),
              String.fromCharCode(97 + Math.floor(rand() * 26)),
            );
        } else if (roll < 0.8) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'new');
          p.insert(0, [t]);
          f.insert(Math.floor(rand() * (n + 1)), [p]);
        } else if (n > 1) {
          f.delete(Math.floor(rand() * n), 1);
        }
      };
      const sync = () => {
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
      };
      for (let round = 0; round < 4; round++) {
        for (let i = 0; i < 1 + Math.floor(rand() * 5); i++) edit(rand() < 0.5 ? a : b);
        if (rand() < 0.5) sync();
      }
      sync();
      expect(yDocToJSON(a), `run ${run}`).toEqual(yDocToJSON(b));
    }
  });
});
