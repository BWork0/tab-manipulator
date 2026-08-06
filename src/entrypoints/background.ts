import {
  createDefaultBackgroundApplication,
  type BackgroundApplication,
} from '@/background/create-app';

let application: BackgroundApplication | undefined;

export function startBackground(): void {
  application ??= createDefaultBackgroundApplication();
  application.start();
}

export default defineBackground(startBackground);
