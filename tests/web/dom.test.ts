import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

let h: any, fill: any, patch: any;

beforeAll(async () => {
  GlobalRegistrator.register();
  // @ts-expect-error — plain browser ES module, no type declarations
  ({ h, fill, patch } = await import('../../src/web/dom.js'));
});

afterAll(() => GlobalRegistrator.unregister());

describe('patch', () => {
  test('keeps the existing button, so a press that spans a refresh still clicks', () => {
    const calls: string[] = [];
    const box = document.createElement('div');
    fill(box, h('button', { type: 'button', onclick: () => calls.push('old') }, 'Old'));
    const pressed = box.firstChild as HTMLButtonElement;

    patch(box, h('button', { type: 'button', onclick: () => calls.push('new') }, 'New'));

    expect(box.firstChild).toBe(pressed);
    expect(pressed.textContent).toBe('New');
    pressed.click();
    expect(calls).toEqual(['new']);
  });

  test('syncs attributes and drops handlers the new markup no longer has', () => {
    let clicks = 0;
    const box = document.createElement('div');
    fill(box, h('button', { 'aria-current': 'page', class: 'a', onclick: () => clicks++ }, 'x'));
    const btn = box.firstChild as HTMLButtonElement;

    patch(box, h('button', { class: 'b', disabled: true }, 'x'));

    expect(btn.hasAttribute('aria-current')).toBe(false);
    expect(btn.className).toBe('b');
    expect(btn.disabled).toBe(true);
    btn.removeAttribute('disabled');
    btn.click();
    expect(clicks).toBe(0);
  });

  test('replaces nodes of another kind, adds new ones and removes extras', () => {
    const box = document.createElement('ul');
    fill(box, h('li', {}, 'a'), h('li', {}, 'b'), h('li', {}, 'c'));
    const first = box.firstChild;

    patch(box, h('li', {}, 'A'), h('div', {}, 'B'));
    expect(box.childNodes.length).toBe(2);
    expect(box.firstChild).toBe(first);
    expect((box.childNodes[1] as Element).tagName).toBe('DIV');
    expect(box.textContent).toBe('AB');

    patch(box, h('li', {}, '1'), h('div', {}, '2'), h('li', {}, '3'), null, false);
    expect(box.textContent).toBe('123');
  });

  test('updates nested text and icons in place', () => {
    const box = document.createElement('div');
    fill(box, h('span', { class: 'up' }, h('b', {}, 'icon'), '5s'));
    const span = box.firstChild as Element;
    const text = span.lastChild;

    patch(box, h('span', { class: 'up' }, h('b', {}, 'icon'), '6s'));
    expect(box.firstChild).toBe(span);
    expect(span.lastChild).toBe(text);
    expect(span.textContent).toBe('icon6s');
  });
});
