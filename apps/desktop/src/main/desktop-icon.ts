import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bundle locations vary; packaged icons are resources, not module-relative assets. */
export function findDesktopIconPath(options: {
  isPackaged: boolean;
  resourcesPath: string;
  moduleUrl: string;
  platform: NodeJS.Platform;
}): string | undefined {
  const candidates = options.isPackaged
    ? [
        ...(options.platform === 'win32' ? [join(options.resourcesPath, 'app-icon.ico')] : []),
        join(options.resourcesPath, 'open-design-web-standalone', 'apps', 'web', 'public', 'app-icon.png'),
        join(options.resourcesPath, 'app', 'node_modules', '@open-design', 'web', 'public', 'app-icon.png'),
      ]
    : [resolve(dirname(fileURLToPath(options.moduleUrl)), '../../../web/public/app-icon.png')];
  return candidates.find(existsSync);
}
