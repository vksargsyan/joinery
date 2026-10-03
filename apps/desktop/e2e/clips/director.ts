import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Locator, type Page } from '@playwright/test';

import type { LaunchedApp } from '../app';
import {
  addConnection,
  connectProfile,
  launchForShots,
  type DemoProfile,
} from '../screenshots/harness';
import { profileItem, treeRow } from '../screenshots/nosql';

/**
 * The footage recorder for the Querybara videos (querybara-website/video). Each scene ("clip")
 * films the real app doing one thing against the Larchwood demo databases, at 1920×1080 in the
 * dark theme, paced for a viewer: a drawn mouse pointer that glides to what it clicks and shows
 * each click, typing at a human speed, and a pause after every step that shows something.
 *
 * A scene gets the app ready first (connections added and connected, the tree opened), and only
 * then starts the screencast, so the footage opens on the connection rather than on setup. Next
 * to `<clip>.webm` it writes `<clip>.beats.json`: `{ t, beat }` for each moment that became
 * visible, in seconds from the start of the video, for the voice-over and captions.
 *
 * It films with Playwright's screencast (`page.screencast.start`) rather than `recordVideo` at
 * launch, which would start with the window and film the setup as well.
 *
 * QUERYBARA_E2E_CLIPS names the output folder; without it the scenes run but nothing is saved.
 */

export const CLIPS = process.env['QUERYBARA_E2E_CLIPS'];

export const WIDTH = 1920;
export const HEIGHT = 1080;

/** The pause after a step, long enough to read what it showed. */
const READ_MS = 900;

interface Beat {
  readonly t: number;
  readonly beat: string;
}

/**
 * Draws a mouse pointer that follows the real (synthetic) pointer events and a ripple on each
 * press: a headless screencast has no cursor. Runs in the page; idempotent. Elements are built
 * with the DOM and styled through CSSOM, which the app's content security policy allows.
 */
function installPointer(): void {
  const w = window as unknown as { __clipRipple?: (x: number, y: number) => void };
  if (w.__clipRipple) return;
  const svgNs = 'http://www.w3.org/2000/svg';
  const layer = document.createElement('div');
  Object.assign(layer.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    pointerEvents: 'none',
    overflow: 'hidden',
  });
  const pointer = document.createElementNS(svgNs, 'svg');
  pointer.setAttribute('width', '30');
  pointer.setAttribute('height', '30');
  pointer.setAttribute('viewBox', '0 0 30 30');
  const arrow = document.createElementNS(svgNs, 'path');
  arrow.setAttribute('d', 'M3 2 L3 23.5 L8.6 18.4 L12.6 27.2 L16.4 25.6 L12.5 16.9 L20 16.9 Z');
  arrow.setAttribute('fill', '#FEFDF8');
  arrow.setAttribute('stroke', '#2B1813');
  arrow.setAttribute('stroke-width', '1.7');
  arrow.setAttribute('stroke-linejoin', 'round');
  pointer.appendChild(arrow);
  Object.assign(pointer.style, {
    position: 'absolute',
    left: '-3px',
    top: '-2px',
    filter: 'drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5))',
    transform: 'translate(-100px, -100px)',
  });
  layer.appendChild(pointer);
  document.documentElement.appendChild(layer);

  const ripple = (x: number, y: number): void => {
    const ring = document.createElement('div');
    Object.assign(ring.style, {
      position: 'absolute',
      left: `${x - 22}px`,
      top: `${y - 22}px`,
      width: '44px',
      height: '44px',
      borderRadius: '50%',
      border: '3px solid #D1854C',
      background: 'rgba(209, 133, 76, 0.22)',
      boxSizing: 'border-box',
    });
    layer.insertBefore(ring, pointer);
    ring
      .animate(
        [
          { transform: 'scale(0.35)', opacity: 1 },
          { transform: 'scale(1.25)', opacity: 0 },
        ],
        { duration: 520, easing: 'ease-out' },
      )
      .finished.then(() => ring.remove())
      .catch(() => ring.remove());
  };
  w.__clipRipple = ripple;
  window.addEventListener(
    'mousemove',
    (event) => {
      pointer.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
    },
    true,
  );
  window.addEventListener('mousedown', (event) => ripple(event.clientX, event.clientY), true);
}

/** Shows key caps (e.g. ["Ctrl", "P"]) at the bottom of the window for a moment. Runs in the page. */
function showKeyCaps(keys: readonly string[]): void {
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed',
    left: '50%',
    bottom: '72px',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: '8px',
    zIndex: '2147483646',
    pointerEvents: 'none',
  });
  for (const key of keys) {
    const cap = document.createElement('span');
    cap.textContent = key;
    Object.assign(cap.style, {
      font: '600 26px/1 Inter, system-ui, sans-serif',
      color: '#FEFDF8',
      background: 'rgba(43, 24, 19, 0.92)',
      border: '2px solid #D1854C',
      borderRadius: '10px',
      padding: '12px 18px',
      boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
    });
    box.appendChild(cap);
  }
  document.documentElement.appendChild(box);
  box
    .animate(
      [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }],
      {
        duration: 1600,
      },
    )
    .finished.then(() => box.remove())
    .catch(() => box.remove());
}

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export interface ClipSetup {
  /** Demo connections to add, in this order. */
  readonly connections?: readonly DemoProfile[];
  /** Of those, the ones to connect (by name). */
  readonly connect?: readonly string[];
}

/**
 * One scene: the app launched and prepared, then filmed. `start` begins the video, `beat` marks
 * what just became visible, `finish` stops the video, writes the beats and closes the app.
 */
export class Clip {
  readonly page: Page;
  readonly launched: LaunchedApp;
  #id: string | undefined;
  #startedAt = 0;
  #beats: Beat[] = [];
  #x = WIDTH * 0.62;
  #y = HEIGHT * 0.58;

  private constructor(launched: LaunchedApp) {
    this.launched = launched;
    this.page = launched.page;
  }

  /** Launches the app at 1920×1080 in the dark theme with the demo connections ready. */
  static async open(setup: ClipSetup = {}): Promise<Clip> {
    const launched = await launchForShots({ width: WIDTH, height: HEIGHT, scale: 1 });
    const clip = new Clip(launched);
    for (const profile of setup.connections ?? []) await addConnection(clip.page, profile);
    for (const name of setup.connect ?? []) await connectProfile(clip.page, name);
    await clip.page.addInitScript(installPointer);
    await clip.page.evaluate(installPointer);
    return clip;
  }

  /** Starts filming: the pointer is placed, the window settles, the screencast begins. */
  async start(id: string): Promise<void> {
    await this.page.mouse.move(this.#x, this.#y);
    await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await this.page.waitForTimeout(400);
    this.#id = id;
    this.#beats = [];
    if (CLIPS) {
      mkdirSync(CLIPS, { recursive: true });
      for (const stale of ['webm', 'beats.json', 'failed.webm', 'failed.png']) {
        rmSync(join(CLIPS, `${id}.${stale}`), { force: true });
      }
      await this.page.screencast.start({
        path: join(CLIPS, `${id}.webm`),
        size: { width: WIDTH, height: HEIGHT },
        quality: 100,
      });
    }
    this.#startedAt = Date.now();
  }

  /** Marks what just became visible, at the current time of the video. */
  beat(text: string): void {
    const t = Math.round((Date.now() - this.#startedAt) / 100) / 10;
    this.#beats.push({ t, beat: text });
  }

  /** Lets the viewer read: holds the picture for `ms`. */
  async hold(ms = READ_MS): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /** Marks a beat, then holds so it can be read. */
  async show(text: string, ms = READ_MS): Promise<void> {
    this.beat(text);
    await this.hold(ms);
  }

  /** Stops filming, writes `<clip>.beats.json` and closes the app. */
  async finish(): Promise<void> {
    await this.hold(1200);
    if (CLIPS && this.#id) {
      await this.page.screencast.stop();
      writeFileSync(
        join(CLIPS, `${this.#id}.beats.json`),
        `${JSON.stringify(this.#beats, null, 2)}\n`,
      );
    }
    await this.close();
  }

  /**
   * After a failure: keeps what was filmed as `<clip>.failed.webm`, with a screenshot of the
   * last state as `<clip>.failed.png`, so the scene can be fixed; no beats file is written.
   */
  async abort(): Promise<void> {
    if (CLIPS && this.#id) {
      const base = join(CLIPS, this.#id);
      await this.page.screenshot({ path: `${base}.failed.png` }).catch(() => undefined);
      await this.page.screencast.stop().catch(() => undefined);
      if (existsSync(`${base}.webm`)) renameSync(`${base}.webm`, `${base}.failed.webm`);
    }
    await this.close();
  }

  /** Closes the app without saving. */
  async close(): Promise<void> {
    await this.launched.close().catch(() => undefined);
  }

  // ------------------------------------------------------------------------------------------
  // The pointer

  /** Glides the pointer to a point, easing in and out, about half a second for a long way. */
  async glide(x: number, y: number): Promise<void> {
    const distance = Math.hypot(x - this.#x, y - this.#y);
    const steps = Math.max(8, Math.min(36, Math.round(distance / 22)));
    const fromX = this.#x;
    const fromY = this.#y;
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps);
      await this.page.mouse.move(fromX + (x - fromX) * k, fromY + (y - fromY) * k);
      await this.page.waitForTimeout(14);
    }
    this.#x = x;
    this.#y = y;
  }

  /** Glides to the middle of an element (scrolled into view first), or to a point inside it. */
  async moveTo(
    target: Locator,
    position?: { readonly x: number; readonly y: number },
  ): Promise<void> {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`nothing to point at: ${target.toString()}`);
    await this.glide(
      box.x + (position ? position.x : box.width / 2),
      box.y + (position ? position.y : box.height / 2),
    );
  }

  async click(
    target: Locator,
    options: {
      readonly button?: 'left' | 'right';
      readonly position?: { readonly x: number; readonly y: number };
    } = {},
  ): Promise<void> {
    await this.moveTo(target, options.position);
    await this.hold(140);
    await target.click({
      ...(options.button ? { button: options.button } : {}),
      ...(options.position ? { position: options.position } : {}),
    });
  }

  /**
   * Scrolls with the wheel, a notch at a time, until `target`'s top sits in the upper part of
   * the window (the pointer must be over the scrolling area).
   */
  async scrollTo(target: Locator, top = HEIGHT * 0.22): Promise<void> {
    for (let i = 0; i < 80; i++) {
      const box = await target.boundingBox();
      if (!box) throw new Error(`nothing to scroll to: ${target.toString()}`);
      const delta = box.y - top;
      if (Math.abs(delta) < 30) break;
      await this.page.mouse.wheel(0, Math.sign(delta) * Math.min(Math.abs(delta), 90));
      await this.page.waitForTimeout(30);
    }
    await this.hold(300);
  }

  /** Clicks at a point of the window (a grid cell drawn on a canvas, say). */
  async clickAt(x: number, y: number): Promise<void> {
    await this.glide(x, y);
    await this.hold(140);
    await this.page.mouse.click(x, y);
  }

  /** Points at an element without clicking, so the viewer's eye follows. */
  async point(target: Locator, ms = 500): Promise<void> {
    await this.moveTo(target);
    await this.hold(ms);
  }

  /** Picks an option of a native select: the pointer goes there and clicks; the value is set. */
  async select(target: Locator, value: string | { readonly label: string }): Promise<void> {
    await this.moveTo(target);
    await this.hold(140);
    await this.page.evaluate(
      ([x, y]) =>
        (window as unknown as { __clipRipple?: (x: number, y: number) => void }).__clipRipple?.(
          x!,
          y!,
        ),
      [this.#x, this.#y],
    );
    await target.selectOption(value);
    await this.hold(250);
  }

  /** Ticks a checkbox with a click on it. */
  async check(target: Locator): Promise<void> {
    await this.moveTo(target);
    await this.hold(140);
    await target.check();
  }

  // ------------------------------------------------------------------------------------------
  // The keyboard

  /** Types at a human pace: 40–60 ms a key, the time the key press itself takes included. */
  async type(text: string): Promise<void> {
    for (const char of text) {
      const started = Date.now();
      if (char === '\n') await this.page.keyboard.press('Enter');
      else await this.page.keyboard.type(char);
      const rest = 40 + Math.round(Math.random() * 20) - (Date.now() - started);
      if (rest > 0) await this.page.waitForTimeout(rest);
    }
  }

  /** Clicks a text field, clears it and types into it. */
  async typeInto(target: Locator, text: string): Promise<void> {
    await this.click(target);
    await this.page.keyboard.press('ControlOrMeta+a');
    await this.page.keyboard.press('Delete');
    await this.type(text);
  }

  /**
   * Types code into a Monaco editor line by line. Before each new line the suggestion list is
   * dismissed (Enter would accept it; it can open a moment after the last key), and the lines
   * carry no indentation of their own, so the editor's auto-indent cannot double it.
   */
  async typeCode(text: string): Promise<void> {
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      await this.type(line);
      await this.dismissSuggestions();
      if (i < lines.length - 1) {
        await this.page.keyboard.press('Enter');
        await this.page.waitForTimeout(90);
      }
    }
  }

  /**
   * Enters code a line at a time, `gapMs` apart. For an editor whose text round-trips through
   * React state (the Elasticsearch SQL tab): keys at typing speed race its re-render, which
   * resets the text and the cursor while the screencast loads the machine.
   */
  async enterLines(text: string, gapMs = 650): Promise<void> {
    const lines = text.split('\n');
    for (const [i, line] of lines.entries()) {
      await this.page.keyboard.insertText(i < lines.length - 1 ? `${line}\n` : line);
      await this.page.waitForTimeout(gapMs);
    }
  }

  async dismissSuggestions(): Promise<void> {
    await this.page.waitForTimeout(250);
    await this.page.keyboard.press('Escape');
    await expect(this.page.locator('.monaco-editor .suggest-widget.visible')).toHaveCount(0);
  }

  /**
   * Presses a shortcut and shows it as key caps, since a video cannot show the keyboard. With
   * `global`, focus leaves any editor first (an editor keeps some shortcuts for itself).
   */
  async shortcut(
    keys: string,
    caps: readonly string[],
    options: { readonly global?: boolean } = {},
  ): Promise<void> {
    if (options.global) {
      await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }
    await this.page.evaluate(showKeyCaps, caps);
    await this.hold(220);
    await this.page.keyboard.press(keys);
  }
}

/** Runs a scene: films it, or on failure keeps what was filmed under a `.failed` name. */
export async function film(setup: ClipSetup, scene: (clip: Clip) => Promise<void>): Promise<void> {
  const clip = await Clip.open(setup);
  try {
    await scene(clip);
    await clip.finish();
  } catch (error) {
    await clip.abort();
    throw error;
  }
}

/** Expands a tree row by its chevron (a click on the row would also open it) to show `child`. */
export async function expand(row: Locator, child: Locator): Promise<void> {
  if (!(await child.isVisible())) await row.locator('[data-tree-chevron]').click();
  await expect(child).toBeVisible();
}

/** Opens larchwood › shop › Tables in the explorer of a connected profile. */
export async function openShopTables(page: Page, profile: string): Promise<void> {
  const item = profileItem(page, profile);
  const row = (text: string) => treeRow(page, text, item);
  await expand(row('larchwood'), row('shop'));
  await expand(row('shop'), row('Tables'));
  await expand(row('Tables'), row('order_items'));
}

/** The next native open or save dialog answers with `path`. */
export async function stubFileDialog(
  launched: LaunchedApp,
  kind: 'open' | 'save',
  path: string,
): Promise<void> {
  await launched.app.evaluate(
    ({ dialog }, [which, file]) => {
      if (which === 'open') {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
      } else {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
      }
    },
    [kind, path] as const,
  );
}
