# Vendored faces

The landing page makes no external requests (ADR-132), so its three faces are
self-hosted here as the latin-subset variable woff2 builds Google Fonts served
for each family, fetched 2026-08-13. `styles.css` declares them with the
unicode-ranges they were served under.

## Provenance and license

All three are licensed under the SIL Open Font License 1.1, which permits
bundling and redistribution with attribution:

- Figtree, copyright Erik Kennedy
- Nunito Sans, copyright The Nunito Project
- JetBrains Mono, copyright JetBrains

The license text is at https://openfontlicense.org/open-font-license-official-text/.
