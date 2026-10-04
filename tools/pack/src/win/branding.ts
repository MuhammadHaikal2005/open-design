import { readFile, writeFile } from 'node:fs/promises';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';
import { PRODUCT_NAME } from './constants.js';

/** Edit resources locally before the existing packaging/signing stage. Avoid the
 * winCodeSign archive's macOS symlinks, which require privileges on Windows. */
export const WIN_EXECUTABLE_BRANDING = {
  signAndEditExecutable: false,
  resourceEditor: 'resedit-v1',
  iconResourceName: 'app-icon.ico',
} as const;

export function winBrandingConfig(iconPath: string) {
  return {
    win: { icon: iconPath, signAndEditExecutable: WIN_EXECUTABLE_BRANDING.signAndEditExecutable },
    extraResources: [{ from: iconPath, to: WIN_EXECUTABLE_BRANDING.iconResourceName }],
  };
}

export async function brandWinExecutable(executablePath: string, iconPath: string): Promise<void> {
  // Cache contents are unsigned; signed installers apply signing afterwards.
  const executable = NtExecutable.from(await readFile(executablePath), { ignoreCert: true });
  const resource = NtExecutableResource.from(executable);
  const icons = Data.IconFile.from(await readFile(iconPath)).icons.map((item) => item.data);
  if (icons.length === 0) throw new Error('Windows branding icon contains no images');
  const groups = Resource.IconGroupEntry.fromEntries(resource.entries);
  for (const group of groups.length ? groups : [{ id: 1, lang: 1033 }]) {
    Resource.IconGroupEntry.replaceIconsForResource(resource.entries, group.id, group.lang, icons);
  }
  const versions = Resource.VersionInfo.fromEntries(resource.entries);
  for (const version of versions.length ? versions : [Resource.VersionInfo.createEmpty()]) {
    const translations = version.getAllLanguagesForStringValues();
    for (const translation of translations.length ? translations : [{ lang: 1033, codepage: 1200 }]) {
      version.setStringValues(translation, {
        ...version.getStringValues(translation),
        ProductName: PRODUCT_NAME, FileDescription: PRODUCT_NAME,
        InternalName: PRODUCT_NAME, OriginalFilename: `${PRODUCT_NAME}.exe`,
      });
    }
    version.outputToResourceEntries(resource.entries);
  }
  resource.outputResource(executable);
  await writeFile(executablePath, Buffer.from(executable.generate()));
  await assertWinExecutableBranding(executablePath, iconPath);
}

export async function assertWinExecutableBranding(executablePath: string, iconPath: string): Promise<void> {
  const resource = NtExecutableResource.from(NtExecutable.from(await readFile(executablePath), { ignoreCert: true }));
  const iconBytes = (icon: Data.IconItem | Data.RawIconItem) => Buffer.from(icon.isRaw() ? icon.bin : icon.generate());
  const expected = Data.IconFile.from(await readFile(iconPath)).icons.map((item) => iconBytes(item.data));
  const groups = Resource.IconGroupEntry.fromEntries(resource.entries);
  if (!groups.length || !expected.length || groups.some((group) => {
    const actual = group.getIconItemsFromEntries(resource.entries).map(iconBytes);
    return actual.length !== expected.length || actual.some((value, index) => !value.equals(expected[index]!));
  })) throw new Error('Windows executable icon does not match the packaged branding asset');
  const versions = Resource.VersionInfo.fromEntries(resource.entries);
  if (!versions.length || versions.some((version) => {
    const translations = version.getAllLanguagesForStringValues();
    return !translations.length || translations.some((translation) => {
      const values = version.getStringValues(translation);
      return values.ProductName !== PRODUCT_NAME || values.FileDescription !== PRODUCT_NAME;
    });
  })) throw new Error('Windows executable is missing OpenDesign product branding');
}
