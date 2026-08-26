import type { ScaffoldLanguage } from '../types.js';
import { XForgeError, diagnostic } from './errors.js';

function localeToken(value: string | undefined): string | null {
  if (!value) return null;
  const token = value.trim().split('.')[0]?.split('@')[0]?.replaceAll('_', '-');
  if (!token || /^(?:c|posix)$/i.test(token)) return null;
  return token;
}

function normalizeScaffoldLanguage(value: string | undefined): ScaffoldLanguage | null {
  const token = localeToken(value);
  if (!token) return null;
  if (/^zh(?:-|$)/i.test(token)) return 'zh-CN';
  if (/^en(?:-|$)/i.test(token)) return 'en';
  return null;
}

export function parseScaffoldLanguage(value: string): ScaffoldLanguage {
  const normalized = normalizeScaffoldLanguage(value);
  if (normalized) return normalized;
  throw new XForgeError(diagnostic(
    'XFORGE_LANGUAGE_UNKNOWN',
    `Unsupported Scaffold language: ${value}. Use en or zh-CN.`,
  ));
}

export function detectScaffoldLanguage(
  environment: NodeJS.ProcessEnv = process.env,
  resolvedLocale: string | undefined = Intl.DateTimeFormat().resolvedOptions().locale,
): ScaffoldLanguage | null {
  if (environment.XFORGE_LANGUAGE) return parseScaffoldLanguage(environment.XFORGE_LANGUAGE);
  let declaredLocale = false;
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const raw = environment[name];
    if (raw) declaredLocale = true;
    const token = localeToken(raw);
    if (!token) continue;
    return /^zh(?:-|$)/i.test(token) ? 'zh-CN' : 'en';
  }
  if (declaredLocale) return null;
  const token = localeToken(resolvedLocale);
  if (!token) return null;
  return /^zh(?:-|$)/i.test(token) ? 'zh-CN' : 'en';
}

export function localizedVariant(relative: string): string {
  const extension = relative.lastIndexOf('.');
  return extension < 0
    ? `${relative}_cn`
    : `${relative.slice(0, extension)}_cn${relative.slice(extension)}`;
}
