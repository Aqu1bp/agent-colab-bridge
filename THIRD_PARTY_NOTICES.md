# Third-Party Notices

This repository is licensed under MIT. Runtime and development dependencies are
installed from `package-lock.json` and are not vendored in the source repository.

The current npm dependency tree is primarily MIT, Apache-2.0, ISC, 0BSD, and
CC0-1.0 licensed packages. Wrangler's development dependency tree can include
optional `@img/sharp-*` and `@img/sharp-libvips-*` packages with LGPL-related
license expressions. Do not publish `node_modules` or local package caches as
part of this repository or a release archive.

Before a public release, run:

```bash
npm audit --audit-level=low
npm pack --dry-run
```

Review the dry-run file list and confirm it does not include `node_modules`,
Python bytecode, local caches, local account data, or generated artifacts outside
the intended packaged plugin build output.
