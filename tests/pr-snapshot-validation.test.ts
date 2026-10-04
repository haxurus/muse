import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

describe('production publishing boundary', () => {
  it('gates image publication on validation and deploys immutable digests over strict SSH', async () => {
    const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');

    expect(workflow).toContain('validate:');
    expect(workflow).toContain('needs: validate');
    expect(workflow).toContain('yarn lint');
    expect(workflow).toContain('yarn typecheck');
    expect(workflow).toContain('yarn test');
    expect(workflow).toContain('IMAGE_DIGEST: ${{ needs.build.outputs.digest }}');
    expect(workflow).toContain('ghcr.io/haxurus/muse@${IMAGE_DIGEST}');
    expect(workflow).toContain('StrictHostKeyChecking=yes');
    expect(workflow).not.toContain('StrictHostKeyChecking=no');
  });
});
