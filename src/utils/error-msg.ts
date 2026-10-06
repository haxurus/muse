import {DEFAULT_LOCALE, localizeError, t, type Locale} from '../i18n/index.js';

export default (error?: string | Error, locale: Locale = DEFAULT_LOCALE): string => {
  let str = t(locale, 'unknownError');

  if (error) {
    if (typeof error === 'string') {
      str = t(locale, 'errorPrefix', {message: error});
    } else if (error instanceof Error) {
      str = t(locale, 'errorPrefix', {message: localizeError(locale, error)});
    }
  }

  return str;
};
