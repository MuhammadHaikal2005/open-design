import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { findDesktopIconPath } from '../../src/main/desktop-icon.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'od-icons-'));
  roots.push(root);
  return { root, resourcesPath: path.join(root, 'resources'), moduleUrl: pathToFileURL(path.join(root, 'resources/app/prebundled/packaged-main.mjs')).href };
}
function file(filename: string) { mkdirSync(path.dirname(filename), { recursive: true }); writeFileSync(filename, 'icon fixture'); return filename; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('uses a packaged Windows resource independently of bundle location', () => {
  const f = fixture();
  const icon = file(path.join(f.resourcesPath, 'app-icon.ico'));
  expect(findDesktopIconPath({ ...f, platform: 'win32', isPackaged: true })).toBe(icon);
});
it('supports existing standalone packages with their web icon', () => {
  const f = fixture();
  const icon = file(path.join(f.resourcesPath, 'open-design-web-standalone/apps/web/public/app-icon.png'));
  expect(findDesktopIconPath({ ...f, platform: 'win32', isPackaged: true })).toBe(icon);
});
it('retains the development icon location', () => {
  const f = fixture();
  const icon = file(path.join(f.root, 'apps/web/public/app-icon.png'));
  const moduleUrl = pathToFileURL(path.join(f.root, 'apps/desktop/dist/main/runtime.js')).href;
  expect(findDesktopIconPath({ ...f, moduleUrl, platform: 'win32', isPackaged: false })).toBe(icon);
});
it('returns no override rather than a nonexistent path', () => {
  expect(findDesktopIconPath({ ...fixture(), platform: 'win32', isPackaged: true })).toBeUndefined();
});
it('does not use a Windows ICO as the macOS dock icon', () => {
  const f = fixture(); file(path.join(f.resourcesPath, 'app-icon.ico'));
  expect(findDesktopIconPath({ ...f, platform: 'darwin', isPackaged: true })).toBeUndefined();
});
