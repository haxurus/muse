# Upstream synchronization

The fork uses two long-lived branches with different purposes.

## master

`master` should stay as close as possible to:

```text
museofficial/muse:master
```

Do not add Haxurus production-only changes to `master`.

## main

`main` contains the production hardening, deployment pipeline and Haxurus-specific changes.

## Updating from upstream

On a trusted development machine:

```bash
git remote add upstream https://github.com/museofficial/muse.git
git fetch upstream
git checkout master
git merge --ff-only upstream/master
git push origin master

git checkout main
git merge master
```

Resolve conflicts on `main`, run the full test/build suite, then push through a reviewed pull request whenever possible.

Important areas to review after upstream changes:

- `Dockerfile`;
- `src/services/config.ts`;
- `src/services/get-songs.ts`;
- `src/bot.ts`;
- `src/index.ts`;
- `deploy/`;
- `ops/`;
- `security/`;
- `.github/workflows/`.

Never copy upstream publishing workflows back into `main` without review because upstream registry names and infrastructure are different.
