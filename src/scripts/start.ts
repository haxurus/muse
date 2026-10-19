// This script is mainly used during development.
// Starts Muse without applying database migrations.
import {startBot} from '../index.js';
import logBanner from '../utils/log-banner.js';
import {installLogCapture} from '../utils/log-buffer.js';

installLogCapture();

(async () => {
  logBanner();
  await startBot();
})();
