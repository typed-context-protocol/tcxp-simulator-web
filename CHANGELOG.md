# Changelog

## 0.1.0 (2026-10-05)

First release, as two matching packages built from the same commit:
- npm: [`@tcxp/tcxp`](https://www.npmjs.com/package/@tcxp/tcxp). npm refused the unscoped name `tcxp` as too similar to existing packages.
- PyPI: [`tcxp`](https://pypi.org/project/tcxp/)

Both are licensed Apache-2.0.

### Note: the `v0.1.0` tag moved
The tag first pointed to `112addd9a11dc3be22056da4db7f4238d1511eb8`. It now points to `06685efeae86c09e516aca1688889fbe1fdff70d`, the merge of #3.

- **What changed:** only the release workflow's test-vector freshness check, in `python/tools/export_vectors.mjs` and `python/vectors/semantics.json`. The check depended on the machine's timezone and on gzip's compressed bytes, which differ by CPU, so it failed in CI on `112addd`.
- **What didn't change:** `tcxp.js`, the npm package and the Python package.
- **npm tarball:** `@tcxp/tcxp@0.1.0` on npm was published from `112addd`. Packing it from `06685ef` gives a byte-identical tarball, sha1 `a5ddd155c3f47a80e41c6edc09b10aafd491a51d`.
