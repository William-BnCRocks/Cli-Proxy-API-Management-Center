/**
 * Language isolation for tests.
 *
 * The i18n instance is a process-wide singleton and `bun test` runs every file
 * in one process, so a file that switches the language and does not switch it
 * back changes what every later file renders (and, with --randomize, every
 * earlier one too). Call `pinLanguage` at the top level of a test file: it
 * sets the language its assertions are written for before the file runs and
 * restores whatever was active afterwards.
 */

import { afterAll, beforeAll } from 'bun:test';
import i18n from '@/i18n';

export function pinLanguage(language: string): void {
  let previous: string | undefined;
  beforeAll(async () => {
    previous = i18n.language;
    await i18n.changeLanguage(language);
  });
  afterAll(async () => {
    if (previous !== undefined) await i18n.changeLanguage(previous);
  });
}
