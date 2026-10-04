import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';
import { hashJson } from '@/cache/index.js';
import { WIN_EXECUTABLE_BRANDING, assertWinExecutableBranding, brandWinExecutable, winBrandingConfig } from '@/win/branding.js';
import { winResources } from '@/resources/index.js';
import source from '@/win/builder.ts?raw';

describe('Windows executable branding', () => {
  it('edits executable resources even for an unsigned build and carries a window icon', () => {
    expect(winBrandingConfig('test/icon.ico')).toEqual({
      win: { icon: 'test/icon.ico', signAndEditExecutable: false },
      extraResources: [{ from: 'test/icon.ico', to: 'app-icon.ico' }],
    });
  });
  it('includes the branding policy in the builder cache key', () => {
    expect(source).toContain('branding: WIN_EXECUTABLE_BRANDING');
    const original = hashJson(WIN_EXECUTABLE_BRANDING);
    expect(hashJson({ ...WIN_EXECUTABLE_BRANDING, signAndEditExecutable: true })).not.toBe(original);
    expect(hashJson({ ...WIN_EXECUTABLE_BRANDING, resourceEditor: 'another-editor' })).not.toBe(original);
    expect(hashJson({ ...WIN_EXECUTABLE_BRANDING, iconResourceName: 'different.ico' })).not.toBe(original);
    // Output-directory locations do not enter the policy identity.
    winBrandingConfig('another/build/icon.ico');
    expect(hashJson(WIN_EXECUTABLE_BRANDING)).toBe(original);
  });
  it('writes and verifies real PE icon resources while preserving executable content and unrelated resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'od-branding-'));
    const exePath = join(root, 'Open Design.exe');
    try {
      const exe = NtExecutable.createEmpty(false, false);
      const resource = NtExecutableResource.from(exe);
      const version = Resource.VersionInfo.createEmpty();
      version.setFileVersion('0.22.1.0', 1033);
      version.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: 'Electron', FileDescription: 'Electron', Comments: 'preserve this' });
      version.outputToResourceEntries(resource.entries);
      resource.entries.push({ type: 24, id: 1, lang: 1033, codepage: 0, bin: Uint8Array.from([1, 2, 3, 4]).buffer });
      resource.outputResource(exe);
      await writeFile(exePath, Buffer.from(exe.generate()));
      await expect(assertWinExecutableBranding(exePath, winResources.icon)).rejects.toThrow(/icon/);
      await brandWinExecutable(exePath, winResources.icon);
      await expect(assertWinExecutableBranding(exePath, winResources.icon)).resolves.toBeUndefined();
      const branded = NtExecutableResource.from(NtExecutable.from(await readFile(exePath)));
      expect(Resource.VersionInfo.fromEntries(branded.entries)[0]!.getStringValues({ lang: 1033, codepage: 1200 })).toMatchObject({ ProductName: 'Open Design', Comments: 'preserve this', FileVersion: '0.22.1.0' });
      expect(Buffer.from(branded.entries.find((entry) => entry.type === 24)!.bin)).toEqual(Buffer.from([1, 2, 3, 4]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
